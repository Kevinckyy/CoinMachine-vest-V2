"""Durable browser evidence. The bridge sequence also serves as a replication cursor."""
import json
from decimal import Decimal

from .protocol import PHASES, choice, dump, number, obj, require, string
from .storage import record

SCALE = 1_000_000
ARCHIVE_KINDS = {"account_history","deposit","chain_withdrawal","order","platform_payout"}
BOOK_KINDS = ARCHIVE_KINDS | {"position","withdrawal","payout"}
ENDED_ACCOUNTS = {"3","4","5","6","7"}
SETTLED_TRANSFERS = {"completed","confirmed","success","succeeded","failed","refunded","cancelled","rejected"}


def units(value):
    return int((Decimal(str(value)) * SCALE).to_integral_value()) if value is not None else None


def schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS book(
            seq INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, worker TEXT NOT NULL, account TEXT NOT NULL,
            kind TEXT NOT NULL, ref TEXT NOT NULL, phase TEXT, at REAL NOT NULL, closed INTEGER NOT NULL,
            pnl INTEGER, payout INTEGER, data TEXT NOT NULL, UNIQUE(node,worker,account,kind,ref)
        );
        CREATE INDEX IF NOT EXISTS book_node_time ON book(node,at,kind);
        CREATE INDEX IF NOT EXISTS book_time ON book(at,kind);
        CREATE INDEX IF NOT EXISTS book_stream_seq ON book(COALESCE(json_extract(data,'$.archive'),0),seq);
        CREATE TABLE IF NOT EXISTS book_migrations(name TEXT PRIMARY KEY);
    """)


def stamp(value):
    return number(value, "历史时间", 1, 32_503_680_000)


def save(db, route, kind, ref, incoming):
    """Merge complementary observations without turning first-seen time into a platform fill time."""
    old = db.execute("SELECT data FROM book WHERE node=? AND worker=? AND account=? AND kind=? AND ref=?",
                     (*route, kind, ref)).fetchone()
    previous = json.loads(old["data"]) if old else {}
    data = {**previous, **{k: v for k, v in incoming.items() if v is not None}}
    if kind == "position":
        # A later position snapshot can fill missing fields but cannot supersede a historical settlement.
        if previous.get("history") and not incoming.get("history"):
            data.update({k: v for k, v in previous.items() if v is not None})
        if previous.get("source_account_id") and previous.get("phase") and not incoming.get("source_account_id"):
            data["phase"] = previous["phase"]
        for k in ("open_seen", "close_seen"):
            if previous.get(k) and incoming.get(k):
                data[k] = min(previous[k], incoming[k])
        at = data.get("closed_at") or data.get("close_seen") or data.get("opened_at") or data["open_seen"]
        closed = bool(data.get("closed_at") or data.get("close_seen"))
    elif kind in ARCHIVE_KINDS | {"payout"}:
        if previous.get("updated_at", 0) > incoming.get("updated_at", 0):
            return
        terminal = ENDED_ACCOUNTS if kind=="account_history" else SETTLED_TRANSFERS if kind in ("deposit","chain_withdrawal") else set()
        if (previous.get("updated_at")==incoming.get("updated_at") and previous.get("status") in terminal
                and incoming.get("status") not in terminal):
            return
        at = (data.get("finalized_at") if kind=="account_history" else
              data.get("executed_at") if kind in ("payout","platform_payout") else None) or data["created_at"]
        closed = kind=="account_history" and data["status"] in ENDED_ACCOUNTS
    else:
        at, closed = data["verified_at"], False
    if data == previous:
        return
    # Replacing allocates a NEW sequence. A previously synced row that gains its PnL travels again.
    payout = data.get("amount") if kind == "withdrawal" else None
    if kind in ("payout","platform_payout") and data.get("status") == "completed" and data.get("executed_at"):
        payout = data.get("net_amount")
    db.execute("""INSERT OR REPLACE INTO book(node,worker,account,kind,ref,phase,at,closed,pnl,payout,data)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (*route, kind, ref, data.get("phase"), at, closed,
                  units(data.get("pnl")), units(payout), dump(data)))


