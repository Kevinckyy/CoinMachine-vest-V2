"""Daily equity floor at 20:00 New York, in account USD."""
from decimal import Decimal, ROUND_FLOOR, ROUND_HALF_UP
import json

from .protocol import number
from .trading_day import entry_day_window


CENT = Decimal("0.01")
RATE = Decimal("0.03")


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
        reset = number(reset,"美东 20:00 账户价值",0.01,1e12)
    if platform is not None:
        platform = number(platform,"平台当日爆仓线",0,1e12)
    if old and reset is None and platform is None and allowance==old["allowance"]:
        return
    if old and reset is None and old["source"]!="estimate":
        reset = old["reset_equity"]
    if allowance is None:
        allowance = old["allowance"] if old else None
    if platform is None and old:
        platform = old["platform_floor"]
    if reset is not None:
        calculated = cents(decimal(reset)*RATE)
        source = "reset" if allowance is None or abs(calculated-allowance)<=0.011 else "conflict"
        allowance = calculated if allowance is None else allowance
    else:
        source = "platform" if platform is not None else "estimate"
    platform_at = (old["platform_at"] if old and old["platform_floor"]==platform else at) if platform is not None else None
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
    debits = [(amount,submitted) for amount,submitted,verified in receipts if verified>=start]
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
    reset = row["reset_equity"]
    if reset is None and row["allowance"] is not None and row["source"]=="estimate":
        reset = cents(decimal(row["allowance"])/RATE)
    floor = decimal(reset)*(1-RATE)-gross if reset is not None else None
    if row["platform_floor"] is not None:
        # An observed platform level includes debits already reflected at that point.
        later = sum((value for value,submitted in debits if submitted>row["platform_at"]),Decimal(0))
        floor = decimal(row["platform_floor"])-later
    return {"start":start,"end":end,"reset_equity":reset,"daily_limit":row["allowance"],"gross_withdrawn":float(gross),
            "floor":cents(floor) if floor is not None else None,"source":row["source"],
            "verified":row["source"] in ("reset","platform") and floor is not None}


def stop_amount(equity, floor, buffer):
    if not floor or not floor["verified"] or equity is None:
        return None
    return float((decimal(equity)-decimal(floor["floor"])-decimal(buffer)).quantize(CENT,rounding=ROUND_FLOOR))
