import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from .protocol import PENDING, WRITE, dump, require
from .trading_day import entry_day_window


class Database:
    def __init__(self, path):
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=10)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS commands(
                id TEXT PRIMARY KEY, node TEXT NOT NULL, worker TEXT NOT NULL, account TEXT, action TEXT NOT NULL,
                body TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL,
                claimed REAL, result TEXT, error TEXT NOT NULL DEFAULT '', intents TEXT NOT NULL DEFAULT '{}',
                cancel INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS commands_route ON commands(node,worker,account,status);
            CREATE INDEX IF NOT EXISTS commands_status ON commands(status,created);
            CREATE INDEX IF NOT EXISTS commands_account_ref ON commands(COALESCE(json_extract(body,'$.account_ref'),account),created);
        """)

    @contextmanager
    def tx(self):
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
                self.conn.commit()
            except BaseException:
                self.conn.rollback()
                raise

    def close(self):
        with self.lock:
            self.conn.close()

    @contextmanager
    def read(self):
        # WAL readers use a consistent snapshot without holding the controller's command lock.
        if str(self.path) == ":memory:":
            with self.tx() as db:
                yield db
            return
        db = sqlite3.connect(Path(self.path).resolve().as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN")
            yield db
        finally:
            db.close()


def find_command(db, key):
    return db.execute("SELECT * FROM commands WHERE id=?", (key,)).fetchone()


def command(db, key):
    row = find_command(db, key)
    require(row, "找不到该指令", 404)
    return row


def record(row):
    return {**json.loads(row["body"]), "status": row["status"], "updated_at": row["updated"],
            "claimed_at": row["claimed"], "error": row["error"], "intents": json.loads(row["intents"]),
            "result": json.loads(row["result"]) if row["result"] else None, "cancel_requested": bool(row["cancel"])}


def summary(row):
    return {**json.loads(row["body"]), "status": row["status"], "updated_at": row["updated"],
            "error": row["error"], "cancel_requested": bool(row["cancel"])}


def insert(db, cmd, status, now):
    db.execute("""INSERT INTO commands(id,node,worker,account,action,body,status,created,updated)
                  VALUES(?,?,?,?,?,?,?,?,?)""", (cmd["id"], cmd["node_id"], cmd["worker_id"], cmd["account"],
                  cmd["action"], dump(cmd), status, cmd["created_at"], now))


def finish(db, key, status, now, error="", result=None):
    db.execute("UPDATE commands SET status=?,updated=?,error=?,result=?,cancel=0 WHERE id=?",
               (status, now, error, dump(result) if result is not None else None, key))


def check_reservations(db, cmd, now, *, shared=False):
    if cmd["action"] not in WRITE:
        return
    start = entry_day_window(now)["start"]
    scope = "(node=? AND worker=? AND account=?)"
    args = [cmd["node_id"], cmd["worker_id"], cmd["account"]]
    if shared:
        scope = "(" + scope + " OR COALESCE(json_extract(body,'$.account_ref'),account)=?)"
        args.append(cmd["account_ref"])
    rows = db.execute("SELECT * FROM commands WHERE " + scope + """ AND id!=?
        AND (status IN ('pending','sending','queued','running','unknown') OR created>=?)""", (*args, cmd["id"], start))
    for row in rows:
        if row["action"] not in WRITE:
            continue
        require(row["status"] not in PENDING | {"unknown"}, "账户已有未完成或待核验指令", 409)
        if row["action"] == cmd["action"] == "order.open" and row["created"] >= start:
            previous = record(row)
            if previous["phase"] and cmd["phase"] and previous["phase"] != cmd["phase"]:
                continue
            used = row["status"] == "succeeded" or (row["status"] == "resolved" and previous["result"]["executed"])
            require(not used, "本账户在当前阶段和美东交易日已开仓", 409)