def position_observation(db, route, snapshot, phase, command_id=None):
    pid = snapshot.get("position_id")
    if snapshot.get("position_open") is not True or not pid or not snapshot.get("observed_at"):
        return
    data = {k: snapshot.get(k) for k in ("symbol", "side", "quantity", "entry_price")}
    if snapshot.get("opened_at") is not None:
        opened = stamp(snapshot["opened_at"])
        require(opened<=snapshot["observed_at"]+1,"开仓时间晚于读取时间")
        data["opened_at"] = opened
    save(db, route, "position", pid, dict(data, position_id=pid, phase=phase, open_seen=snapshot["observed_at"],
                                          open_command=command_id))


def verified_withdrawal(cmd, result, snap):
    proof = cmd["intents"].get("withdraw", {}).get("proof", {})
    amount, before, after = result.get("amount"), proof.get("balance_before"), snap.get("balance")
    return (snap.get("position_open") is False and cmd.get("phase") == "live"
            and type(amount) in (int, float) and amount > 0 and amount == cmd["params"].get("amount")
            and amount == proof.get("amount") and result.get("recipient") == proof.get("recipient") == "main"
            and type(before) in (int, float) and type(after) in (int, float) and 1e12 >= before > after >= 0
            and abs(units(before) - units(after) - units(amount)) <= 5000)


def command_evidence(db, cmd):
    if cmd["status"] != "succeeded" or cmd["action"] not in ("order.open", "order.close", "profit.withdraw"):
        return
    result = cmd.get("result") or {}
    obs = result.get("observation") or {}
    snap = obs.get("snapshot") or {}
    if obs.get("name") != cmd["account"] or cmd.get("phase") and obs.get("phase") != cmd["phase"]:
        return
    route = (cmd["node_id"], cmd["worker_id"], cmd["account"])
    phase = cmd.get("phase") or obs.get("phase")
    at = snap.get("observed_at") or cmd["updated_at"]
    if cmd["action"] == "order.open":
        position_observation(db, route, snap, phase, cmd["id"])
    elif cmd["action"] == "order.close" and snap.get("position_open") is False:
        pid = cmd["params"]["position_id"]
        save(db, route, "position", pid, {**(cmd.get("expected_position") or {}), "position_id": pid,
             "phase": phase, "close_seen": at, "close_command": cmd["id"]})
    elif cmd["action"] == "profit.withdraw":
        if not verified_withdrawal(cmd, result, snap):
            return
        amount = result["amount"]
        expected = result.get("expected_received")
        if type(expected) not in (int, float) or not 0 <= expected <= amount:
            expected = None
        save(db, route, "withdrawal", cmd["id"], dict(command_id=cmd["id"], phase=phase, amount=amount,
             expected_received=expected, verified_at=at))


def backfill(db):
    if db.execute("SELECT 1 FROM book_migrations WHERE name='command-receipts'").fetchone():
        return
    for row in db.execute("""SELECT * FROM commands WHERE status='succeeded' AND
                          action IN ('order.open','order.close','profit.withdraw') ORDER BY updated,id"""):
        command_evidence(db, record(row))
    db.execute("INSERT INTO book_migrations VALUES('command-receipts')")


