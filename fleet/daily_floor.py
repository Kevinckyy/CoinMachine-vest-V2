"""Daily equity floor at 20:00 New York, in account USD."""
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_UP
import json

from .protocol import number
from .trading_day import entry_day_window


CENT = Decimal("0.01")
OPEN_POLICY_VERSION = 4


def decimal(value):
    return Decimal(str(value))


def cents(value):
    return float(value.quantize(CENT,rounding=ROUND_HALF_UP))


def schema(db):
    db.execute("""CREATE INDEX IF NOT EXISTS floor_debits ON book(worker,account,kind,at)
               WHERE kind='withdrawal' OR kind='payout'""")
    db.execute("""CREATE TABLE IF NOT EXISTS daily_floors(worker TEXT,account TEXT,start REAL,
               reset_equity REAL, allowance REAL, platform_floor REAL, platform_at REAL, source TEXT,
               PRIMARY KEY(worker,account,start))""")


def capture(db, worker, account, at, allowance=None, reset=None, platform=None):
    if allowance is None and reset is None and platform is None:
        return
    start = entry_day_window(at)["start"]
    old = db.execute("SELECT * FROM daily_floors WHERE worker=? AND account=? AND start=?",(worker,account,start)).fetchone()
    if allowance is not None:
        allowance = number(allowance,"每日亏损额度",0,1e12)
    if reset is not None:
        reset = number(reset,"美东 20:00 账户价值",0,1e12)
    if platform is not None:
        platform = number(platform,"平台当日爆仓线",0,1e12)
    if old and platform is None and reset is None and allowance == old["allowance"]:
        return
    if reset is None and old:
        reset = old["reset_equity"]
    if allowance is None:
        allowance = old["allowance"] if old else None
    platform_at = old["platform_at"] if old else None
    if platform is not None and (platform_at is None or at >= platform_at):
        platform_at = at
    else:
        platform = old["platform_floor"] if old else None
    source = "platform" if platform is not None else "pending"
    db.execute("INSERT OR REPLACE INTO daily_floors VALUES(?,?,?,?,?,?,?,?)",
               (worker,account,start,reset,allowance,platform,platform_at,source))


def confirmed_debits(db, worker, account, start, end):
    receipts, payouts = [], []
    for r in db.execute("""SELECT data FROM book WHERE worker=? AND account=? AND phase='live'
                        AND kind='payout' AND at>=? AND at<?""",(worker,account,start,end)):
        data = json.loads(r[0])
        if data.get("status")=="completed" and data.get("gross_amount") and data.get("executed_at"):
            payouts.append((decimal(data["gross_amount"]),data["created_at"],data["executed_at"]))
    earliest = min([start]+[created-60 for _,created,_ in payouts])
    for r in db.execute("""SELECT b.data,c.intents FROM book b LEFT JOIN commands c ON c.id=b.ref
                        WHERE b.worker=? AND b.account=? AND b.phase='live' AND b.kind='withdrawal'
                        AND b.at>=? AND b.at<?""",(worker,account,earliest,end)):
        data = json.loads(r["data"])
        intent = json.loads(r["intents"] or "{}").get("withdraw",{})
        receipts.append((decimal(data["amount"]),intent.get("time",data["verified_at"]),data["verified_at"]))
    # The native request time is displayed with up to one minute of rounding.
    # Match at most one native row to each verified receipt, even if amounts repeat.
    debits = [(amount,verified) for amount,submitted,verified in receipts if verified>=start]
    for amount,created,executed in sorted(payouts,key=lambda payout:payout[1]):
        matches = [(abs(created-submitted),i) for i,(gross,submitted,verified) in enumerate(receipts)
                   if gross==amount and submitted-60<=created<=verified+1]
        if matches:
            receipts.pop(min(matches)[1])
        else:
            debits.append((amount,executed))
    return debits


def view(db, worker, account, now):
    window = entry_day_window(now)
    start,end = window["start"],window["end"]
    row = db.execute("SELECT * FROM daily_floors WHERE worker=? AND account=? AND start=?",(worker,account,start)).fetchone()
    if not row:
        return None
    debits = confirmed_debits(db,worker,account,start,end)
    gross = sum((value for value,_ in debits),Decimal(0))
    at = row["platform_at"]
    verified = at is not None and row["platform_floor"] is not None and all(when <= at for _,when in debits)
    return {"start":start,"end":end,"reset_equity":row["reset_equity"],"daily_limit":row["allowance"],"gross_withdrawn":float(gross),
            "floor":row["platform_floor"] if verified else None,"observed_at":at,
            "source":"platform" if verified else "pending","verified":verified}


def stop_decision(risk, floor, params):
    """Either exemption can omit the stop. Otherwise both loss allowances constrain it."""
    equity, used, limit = (risk.get(k) for k in ("equity", "drawdown", "drawdown_limit"))
    daily = decimal(equity) - decimal(floor["floor"]) if equity is not None and floor and floor["verified"] else None
    total = decimal(limit) - abs(decimal(used)) if used is not None and limit is not None else None
    maximum_floor = risk.get("max_drawdown_floor")
    gap = decimal(floor["floor"]) - decimal(maximum_floor) if daily is not None and maximum_floor is not None else None
    gap_limit = params.get("omit_floor_gap_below")
    threshold = params.get("omit_stop_below")
    max_distance = decimal(equity) - decimal(maximum_floor) if equity is not None and maximum_floor is not None else None
    ready = (gap_limit is None and threshold is None) or max_distance is not None and gap is not None
    omit = (ready and max_distance is not None and max_distance > 0 and
            total is not None and total > 0 and daily is not None and daily > 0 and
            ((gap_limit is not None and gap < decimal(gap_limit)) or
             (threshold is not None and max_distance < decimal(threshold))))
    amount = None
    if ready and daily is not None and total is not None and not omit:
        amount = (min(daily, total) - decimal(params.get("stop_buffer", 20))).quantize(CENT, rounding=ROUND_FLOOR)
    return {"remaining_drawdown":float(daily) if daily is not None else None,
            "floor_gap":float(gap) if gap is not None else None,
            "distance_to_max_floor":float(max_distance) if max_distance is not None else None,
            "remaining_max_drawdown":float(total) if total is not None else None,
            "stop_loss":float(amount) if amount is not None else None, "stop_omitted":omit}


def take_profit(params, risk_amount):
    if "reward_ratio" not in params:
        return params.get("take_profit")
    minimum = decimal(params.get("min_take_profit",0)).quantize(CENT,rounding=ROUND_CEILING)
    return max(float(minimum), cents(decimal(risk_amount)*decimal(params["reward_ratio"])))
