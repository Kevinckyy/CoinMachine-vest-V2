"""Account-directory observations and the trade-page risk values used for selection."""
import json
from .protocol import PHASES, PRIMARY, boolean, choice, dump, fields, number, obj, require, string
from . import daily_floor, ledger
from .trading_day import entry_day_window


AMOUNTS = ("equity", "health", "daily_loss", "daily_limit", "drawdown", "drawdown_limit")
NUMBERS = (*AMOUNTS, "pnl", "pnl_percent")
READ_FAILURES = {"交易页未确认当前平台账户身份或阶段", "交易页风控字段未读全", "交易页未确认空仓状态",
                 "交易页未读到本交易日的爆仓线", "交易页未读到已用回撤和最大回撤上限",
                 "交易页未读到最大回撤线，无法核对免止损条件", "交易页未确认可交易账户类别和阶段"}


def schema(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS card_sync(worker TEXT PRIMARY KEY, session TEXT NOT NULL, generation INTEGER NOT NULL,
            full_at REAL NOT NULL, seen REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS card_request(slot INTEGER PRIMARY KEY CHECK(slot=1), generation INTEGER NOT NULL);
        INSERT OR IGNORE INTO card_request VALUES(1,0);
        CREATE TABLE IF NOT EXISTS open_preflight(id TEXT PRIMARY KEY,session TEXT NOT NULL,checked REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS card_locks(worker TEXT,platform_id TEXT,lock TEXT NOT NULL, PRIMARY KEY(worker,platform_id));
    """)
    cols = {r[1] for r in db.execute("PRAGMA table_info(accounts)")}
    for name, spec in (("card","TEXT"), ("card_at","REAL"), ("risk","TEXT"), ("risk_at","REAL"), ("portfolio","TEXT"), ("preflight_at","REAL"), ("history_due_at","REAL"),
                       ("initial_balance","REAL"), ("baseline_phase","TEXT"), ("phase_started_at","REAL"), ("open_lock","TEXT")):
        if name not in cols:
            db.execute(f"ALTER TABLE accounts ADD COLUMN {name} {spec}")
    for reason in READ_FAILURES:
        db.execute("""UPDATE accounts SET open_lock=json_set(open_lock,'$.kind','read_retry','$.until',0)
                      WHERE json_extract(open_lock,'$.kind') IS NULL AND json_extract(open_lock,'$.reason')=?""",(reason,))
    if "source_at" not in {r[1] for r in db.execute("PRAGMA table_info(card_sync)")}:
        db.execute("ALTER TABLE card_sync ADD COLUMN source_at REAL")


def from_trade(snap):
    metrics = obj(snap.get("capital_metrics",{}))
    result = {"equity":snap.get("equity"), "health":snap.get("account_health"), "position_open":snap.get("position_open")}
    if snap.get("max_drawdown_floor") is not None:
        result["max_drawdown_floor"] = number(snap["max_drawdown_floor"],"交易页最大回撤线",0,1e12)
    for key, limit in (("daily_loss","daily_limit"),("drawdown","drawdown_limit")):
        metric = obj(metrics.get(key) or {})
        result[key], result[limit] = metric.get("current"), metric.get("limit")
    result["daily_unlimited"] = snap.get("daily_unlimited") is True
    for key in AMOUNTS:
        if result[key] is not None:
            result[key] = round(number(result[key],key,-1e12,1e12),2)
    return result


def risk_error(risk, complete=False):
    if risk.get("position_open") is True:
        return "尚未确认空仓"
    if risk.get("health") is not None and risk["health"] < 25:
        return "账户健康度低于 25%"
    if risk.get("equity") is not None and risk["equity"] <= 0:
        return "净值不足"
    for key, limit in (("daily_loss","daily_limit"),("drawdown","drawdown_limit")):
        if risk.get(key) is not None and risk.get(limit) is not None and risk[key] >= risk[limit]:
            return "账户已触及亏损限额"
    if risk.get("position_open") is not False:
        return "交易页未确认空仓状态"
    if complete:
        required = ["health","equity","drawdown","drawdown_limit"]
        if not risk.get("daily_unlimited"):
            required += ["daily_loss","daily_limit"]
        if any(risk.get(key) is None for key in required):
            return "交易页风控字段未读全"
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


MONITOR_FIELDS = ("active_positions", "pnl", "drawdown", "drawdown_limit", "daily_loss", "daily_limit")


def metric_items(previous, changes, directory, sid):
    """Expand numeric changes against the exact acknowledged list. An omitted row is never a removal."""
    patches = {}
    allowed = ("active_positions", *NUMBERS) if directory else MONITOR_FIELDS
    for patch in changes:
        fields(patch, ("name", *allowed))
        name = string(patch.get("name"), "账户名")
        row = previous.get(name)
        require(row and row["present"] and row["card"] and not row["ambiguous"] and row["listed_session"] == sid
                and name not in patches, "账户列表已变化，需要重新拉取", 409)
        patches[name] = patch
    items = {}
    for name, row in previous.items():
        if not row["present"] or row["ambiguous"] or row["listed_session"] != sid or not row["card"]:
            continue
        prior = json.loads(row["card"])
        if directory or prior["active_positions"] or name in patches:
            items[name] = read_item({**prior, **patches[name]}) if name in patches else prior
    return items


def update(db, wid, sid, data, now, *, metrics=False):
    data = obj(data)
    gen = number(data.get("generation"),"刷新批次",0,2**53-1,True)
    requested = db.execute("SELECT generation FROM card_request").fetchone()[0]
    require(gen == requested, "有更新的账户刷新请求",409)
    observed = number(data.get("observed_at"), "卡片读取时间", now-120,now+10)
    full = False if metrics else boolean(data.get("full"))
    raw = data.get("items")
    require(isinstance(raw,list) and len(raw)<=500,"卡片清单无效")
    sync = db.execute("SELECT * FROM card_sync WHERE worker=?",(wid,)).fetchone()
    source_at = data.get("source_at")
    if source_at is not None:
        number(source_at,"平台清单时间",now-335,observed+1)
        require(not sync or sync["session"]!=sid or source_at >= (sync["source_at"] or 0),"过期的平台账户清单",409)
    require(full or sync and sync["session"]==sid and sync["generation"]==gen,"需要先完成全量刷新",409)
    require(not sync or sync["session"]!=sid or observed>=sync["seen"],"过期的卡片读数",409)
    previous = {r["name"]:r for r in db.execute("SELECT * FROM accounts WHERE worker_id=?",(wid,))}
    duplicate = set()
    if metrics:
        fields(data, ("generation", "observed_at", "base_at", "directory", "items"))
        require(sync["seen"] == data.get("base_at") and observed > sync["seen"], "监控读数基线已变化", 409)
        directory = boolean(data.get("directory"))
        items = metric_items(previous, raw, directory, sid)
    else:
        items = {}
        ids = set()
        for raw_item in raw:
            item = read_item(raw_item)
            if source_at is not None:
                require(item["id"] and item["id"] not in ids,"平台账户标识缺失或重复",409)
                ids.add(item["id"])
            if item["name"] in items:
                duplicate.add(item["name"])
            items[item["name"]] = item
        for name,row in previous.items():
            if full and row["present"] and row["card"] and not row["ambiguous"]:
                old_id = json.loads(row["card"]).get("id")
                if old_id:
                    if row["open_lock"]:
                        db.execute("INSERT OR REPLACE INTO card_locks VALUES(?,?,?)",(wid,old_id,row["open_lock"]))
                    else:
                        db.execute("DELETE FROM card_locks WHERE worker=? AND platform_id=?",(wid,old_id))
            if full and row["present"] and name not in items:
                db.execute("UPDATE accounts SET present=0,card=NULL,card_at=NULL,risk=NULL,risk_at=NULL,portfolio=NULL,read_session=NULL,initial_balance=NULL,baseline_phase=NULL WHERE worker_id=? AND name=?",(wid,name))
    changed_risks = {}
    for name,item in items.items():
        row = previous.get(name)
        lock = json.loads(row["open_lock"]) if row and row["open_lock"] else None
        prior = json.loads(row["card"]) if row and row["card"] else {}
        if full and item["id"] and (item["id"]!=prior.get("id") or row and row["ambiguous"]):
            saved = db.execute("SELECT lock FROM card_locks WHERE worker=? AND platform_id=?",(wid,item["id"])).fetchone()
            lock = json.loads(saved[0]) if saved else None
        old_phase = prior.get("phase") if prior else row["phase"] if row else None
        same = bool(row and row["present"] and not row["ambiguous"] and name not in duplicate and (not prior.get("id") or prior["id"]==item["id"]) and
                    (not item["phase"] or not old_phase or item["phase"]==old_phase))
        category = item["category"]
        due = lock and observed >= lock["until"] and (not row or (row["risk_at"] or 0) < lock["until"])
        if same and not due and (category=="active" or row["risk_at"] and category==prior.get("category")):
            category = row["category"]
        phase = row["phase"] if same and row["phase"] and (not item["phase"] or not due and row["risk_at"] and item["phase"]==old_phase) else item["phase"]
        if source_at is not None:
            category,phase = item["category"],item["phase"]
        risk = json.loads(row["risk"]) if same and row["risk"] else {}
        if not same or observed >= (row["risk_at"] or 0):
            for key in AMOUNTS:
                if key not in risk or item[key] is not None and item[key] != prior.get(key):
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
        if full:
            db.execute("UPDATE accounts SET open_lock=? WHERE worker_id=? AND name=?",(dump(lock) if lock else None,wid,name))
        if not same or name in duplicate:
            db.execute("""UPDATE accounts SET snapshot='{}',observed_at=NULL,read_session=NULL,risk_at=NULL,read_error='',
                       preflight_at=NULL,history_due_at=NULL,tracked_position=NULL,portfolio=NULL,initial_balance=NULL,baseline_phase=NULL WHERE worker_id=? AND name=?""",(wid,name))
        if not same or row["phase"] != phase or row["phase_started_at"] is None:
            db.execute("UPDATE accounts SET phase_started_at=? WHERE worker_id=? AND name=?", (observed if phase else None,wid,name))
        if metrics and dump(risk) != row["risk"]:
            changed_risks[name] = risk
    db.execute("""INSERT INTO card_sync VALUES(?,?,?,?,?,?) ON CONFLICT(worker) DO UPDATE SET
                session=excluded.session,generation=excluded.generation,full_at=excluded.full_at,seen=excluded.seen,source_at=excluded.source_at""",
               (wid,sid,gen,observed if full else sync["full_at"],observed,source_at if source_at is not None else sync["source_at"] if sync and sync["session"]==sid else None))
    if metrics:
        return {"observed_at": observed, "risks": changed_risks}
    rows = db.execute("SELECT name,risk,portfolio,open_lock FROM accounts WHERE worker_id=? AND present=1",(wid,)).fetchall()
    return {"count":len(items),"generation":gen,"supports_metrics":True,"risks":{r["name"]:json.loads(r["risk"]) for r in rows},
            "floors":{r["name"]:daily_floor.view(db,wid,r["name"],now) for r in rows},
            "open_locks":{r["name"]:json.loads(r["open_lock"]) for r in rows if r["open_lock"]},
            "portfolios":{r["name"]:json.loads(r["portfolio"]) for r in rows if r["portfolio"]}}
