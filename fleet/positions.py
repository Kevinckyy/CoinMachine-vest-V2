"""Read models for open positions. Account cards supply live values, trades identify individual fills."""
import json


def latest_count(account):
    card = account.get("card") or {}
    if card and (account.get("card_at") or 0) >= (account.get("observed_at") or 0):
        return card.get("active_positions")
    return 1 if account["snapshot"].get("position_open") is True else 0


def protection(snap, leg):
    trigger = snap.get(f"native_{leg}_price")
    entry, qty = snap.get("entry_price"), snap.get("quantity")
    if all(type(x) in (int, float) and x > 0 for x in (trigger, entry, qty)) and snap.get("side") in ("buy", "sell"):
        sign = 1 if (snap["side"] == "buy") == (leg == "tp") else -1
        return round((trigger - entry) * qty * sign, 2)
    if snap.get(f"native_{leg}_absent") is True:
        return "omitted"
    report, amount = ("stop_check", "actual_risk") if leg == "sl" else ("take_profit_check", "actual_profit")
    check = snap.get(report) or {}
    if check.get("status") == "omitted":
        return "omitted"
    return check.get(amount) if check.get("status") == "verified" else None


def detail(db, a):
    s = a["snapshot"]
    pid = s.get("position_id")
    if not (a["present"] and not a["ambiguous"] and latest_count(a) == 1 and s.get("position_open") is True and pid):
        return None
    if "tracked_position_id" in a and a["tracked_position_id"] != pid:
        return None
    row = db.execute("""SELECT b.closed, b.phase, json_extract(c.intents,'$.open.time') AS submitted_at
        FROM book b LEFT JOIN commands c ON c.id=json_extract(b.data,'$.open_command') AND c.node=b.node
          AND c.worker=b.worker AND c.account=b.account AND c.action='order.open' AND c.status='succeeded'
        WHERE b.node=? AND b.worker=? AND b.account=? AND b.kind='position' AND b.ref=?""",
        (a["node_id"], a["worker_id"], a["name"], pid)).fetchone()
    if row and (row["closed"] or row["phase"] and a["phase"] and row["phase"] != a["phase"]):
        return None
    if not row and "tracked_position_id" not in a and (a.get("card_at") or 0) > (a.get("observed_at") or 0):
        return None
    return {**{k: s.get(k) for k in ("position_id", "symbol", "side", "quantity", "entry_price")},
            "take_profit": protection(s, "tp"), "stop_loss": protection(s, "sl"),
            "submitted_at": row["submitted_at"] if row else None}


def metrics(db, node_id):
    sql = "SELECT id,snapshot FROM nodes" + (" WHERE id=?" if node_id else "")
    rows = []
    for node in db.execute(sql, (node_id,) if node_id else ()):
        for a in json.loads(node["snapshot"])["accounts"]:
            card = a.get("card")
            if not card or not a["present"] or a["ambiguous"] or not (card.get("active_positions") or 0) > 0:
                continue
            if (a["card_at"] or 0) < (a.get("observed_at") or 0):
                continue
            rows.append({"node_id":node["id"], "worker_id":a["worker_id"], "name":a["name"],
                         "card_id":card.get("id"), "position_id":a.get("tracked_position_id", a["snapshot"].get("position_id")),
                         "at":a["card_at"], **{k:card.get(k) for k in
                         ("active_positions","pnl","drawdown","drawdown_limit","daily_loss","daily_limit")}})
    return {"items": rows}
