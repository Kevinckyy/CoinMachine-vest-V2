"""One browser-scoped read, with its directory and per-account progress committed at the node."""
import json

from . import cards, daily_floor
from .protocol import PORTFOLIO_SCAN, RUN_TTL, boolean, dump, fields, ident, number, obj, require, string
from .storage import command, finish


def progress(row):
    return json.loads(row["result"]) if row["result"] else {
        "stage": "list", "listed_at": None, "total": 0, "read": 0, "partial": 0, "failed": 0, "accounts": []}


def owned(db, key, worker, session):
    row = command(db, ident(key))
    require(row["action"] == PORTFOLIO_SCAN and row["worker"] == worker
            and json.loads(row["body"])["session_id"] == session, "全量读取指令与浏览器会话不符", 409)
    return row


def next_item(scan):
    return next((item for item in scan["accounts"] if item["status"] == "pending"), None)


def save(db, row, scan, now):
    if scan["stage"] == "portfolio" and not next_item(scan):
        scan["stage"] = "done"
        error = ""
        if scan["failed"] or scan["partial"]:
            error = f"完整 {scan['read']}，字段不全 {scan['partial']}，失败 {scan['failed']}"
        finish(db, row["id"], "failed" if error else "succeeded", now, error, scan)
    else:
        db.execute("UPDATE commands SET result=?,updated=? WHERE id=?", (dump(scan), now, row["id"]))


def listed(db, row, reading, now):
    scan = progress(row)
    require(row["status"] == "running" and scan["stage"] in ("list", "cache") and reading["full"] is True,
            "须先为本次指令全量拉取账户列表", 409)
    require(reading["observed_at"] >= row["claimed"] - 0.001, "清单早于本次指令，请重新拉取", 409)
    seen = set()
    targets = []
    for card in reading["items"]:
        name = card["name"].strip()
        if name in seen:
            continue
        seen.add(name)
        current = db.execute("SELECT ambiguous,card FROM accounts WHERE worker_id=? AND name=? AND present=1",
                             (row["worker"], name)).fetchone()
        item = json.loads(current["card"])
        target = {"name": name, "card_id": item["id"], "phase": item["phase"], "status": "pending"}
        if current["ambiguous"]:
            target.update(status="failed", error="活动列表中账户重名")
        targets.append(target)
    scan.update(stage="cache", listed_at=reading["observed_at"], accounts=targets, total=len(targets),
                failed=sum(item["status"] == "failed" for item in targets))
    save(db, row, scan, now)


def delivery(db, row, cached_scan, now):
    scan = progress(row)
    if scan["stage"] == "cache" and cached_scan == row["id"]:
        scan["stage"] = "portfolio"
        save(db, row, scan, now)
        row = command(db, row["id"])
        if row["status"] != "running":
            return {"command": None, "card_generation": db.execute("SELECT generation FROM card_request").fetchone()[0]}
    target = next_item(scan) if scan["stage"] == "portfolio" else None
    step = {"stage": "portfolio", "target": target} if target else {"stage": "list"}
    return {"command": json.loads(row["body"]), "scan": step, "run_until": row["updated"] + RUN_TTL,
            "card_generation": db.execute("SELECT generation FROM card_request").fetchone()[0]}


def values(raw, now):
    fields(raw, (*cards.AMOUNTS, "daily_unlimited", "observed_at"))
    data = {"observed_at": number(raw.get("observed_at"), "Portfolio 读取时间", now - RUN_TTL, now + 10),
            "daily_unlimited": boolean(raw.get("daily_unlimited", False))}
    for key in cards.AMOUNTS:
        value = raw.get(key)
        low = 0 if key in ("health", "daily_limit", "drawdown_limit") else -1e12
        data[key] = None if value is None else round(number(value, key, low, 100 if key == "health" else 1e12), 2)
    require(not data["daily_unlimited"] or data["daily_limit"] is None, "每日亏损限额读数冲突")
    data["missing"] = [key for key in cards.AMOUNTS if data[key] is None
                       and not (key in ("daily_loss", "daily_limit") and data["daily_unlimited"])]
    return data


def observe(db, worker, session, payload, now):
    payload = obj(payload)
    row = owned(db, payload.get("id"), worker, session)
    scan = progress(row)
    name = string(payload.get("name"), "账户名")
    card_id = string(payload.get("card_id"), "卡片标识", 160, True)
    item = next((i for i in scan["accounts"] if i["name"] == name and i["card_id"] == card_id), None)
    require(item and scan["stage"] in ("portfolio", "done"), "账户不在本次已确认的清单中", 409)
    if item["status"] != "pending":
        return {"status": row["status"]}
    require(row["status"] == "running" and item == next_item(scan), "该账户尚未轮到读取", 409)
    account = db.execute("SELECT * FROM accounts WHERE worker_id=? AND name=?", (worker, name)).fetchone()
    card = json.loads(account["card"]) if account and account["card"] else {}
    error = string(payload.get("error", ""), "读取错误", 500, True)
    if (not account or not account["present"] or account["ambiguous"] or account["listed_session"] != session
            or card.get("id") != card_id or card.get("phase") != item["phase"]):
        error = "活动账户身份已变化"
    ack = {}
    if error:
        item.update(status="failed", error=error)
    else:
        detail = values(obj(payload.get("values")), now)
        require(detail["observed_at"] >= scan["listed_at"] - 0.001, "详情早于本次账户清单", 409)
        item.update(status="partial" if detail["missing"] else "read", values=detail)
        risk = json.loads(account["risk"] or "{}")
        if detail["observed_at"] >= (account["risk_at"] or 0):
            for key in cards.AMOUNTS:
                if detail[key] is not None or detail["daily_unlimited"] and key in ("daily_loss", "daily_limit"):
                    risk[key] = detail[key]
            if detail["daily_unlimited"] or detail["daily_limit"] is not None:
                risk["daily_unlimited"] = detail["daily_unlimited"]
            daily_floor.capture(db, worker, name, detail["observed_at"], detail["daily_limit"])
        db.execute("UPDATE accounts SET portfolio=?,risk=? WHERE worker_id=? AND name=?",
                   (dump(detail), dump(risk), worker, name))
        ack = {"risk": risk, "portfolio": detail}
    scan[item["status"]] += 1
    save(db, row, scan, now)
    return {**ack, "status": command(db, row["id"])["status"]}
