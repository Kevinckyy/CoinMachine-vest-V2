"""Account-directory observations and the trade-page risk values used for selection."""
import json
from .protocol import PHASES, PRIMARY, boolean, choice, dump, fields, number, obj, require, string
from . import daily_floor, ledger
from .trading_day import entry_day_window


AMOUNTS = ("equity", "health", "daily_loss", "daily_limit", "drawdown", "drawdown_limit")
NUMBERS = (*AMOUNTS, "pnl", "pnl_percent")


def schema(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS card_sync(worker TEXT PRIMARY KEY, session TEXT NOT NULL, generation INTEGER NOT NULL,
            full_at REAL NOT NULL, seen REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS card_request(slot INTEGER PRIMARY KEY CHECK(slot=1), generation INTEGER NOT NULL);
        INSERT OR IGNORE INTO card_request VALUES(1,0);
        CREATE TABLE IF NOT EXISTS open_preflight(id TEXT PRIMARY KEY,session TEXT NOT NULL,checked REAL NOT NULL);
    """)
    cols = {r[1] for r in db.execute("PRAGMA table_info(accounts)")}
    for name, spec in (("card","TEXT"), ("card_at","REAL"), ("risk","TEXT"), ("risk_at","REAL"), ("preflight_at","REAL"), ("history_due_at","REAL")):
        if name not in cols:
            db.execute(f"ALTER TABLE accounts ADD COLUMN {name} {spec}")


def from_trade(snap):
    metrics = obj(snap.get("capital_metrics",{}))
    result = {"equity":snap.get("equity"), "health":snap.get("account_health"), "position_open":snap.get("position_open")}
    for key, limit in (("daily_loss","daily_limit"),("drawdown","drawdown_limit")):
        metric = obj(metrics.get(key) or {})
        result[key], result[limit] = metric.get("current"), metric.get("limit")
    result["daily_unlimited"] = snap.get("daily_unlimited") is True
    for key in AMOUNTS:
        if result[key] is not None:
            result[key] = round(number(result[key],key,-1e12,1e12),2)
    return result


def risk_error(risk, complete=False):
    if risk.get("position_open") is not False:
        return "尚未确认空仓"
    if complete:
        required = ["health","equity","drawdown","drawdown_limit"]
        if not risk.get("daily_unlimited"):
            required += ["daily_loss","daily_limit"]
        if any(risk.get(key) is None for key in required):
            return "交易页风控字段未读全"
    if risk.get("health") is not None and risk["health"] < 25:
        return "账户健康度低于 25%"
    if risk.get("equity") is not None and risk["equity"] <= 0:
        return "净值不足"
    for key, limit in (("daily_loss","daily_limit"),("drawdown","drawdown_limit")):
        if risk.get(key) is not None and risk.get(limit) is not None and risk[key] >= risk[limit]:
            return "账户已触及亏损限额"
    return ""


def read_item(raw):
    fields(raw, ("name","id","category","phase","active_positions",*NUMBERS))
    entry = {"name":string(raw.get("name"),"账户名"), "id":string(raw.get("id",""),"卡片标识",160,True),
             "category":choice(raw.get("category"),{"default","eval","funded","live","active","passed","failed","closed"},"卡片类别"),
             "phase":raw.get("phase"), "active_positions":raw.get("active_positions")}
    require(entry["phase"] is None or entry["phase"] in PHASES,"未知账户阶段")
    if entry["active_positions"] is not None:
        number(entry["active_positions"],"活动持仓数",0,100000,True)
    for key in NUMBERS:
        value = raw.get(key)
        entry[key] = None if value is None else round(number(value,key,-1e12,1e12),2)
    return entry


def update(db, wid, sid, data, now):
    data = obj(data)
    gen = number(data.get("generation"),"刷新批次",0,2**53-1,True)
    requested = db.execute("SELECT generation FROM card_request").fetchone()[0]
    require(gen == requested, "有更新的账户刷新请求",409)
    observed = number(data.get("observed_at"), "卡片读取时间", now-120,now+10)
    full = boolean(data.get("full"))
    raw = data.get("items")
    require(isinstance(raw,list) and len(raw)<=500,"卡片清单无效")
    sync = db.execute("SELECT * FROM card_sync WHERE worker=?",(wid,)).fetchone()
    require(full or sync and sync["session"]==sid and sync["generation"]==gen,"需要先完成全量刷新",409)
    require(not sync or sync["session"]!=sid or observed>=sync["seen"],"过期的卡片读数",409)
    previous = {r["name"]:r for r in db.execute("SELECT * FROM accounts WHERE worker_id=?",(wid,))}
    items = {}
    duplicate = set()
    for raw_item in raw:
        item = read_item(raw_item)
        if item["name"] in items:
            duplicate.add(item["name"])
        items[item["name"]] = item
    for name,row in previous.items():
        if row["present"] and name not in items:
            db.execute("UPDATE accounts SET present=0,card=NULL,card_at=NULL,risk=NULL,risk_at=NULL,read_session=NULL WHERE worker_id=? AND name=?",(wid,name))
    for name,item in items.items():
        row = previous.get(name)
        prior = json.loads(row["card"]) if row and row["card"] else {}
        old_phase = prior.get("phase") if prior else row["phase"] if row else None
        same = bool(row and row["present"] and (not prior.get("id") or prior["id"]==item["id"]) and
                    (not item["phase"] or not old_phase or item["phase"]==old_phase))
        category = item["category"]
        if same and (category=="active" or row["risk_at"] and category==prior.get("category")):
            category = row["category"]
        phase = row["phase"] if same and row["phase"] and (not item["phase"] or row["risk_at"] and item["phase"]==old_phase) else item["phase"]
        risk = json.loads(row["risk"]) if same and row["risk"] else {}
        for key in AMOUNTS:
            if item[key] != prior.get(key) or key not in risk:
                risk[key] = item[key]
        count = item["active_positions"]
        was_open = risk.get("position_open") is True or (prior.get("active_positions") or 0)>0
        if not same or observed >= (row["observed_at"] or 0):
            risk["position_open"] = None if count is None else count > 0
            if same and name not in duplicate and count==0 and was_open:
                db.execute("UPDATE accounts SET history_due_at=?,tracked_position=NULL WHERE worker_id=? AND name=?",(observed,wid,name))
                tracked = json.loads(row["tracked_position"] or "null")
                if tracked and tracked["phase"]==phase:
                    node = db.execute("SELECT node_id FROM identity").fetchone()[0]
                    ledger.save(db,(node,wid,name),"position",tracked["id"],{"phase":phase,"close_seen":observed})
        excluded = category in PRIMARY or name.lower() in PRIMARY
        if row and not same:
            db.execute("DELETE FROM daily_floors WHERE worker=? AND account=? AND start=?",
                       (wid,name,entry_day_window(observed)["start"]))
        daily_floor.capture(db,wid,name,observed,item.get("daily_limit"))
        db.execute("""INSERT INTO accounts(worker_id,name,category,phase,present,ambiguous,excluded,listed_session,card,card_at,risk)
          VALUES(?,?,?,?,1,?,?,?,?,?,?) ON CONFLICT(worker_id,name) DO UPDATE SET category=excluded.category,
          phase=excluded.phase,present=1,ambiguous=excluded.ambiguous,excluded=MAX(accounts.excluded,excluded.excluded),
          listed_session=excluded.listed_session,card=excluded.card,card_at=excluded.card_at,risk=excluded.risk""",
          (wid,name,category,phase,name in duplicate,excluded,sid,dump(item),observed,dump(risk)))
        if not same or name in duplicate:
            db.execute("""UPDATE accounts SET snapshot='{}',observed_at=NULL,read_session=NULL,risk_at=NULL,read_error='',
                       preflight_at=NULL,history_due_at=NULL,tracked_position=NULL WHERE worker_id=? AND name=?""",(wid,name))
    db.execute("""INSERT INTO card_sync VALUES(?,?,?,?,?) ON CONFLICT(worker) DO UPDATE SET
                session=excluded.session,generation=excluded.generation,full_at=excluded.full_at,seen=excluded.seen""",
               (wid,sid,gen,observed if full else sync["full_at"],observed))
    return {"count":len(items),"generation":gen,"risks":{r["name"]:json.loads(r["risk"]) for r in
            db.execute("SELECT name,risk FROM accounts WHERE worker_id=? AND present=1",(wid,))}}
