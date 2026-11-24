"""Node audit events and filtered position, order and payout reports."""
import json
import re
from datetime import date, datetime, time, timedelta, timezone

from .ledger import SCALE
from .protocol import PHASES, Problem, choice, ident, number, require, string
from .storage import summary

ZONE = timezone(timedelta(hours=8))
PAGE_SIZE = 50


def log_schema(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS node_logs(id INTEGER PRIMARY KEY, node TEXT NOT NULL, at REAL NOT NULL,
            level TEXT NOT NULL, event TEXT NOT NULL, message TEXT NOT NULL, worker TEXT, account TEXT, command_id TEXT,
            source TEXT NOT NULL DEFAULT 'local');
        CREATE INDEX IF NOT EXISTS node_logs_route ON node_logs(node,at DESC,id DESC);
        CREATE TRIGGER IF NOT EXISTS log_command_create AFTER INSERT ON commands BEGIN
            INSERT INTO node_logs(node,at,level,event,message,worker,account,command_id)
            VALUES(NEW.node,NEW.created,'info','command',NEW.action||' · '||NEW.status,NEW.worker,NEW.account,NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS log_command_change AFTER UPDATE ON commands
        WHEN OLD.status!=NEW.status OR (NEW.cancel=1 AND OLD.cancel=0) BEGIN
            INSERT INTO node_logs(node,at,level,event,message,worker,account,command_id)
            VALUES(NEW.node,NEW.updated,CASE WHEN NEW.status IN ('failed','unknown') THEN 'error'
                WHEN NEW.status IN ('expired','cancelled') THEN 'warning' ELSE 'info' END,'command',
                NEW.action||' · '||CASE WHEN NEW.cancel=1 THEN '取消中' ELSE NEW.status END||
                CASE WHEN NEW.error='' THEN '' ELSE ' · '||NEW.error END,NEW.worker,NEW.account,NEW.id);
        END;
    """)
    if "source" not in {r["name"] for r in conn.execute("PRAGMA table_info(node_logs)")}:
        conn.execute("ALTER TABLE node_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'local'")


def log(db, node, now, event, message, level="info", worker=None, account=None, command_id=None, source="local"):
    db.execute("INSERT INTO node_logs(node,at,level,event,message,worker,account,command_id,source) VALUES(?,?,?,?,?,?,?,?,?)",
               (node, now, level, event, message, worker, account, command_id, source))


def import_event(db, nid, item):
    log(db, nid, number(item.get("at"), "日志时间", 0, 1e11), string(item.get("event"), "事件", 40),
        string(item.get("message"), "日志内容", 1000), choice(item.get("level"), {"info","warning","error"}, "日志级别"),
        ident(item["worker"]) if item.get("worker") else None, string(item["account"], "日志账户") if item.get("account") else None,
        ident(item["command_id"]) if item.get("command_id") else None, source="bridge")


def logs(db, node, level, offset):
    cond = "node=?"
    args = [node]
    if level:
        cond += " AND level=?"
        args.append(choice(level, {"info", "warning", "error"}, "日志级别"))
    offset = number(offset, "偏移", 0, 2**31, True)
    total = db.execute("SELECT COUNT(*) FROM node_logs WHERE " + cond, args).fetchone()[0]
    rows = db.execute("SELECT * FROM node_logs WHERE " + cond + " ORDER BY at DESC,id DESC LIMIT ? OFFSET ?",
                      (*args, PAGE_SIZE, offset))
    return {"total": total, "items": [dict(r) for r in rows]}


def local_day(value):
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError
        return datetime.combine(date.fromisoformat(value), time(), ZONE).timestamp()
    except (ValueError, OSError, OverflowError):
        raise Problem("日期须为有效的 YYYY-MM-DD") from None


def minute(value):
    require(isinstance(value, str) and re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value), "时段须为 HH:MM")
    hour, mins = map(int, value.split(":"))
    return hour * 60 + mins


def filters(query):
    cond, args = [], []
    for k, sql in (("node_id", "node"), ("account", "account"), ("phase", "COALESCE(phase,'unknown')")):
        v = query.get(k)
        if v:
            v = ident(v) if k == "node_id" else choice(v, PHASES | {"unknown"}, "阶段") if k == "phase" else string(v, "账户")
            cond.append(sql + "=?")
            args.append(v)
    start = minute(query["start_time"]) if query.get("start_time") else 0
    end = minute(query["end_time"]) if query.get("end_time") else 1440
    if start == end:
        start, end = 0, 1440
    start_day = local_day(query["from_date"]) if query.get("from_date") else None
    end_day = local_day(query["to_date"]) if query.get("to_date") else None
    require(start_day is None or end_day is None or start_day <= end_day, "起始日期不能晚于结束日期")
    overnight = start > end
    if start_day is not None:
        cond.append("at>=?")
        args.append(start_day + 60 * start)
    if end_day is not None:
        cond.append("at<?")
        args.append(end_day + 60 * end + 86400 * overnight)
    if (start, end) != (0, 1440):
        hour = "((CAST(at AS INTEGER)+28800)%86400)/60"
        op = " OR " if overnight else " AND "
        cond.append("(" + hour + ">=?" + op + hour + "<?)")
        args.extend((start, end))
    return " AND ".join(cond) or "1", args


def totals(rows):
    rows = list(rows)
    names = ("wins", "losses", "flat", "unsettled", "pnl_units", "payout_units", "withdrawals", "paid_units", "completed_payouts")
    t = {k: sum(r[k] for r in rows) for k in names}
    settled = t["wins"] + t["losses"] + t["flat"]
    return {"wins": t["wins"], "losses": t["losses"], "flat": t["flat"], "settled": settled,
            "unsettled": t["unsettled"], "win_rate": t["wins"] / settled if settled else None,
            "realized_pnl": t["pnl_units"] / SCALE if settled else None,
            "total_withdrawn": t["payout_units"] / SCALE, "withdrawals": t["withdrawals"],
            "total_paid": t["paid_units"] / SCALE, "completed_payouts": t["completed_payouts"]}


def analytics(db, query):
    section = choice(query.get("section", "position"), {"position","order","payout","withdrawal","instruction",
                     "deposit","chain_withdrawal","account_history"}, "明细类型")
    try:
        offset = number(int(query.get("offset", 0)), "偏移", 0, 2**31, True)
    except (ValueError, TypeError):
        raise Problem("偏移无效") from None
    cond, args = filters(query)
    node = query.get("node_id")
    nodes = list(db.execute("SELECT id,label FROM nodes" + (" WHERE id=?" if node else "") + " ORDER BY label,id",
                            (node,) if node else ()))
    require(not node or nodes, "找不到该节点", 404)
    # Select the best evidence for each logical account/ID before applying time and stage filters.
    account = query.get("account")
    arguments = ([node] if node else []) + ([account] if account else []) + args
    lifecycle_filter = ""
    if query.get("owner_state"):
        state = choice(query["owner_state"], {"active", "closed"}, "归属账户状态")
        require(section in {"position", "order", "payout", "account_history"}, "此明细没有平台账户范围")
        status = "a.closed=1" if state == "closed" else "json_extract(a.data,'$.status')='2'"
        lifecycle_filter = f""" AND EXISTS (SELECT 1 FROM book a WHERE a.node=ranked.node AND a.worker=ranked.worker
            AND a.kind='account_history' AND a.account=a.ref AND {status}
            AND a.account=COALESCE(ranked.owner_id,(SELECT p.platform_id FROM platform_accounts p
                WHERE p.node=ranked.node AND p.worker=ranked.worker AND p.config_name=ranked.account)))"""
    identity = """CASE WHEN b.kind IN ('deposit','chain_withdrawal') THEN
        COALESCE('chain/'||json_extract(b.data,'$.chain_id')||'/'||json_extract(b.data,'$.tx_hash'),
                 'wallet/'||b.node||'/'||b.worker)
        ELSE COALESCE('platform/'||b.source,'platform/'||m.source,'account/'||b.logical) END,b.kind,b.canonical_ref"""
    priority = """ORDER BY b.closed DESC,(b.pnl IS NOT NULL) DESC,
        json_extract(b.data,'$.updated_at') DESC,
        (b.phase IS NOT NULL) DESC,(b.section_owner IS NOT NULL) DESC,b.seq DESC"""
    # A later evaluation account can also display an earlier account's closed positions.
    # Match the explicit platform section to an ungrouped copy only on identical settlement evidence.
    book = f"""WITH named AS (
        SELECT b.seq,b.node,b.worker,COALESCE(p.config_name,json_extract(a.data,'$.name'),b.account) AS account,
            CASE WHEN b.kind='platform_payout' THEN 'payout' ELSE b.kind END AS kind,b.ref,
            COALESCE(b.phase,a.phase) AS phase,b.at,b.closed,b.pnl,b.payout,b.data
        FROM book b LEFT JOIN book a ON a.node=b.node AND a.worker=b.worker AND a.kind='account_history'
            AND a.account=b.account AND a.ref=json_extract(b.data,'$.source_account_id')
        LEFT JOIN platform_accounts p ON p.node=b.node AND p.worker=b.worker AND p.platform_id=b.account
            AND b.account=json_extract(b.data,'$.source_account_id')
        {"WHERE b.node=?" if node else ""}),
        routes AS (SELECT b.*, COALESCE(NULLIF(c.account_ref,''),b.account) AS logical,
            json_extract(b.data,'$.source_account_id') AS section_owner, json_extract(b.data,'$.symbol') AS symbol
        FROM named b LEFT JOIN account_config c ON c.node=b.node AND c.worker=b.worker AND c.name=b.account),
        sections AS (SELECT node,worker,ref,at,symbol,MIN(section_owner) AS owner
            FROM routes WHERE kind='position' AND section_owner IS NOT NULL GROUP BY node,worker,ref,at,symbol
            HAVING MIN(section_owner)=MAX(section_owner)),
        abbreviated AS (
            SELECT d.seq,MIN(n.ref) AS full_ref,MIN(n.section_owner) AS owner FROM routes d JOIN routes n
            ON d.kind IN ('order','payout') AND n.kind=d.kind AND n.section_owner IS NOT NULL AND d.ref LIKE 'display|%'
            AND d.node=n.node AND d.worker=n.worker AND d.account=n.account
            AND CAST(json_extract(d.data,'$.created_at') AS INTEGER)=CAST(json_extract(n.data,'$.created_at') AS INTEGER)
            AND (d.kind='payout' OR REPLACE(d.symbol,'NDX-USD-PERP','NQ-PERP')=REPLACE(n.symbol,'NDX-USD-PERP','NQ-PERP'))
            AND n.ref GLOB REPLACE(REPLACE(json_extract(d.data,'$.display_id'),'...','*'),'…','*')
            GROUP BY d.seq HAVING COUNT(DISTINCT n.ref)=1 AND COUNT(DISTINCT n.section_owner)=1),
        mapped AS (SELECT r.*,COALESCE(o.full_ref,r.ref) AS canonical_ref,COALESCE(r.section_owner,s.owner,o.owner) AS source FROM routes r
            LEFT JOIN abbreviated o ON o.seq=r.seq
            LEFT JOIN sections s ON r.kind='position' AND s.node=r.node AND s.worker=r.worker AND s.ref=r.ref
            AND s.at=r.at AND s.symbol=r.symbol),
        mirrors AS (SELECT kind,logical,canonical_ref,MIN(source) AS source FROM mapped WHERE source IS NOT NULL
            GROUP BY kind,logical,canonical_ref HAVING MIN(source)=MAX(source)),
        ranked AS (
        SELECT b.*, COALESCE(b.source,m.source) AS owner_id, ROW_NUMBER() OVER (PARTITION BY b.node,{identity} {priority}) AS ordinal,
            ROW_NUMBER() OVER (PARTITION BY {identity} {priority}) AS fleet_ordinal
        FROM mapped b LEFT JOIN mirrors m ON b.kind IN ('position','order','payout') AND b.kind=m.kind AND b.logical=m.logical AND b.canonical_ref=m.canonical_ref
        {"WHERE b.account=?" if account else ""}),
        entries AS (SELECT * FROM ranked WHERE {cond}{lifecycle_filter}) """
    # Node totals describe that node. A mirrored trade counts only once in the fleet total.
    rows = list(db.execute(book + """, counted AS (
        SELECT node,phase,closed,pnl,payout,kind FROM entries WHERE ordinal=1
        UNION ALL SELECT NULL,phase,closed,pnl,payout,kind FROM entries WHERE fleet_ordinal=1)
        SELECT node,COALESCE(phase,'unknown') AS stage,
        SUM(CASE WHEN kind='position' AND closed AND pnl>0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN kind='position' AND closed AND pnl<0 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN kind='position' AND closed AND pnl=0 THEN 1 ELSE 0 END) AS flat,
        SUM(CASE WHEN kind='position' AND closed AND pnl IS NULL THEN 1 ELSE 0 END) AS unsettled,
        SUM(CASE WHEN kind='position' AND closed THEN COALESCE(pnl,0) ELSE 0 END) AS pnl_units,
        SUM(CASE WHEN kind='withdrawal' THEN payout ELSE 0 END) AS payout_units, SUM(kind='withdrawal') AS withdrawals,
        SUM(CASE WHEN kind='payout' THEN COALESCE(payout,0) ELSE 0 END) AS paid_units,
        SUM(kind='payout' AND payout IS NOT NULL) AS completed_payouts
        FROM counted WHERE kind IN ('position','withdrawal','payout') GROUP BY node,stage""", arguments))
    stages = [query["phase"]] if query.get("phase") else ["1/2", "2/2", "live"]
    breakdown = []
    for n in nodes:
        selected = [r for r in rows if r["node"] == n["id"]]
        phases = list(stages)
        if "unknown" not in phases and any(r["stage"] == "unknown" for r in selected):
            phases.append("unknown")
        breakdown.append({"node_id": n["id"], "label": n["label"], **totals(selected),
                          "stages": [{"phase": p, **totals(r for r in selected if r["stage"] == p)} for p in phases]})
    if section == "instruction":
        source = """WITH instructions AS (SELECT *,created AS at,json_extract(body,'$.phase') AS phase
            FROM commands WHERE action IN ('order.open','order.close','position.protect')) """
        sql = " FROM instructions WHERE " + cond
        count = db.execute(source + "SELECT COUNT(*)" + sql, args).fetchone()[0]
        items = [summary(r) for r in db.execute(source + "SELECT *" + sql + " ORDER BY at DESC,id DESC LIMIT ? OFFSET ?",
                                                 (*args, PAGE_SIZE, offset))]
    else:
        sql = " FROM entries WHERE ordinal=1 AND kind=?"
        if section=="account_history" and query.get("account_state"):
            mode = choice(query["account_state"],{"closed","active"},"账户状态")
            sql += " AND closed=1" if mode=="closed" else " AND json_extract(data,'$.status')='2'"
        page = list(db.execute(book + "SELECT *,COUNT(*) OVER() AS matches" + sql +
                    " ORDER BY at DESC,node,worker,account,ref LIMIT ? OFFSET ?", (*arguments, section, PAGE_SIZE, offset)))
        count = page[0]["matches"] if page else 0
        if offset and not page:
            count = db.execute(book + "SELECT COUNT(*)" + sql, (*arguments, section)).fetchone()[0]
        items = [{"node_id": r["node"], "worker_id": r["worker"], "account": r["account"], "ref": r["canonical_ref"],
                  **json.loads(r["data"]), "phase":r["phase"], "at": r["at"], "closed": bool(r["closed"])}
                 for r in page]
    counts, cash = {"closed_accounts":0}, []
    for r in db.execute(book + """SELECT kind,json_extract(data,'$.currency') AS currency,
            COUNT(*) AS records,SUM(closed) AS ended,SUM(CASE WHEN lower(json_extract(data,'$.status')) IN
            ('completed','confirmed','succeeded','success') THEN CAST(ROUND(json_extract(data,'$.amount')*1000000) AS INTEGER)
            END)/1000000.0 AS settled_amount FROM entries WHERE fleet_ordinal=1
            AND kind IN ('order','account_history','deposit','chain_withdrawal') GROUP BY kind,currency ORDER BY kind,currency""",arguments):
        kind = r["kind"]
        counts[kind] = counts.get(kind,0)+r["records"]
        if kind=="account_history":
            counts["closed_accounts"] += r["ended"]
        elif kind in ("deposit","chain_withdrawal"):
            cash.append({k:r[k] for k in ("kind","currency","records","settled_amount")})
    return {"timezone": "Asia/Shanghai", "summary": totals(r for r in rows if r["node"] is None), "nodes": breakdown, "section": section,
            "counts":counts,"cash":cash,
            "total": count, "offset": offset, "items": items}
