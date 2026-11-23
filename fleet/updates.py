"""Center-issued, node-scoped software deployments, independent of browser command leases."""
import json
import re

from . import reporting
from .protocol import choice, dump, fields, ident, require, string


def revision(value):
    require(isinstance(value, str) and re.fullmatch("[0-9a-f]{40}", value), "需要完整的 40 位小写 Git 提交 SHA")
    return value


ACTIVE = "('queued','dispatched','preparing','applying')"


def schema(conn):
    conn.executescript(f"""
        CREATE TABLE IF NOT EXISTS node_updates(
            node TEXT NOT NULL REFERENCES nodes(id), id TEXT NOT NULL, revision TEXT NOT NULL,
            state TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL, actual TEXT NOT NULL DEFAULT '',
            detail TEXT NOT NULL DEFAULT '', expected TEXT NOT NULL DEFAULT '[]', confirmed TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY(node,id));
        CREATE INDEX IF NOT EXISTS update_history ON node_updates(node,created DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS one_active_update ON node_updates(node) WHERE state IN {ACTIVE};
        CREATE TABLE IF NOT EXISTS node_agents(node TEXT PRIMARY KEY REFERENCES nodes(id), seen REAL NOT NULL, actual TEXT NOT NULL);
    """)


def view(row):
    return {**dict(row), "expected": json.loads(row["expected"]), "confirmed":json.loads(row["confirmed"])}


def active(db, nid):
    return db.execute("SELECT * FROM node_updates WHERE node=? AND state IN " + ACTIVE, (nid,)).fetchone()


def create(db, nid, key, body, now):
    fields(body, ("revision",))
    target = revision(body.get("revision"))
    require(db.execute("SELECT 1 FROM nodes WHERE id=?", (nid,)).fetchone(), "找不到该节点", 404)
    old = db.execute("SELECT * FROM node_updates WHERE node=? AND id=?", (nid,key)).fetchone()
    if old:
        require(old["revision"] == target, "更新 ID 已用于其他版本", 409)
        return view(old)
    require(not active(db,nid), "该节点已有进行中的更新", 409)
    db.execute("INSERT INTO node_updates(node,id,revision,state,created,updated) VALUES(?,?,?,'queued',?,?)",
               (nid,key,target,now,now))
    reporting.log(db,nid,now,"update",f"中心下达更新 {key} · {target}")
    return view(db.execute("SELECT * FROM node_updates WHERE node=? AND id=?", (nid,key)).fetchone())


def cancel(db, nid, key, now):
    row = db.execute("SELECT * FROM node_updates WHERE node=? AND id=?", (nid,key)).fetchone()
    require(row, "找不到更新指令", 404)
    require(row["state"] in ("queued","cancelled"), "节点已领取更新指令", 409)
    if row["state"] == "queued":
        db.execute("UPDATE node_updates SET state='cancelled',updated=? WHERE node=? AND id=?", (now,nid,key))
        reporting.log(db,nid,now,"update","撤销待领取更新 " + key)
    return {"state":"cancelled"}


def agent(db, nid, op, body, now):
    node = db.execute("SELECT instance_id FROM nodes WHERE id=?", (nid,)).fetchone()
    require(node and node[0] and node[0] == ident(body.get("instance_id")), "等待中心核对原节点桥数据库身份", 409)
    actual = body.get("actual", "")
    if actual != "":
        revision(actual)
    db.execute("""INSERT INTO node_agents VALUES(?,?,?) ON CONFLICT(node) DO UPDATE SET
               seen=excluded.seen,actual=excluded.actual""",(nid,now,actual))
    if op == "poll":
        fields(body, ("instance_id","actual"))
        row = active(db,nid)
        if row and row["state"] == "queued":
            busy = db.execute("SELECT 1 FROM commands WHERE node=? AND status IN ('pending','sending','queued','running') LIMIT 1", (nid,)).fetchone()
            if busy:
                return {"job":None}
            db.execute("""UPDATE node_updates SET state='superseded',updated=? WHERE node=? AND state='installed'""",(now,nid))
            db.execute("UPDATE node_updates SET state='dispatched',updated=? WHERE node=? AND id=?", (now,nid,row["id"]))
            reporting.log(db,nid,now,"update","节点已领取更新 " + row["id"])
        return {"job":{"id":row["id"],"revision":row["revision"]} if row else None}
    require(op == "report", "接口不存在", 404)
    fields(body, ("instance_id","actual","id","revision","state","detail","expected"))
    key = ident(body.get("id"))
    row = db.execute("SELECT * FROM node_updates WHERE node=? AND id=?", (nid,key)).fetchone()
    require(row and row["revision"] == revision(body.get("revision")), "回执与节点更新指令不匹配", 409)
    state = choice(body.get("state"), {"preparing","applying","installed","failed","rolled_back"}, "更新状态")
    detail = string(body.get("detail",""), "更新结果", 500, True)
    expected = body.get("expected", [])
    require(isinstance(expected,list) and len(expected)<=1000, "浏览器清单无效")
    expected = sorted({ident(w) for w in expected})
    if row["state"] in ("installed","succeeded","failed","rolled_back"):
        require(row["state"] == state or (row["state"],state) == ("succeeded","installed"), "更新已结清", 409)
        return {"state":row["state"]}
    require(row["state"] in ("dispatched","preparing","applying"), "更新尚未派发", 409)
    if row["state"] == "applying" and state == "preparing":
        return {"state":row["state"]}
    require(state != "installed" or actual == row["revision"], "已安装版本与目标不符", 409)
    if row["state"] != state or row["detail"] != detail:
        db.execute("UPDATE node_updates SET state=?,actual=?,detail=?,expected=?,updated=? WHERE node=? AND id=?",
                   (state,actual,detail,dump(expected),now,nid,key))
        reporting.log(db,nid,now,"update",f"{key} · {state} · {detail}", "warning" if state in ("failed","rolled_back") else "info")
    return {"state":state}


def confirm(db, nid, snap, now, worker_ttl):
    row = db.execute("SELECT * FROM node_updates WHERE node=? AND state='installed'", (nid,)).fetchone()
    if not row or snap.get("release") != row["revision"]:
        return
    known = set(json.loads(row["confirmed"]))
    newly_seen = {w["worker_id"] for w in snap["workers"] if w.get("release") == row["revision"]
                  and w["last_seen"] >= row["updated"] and now-w["last_seen"] < worker_ttl}
    loaded = known | newly_seen
    if loaded and set(json.loads(row["expected"])) <= loaded:
        db.execute("UPDATE node_updates SET state='succeeded',updated=?,confirmed=? WHERE node=? AND id=?",
                   (now,dump(sorted(loaded)),nid,row["id"]))
        reporting.log(db,nid,now,"update","节点桥和浏览器插件均已确认目标版本 " + row["revision"])
    elif loaded != known:
        db.execute("UPDATE node_updates SET confirmed=? WHERE node=? AND id=?",(dump(sorted(loaded)),nid,row["id"]))