def native_rows(db, route, payload, *, archived=False):
    rows = payload.get("items")
    require(isinstance(rows, list) and len(rows) <= 200, "历史记录每次最多 200 行")
    for item in rows:
        obj(item)
        kind = choice(item.get("kind"), {"position", "order", "payout"}, "历史类型")
        ref = string(item.get("ref"), "历史标识", 350)
        data = {"phase": choice(item["phase"], PHASES, "历史阶段") if item.get("phase") else None}
        for k in ("symbol", "side", "order_type", "status", "size_text", "display_id"):
            if item.get(k) is not None:
                data[k] = string(item[k], k, 160)
        for k in ("entry_price", "exit_price", "quantity", "execution_price"):
            if item.get(k) is not None:
                data[k] = number(item[k], k, 0, 1e12)
        if kind == "position":
            data.update(position_id=ref, history=True, closed_at=stamp(item.get("closed_at")))
            if archived:
                data["archive"]=True
            if item.get("source_account_id"):
                data["source_account_id"] = string(item["source_account_id"], "平台来源账户", 160)
            if item.get("opened_at") is not None:
                data["opened_at"] = stamp(item["opened_at"])
                require(data["opened_at"] <= data["closed_at"], "平仓时间早于开仓")
            if item.get("pnl") is not None:
                data["pnl"] = number(item["pnl"], "已实现盈亏", -1e10, 1e10)
        else:
            data["created_at"] = stamp(item.get("created_at"))
            data["updated_at"] = stamp(item.get("updated_at") or data["created_at"])
            if kind == "payout":
                data["phase"] = "live"
                data["status"] = choice(item.get("status"), {"processing","completed","refunded","failed"}, "平台出金状态")
                for k in ("gross_amount","net_amount"):
                    data[k] = number(item[k], k, 0, 1e10) if item.get(k) is not None else None
                if item.get("executed_at"):
                    data["executed_at"] = stamp(item["executed_at"])
        save(db, route, kind, ref, data)


def archive_rows(db, node, worker, items):
    require(isinstance(items,list) and len(items)<=200, "每批历史记录最多 200 行")
    for record in items:
        item = obj(record)
        kind = choice(item.get("kind"), ARCHIVE_KINDS | {"position"}, "归档类型")
        ref = string(item.get("ref"),"平台记录编号")
        if kind=="position":
            owner=string(item.get("source_account_id"),"持仓所属平台账户")
            native_rows(db,(node,worker,owner),{"items":[item]},archived=True)
            continue
        data = {"archive":True,"created_at":stamp(item.get("created_at")), "updated_at":stamp(item.get("updated_at"))}
        if kind in ("order","account_history","platform_payout"):
            account = string(item.get("source_account_id"),"平台账户 ID")
            data["source_account_id"] = account
            if item.get("phase"):
                data["phase"] = choice(item["phase"], PHASES, "历史阶段")
        else:
            account = "主账户"
            data["amount"] = number(item.get("amount"),"链上金额",0,1e12)
        data["status"] = string(item.get("status") or "unknown","平台状态",80)
        if kind=="account_history":
            require(ref==account,"历史账户标识不一致")
            data["name"] = string(item.get("name") or account,"账户名")
        for k in ("symbol","side","order_type","plan","root_account_id","currency","chain_id","tx_hash"):
            if item.get(k) is not None:
                data[k] = string(item[k], k)
        for k in ("quantity","executed_quantity","execution_price","fee","initial_capital","final_equity","gross_amount","net_amount","platform_amount"):
            if item.get(k) is not None:
                data[k] = number(item[k],k,-1e12 if k in ("fee","final_equity") else 0,1e12)
        for k in ("activated_at","finalized_at","blocked_at","expires_at","executed_at"):
            if item.get(k) is not None:
                data[k] = stamp(item[k])
        save(db,(node,worker,account),kind,ref,data)


def high_water(db, archive):
    return db.execute("SELECT COALESCE(MAX(seq),0) FROM book WHERE COALESCE(json_extract(data,'$.archive'),0)=?",(int(archive),)).fetchone()[0]


def page(db, after, archive=False):
    rows = db.execute("""SELECT seq,worker,account,kind,ref,data FROM book
        WHERE COALESCE(json_extract(data,'$.archive'),0)=? AND seq>? ORDER BY seq LIMIT 200""",(int(archive),after))
    return {"items": [{**dict(row), "data": json.loads(row["data"])} for row in rows]}
