"""Controller inventory, durable command delivery and per-node strategy scheduling."""
import json
import logging
import random
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from . import ledger, reporting, updates

from .protocol import (NODE_TTL, OBS_TTL, PENDING, RUN_TTL, TERMINAL, WORKER_TTL, WRITE, Problem, boolean,
                       bridge_url, choice, dump, fields, ident, make_command, number, obj, parameters,
                       request, require, string, validate_target)
from .storage import Database, check_reservations, command, find_command, finish, insert, record, summary


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def remote(node, method, path, data=None):
    payload = dump(data).encode() if data is not None else None
    req = Request(node["url"] + path, data=payload, method=method, headers={
        "Authorization": "Bearer " + node["token"], "Content-Type": "application/json"})
    try:
        with build_opener(NoRedirect).open(req, timeout=4) as response:
            raw = response.read(8_000_001)
            require(len(raw) <= 8_000_000, "节点响应过大", 502)
            return obj(json.loads(raw))
    except HTTPError as err:
        raise Problem(f"节点接口返回 HTTP {err.code}", 502) from err
    except (OSError, ValueError) as err:
        raise Problem("节点连接失败，请检查地址、证书和网络", 502) from err


def uid():
    return str(uuid.uuid4())


DEFAULT_CONFIG = {"batch_size": 1, "interval_seconds": 60, "side": "random", "size_percent": 25,
                  "stop_loss": 130, "take_profit": None}


def initial_strategy(nid):
    return {"node_id": nid, "enabled": False, "run": None, "batch": 0, "members": [], "next_at": 0,
            "message": "尚未启动", "config": dict(DEFAULT_CONFIG), "draining": False}


class Center:
    def __init__(self, path, clock=time.time, transport=remote):
        self.db = Database(path)
        self.clock, self.transport = clock, transport
        self.db.conn.executescript("""
            CREATE TABLE IF NOT EXISTS nodes(
                id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL UNIQUE, token TEXT NOT NULL,
                instance_id TEXT, snapshot TEXT NOT NULL DEFAULT '{"workers":[],"accounts":[]}',
                last_seen REAL, error TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS account_config(node TEXT,worker TEXT,name TEXT,alias TEXT,note TEXT,
                enabled INTEGER NOT NULL,in_pool INTEGER NOT NULL,account_ref TEXT NOT NULL DEFAULT '',PRIMARY KEY(node,worker,name));
            CREATE TABLE IF NOT EXISTS node_strategy(node TEXT PRIMARY KEY REFERENCES nodes(id), data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS ledger_cursor(node TEXT PRIMARY KEY REFERENCES nodes(id), seq INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS log_cursor(node TEXT PRIMARY KEY REFERENCES nodes(id), seq INTEGER NOT NULL);
        """)
        ledger.schema(self.db.conn)
        reporting.log_schema(self.db.conn)
        updates.schema(self.db.conn)
        with self.db.tx() as db:
            columns = {r["name"] for r in db.execute("PRAGMA table_info(nodes)")}
            for col in ("history_error","log_error"):
                if col not in columns:
                    db.execute(f"ALTER TABLE nodes ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
            if "account_ref" not in {r["name"] for r in db.execute("PRAGMA table_info(account_config)")}:
                db.execute("ALTER TABLE account_config ADD COLUMN account_ref TEXT NOT NULL DEFAULT ''")
            self._migrate_strategies(db)
            ledger.backfill(db)

    def _migrate_strategies(self, db):
        old = None
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='strategy'").fetchone():
            row = db.execute("SELECT data FROM strategy WHERE id=1").fetchone()
            old = json.loads(row[0]) if row else None
        count = db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        for row in db.execute("SELECT id FROM nodes WHERE id NOT IN (SELECT node FROM node_strategy)").fetchall():
            nid = row["id"]
            s = initial_strategy(nid)
            if old:
                s.update(old)
                s["members"] = [k for k in old["members"] if command(db, k)["node"] == nid]
                if count > 1:
                    s["draining"] = bool(old["enabled"] and s["members"])
                    s["enabled"] = s["draining"]
                    s["message"] = "跟踪升级前的批次" if s["draining"] else "已迁移参数，等待按节点启动"
                reporting.log(db, nid, self.clock(), "strategy", s["message"])
            db.execute("INSERT INTO node_strategy VALUES(?,?)", (nid, dump(s)))

    def configure_node(self, key, body):
        key = ident(key)
        fields(body, ("label", "url", "token"))
        label, url = string(body.get("label"), "节点名称", 80), bridge_url(body.get("url"))
        with self.db.tx() as db:
            prior = db.execute("SELECT * FROM nodes WHERE id=?", (key,)).fetchone()
            token = body.get("token") or (prior and prior["token"])
            require(isinstance(token, str) and token.isascii() and token.isprintable() and
                    token.strip() == token and 24 <= len(token) <= 512, "节点通信密钥至少需要 24 个 ASCII 字符")
            require(not db.execute("SELECT 1 FROM nodes WHERE url=? AND id!=?", (url, key)).fetchone(), "该地址已登记", 409)
            require(not db.execute("SELECT 1 FROM nodes WHERE token=? AND id!=?", (token, key)).fetchone(),
                    "每个节点需要独立的通信密钥", 409)
            db.execute("""INSERT INTO nodes(id,label,url,token) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                label=excluded.label,url=excluded.url,token=excluded.token,revision=nodes.revision+1,
                last_seen=NULL,error=''""", (key, label, url, token))
            db.execute("INSERT OR IGNORE INTO node_strategy VALUES(?,?)", (key, dump(initial_strategy(key))))
            reporting.log(db, key, self.clock(), "node", "更新服务器配置" if prior else "登记服务器")
        return {"id": key}

    def _inventory(self, db, nid=None):
        now = self.clock()
        args = (nid,) if nid else ()
        configs = {(r["node"], r["worker"], r["name"]): r for r in db.execute("SELECT * FROM account_config" + (" WHERE node=?" if nid else ""), args)}
        nodes, workers, accounts = {}, {}, {}
        for row in db.execute("SELECT * FROM nodes" + (" WHERE id=?" if nid else "") + " ORDER BY label,id", args):
            nid = row["id"]
            online = bool(row["last_seen"] and now - row["last_seen"] < NODE_TTL and not row["error"])
            node = {k: row[k] for k in ("id", "label", "url", "instance_id", "last_seen", "error", "history_error", "log_error")}
            snap = json.loads(row["snapshot"])
            last = db.execute("SELECT * FROM node_updates WHERE node=? ORDER BY created DESC,rowid DESC LIMIT 1", (nid,)).fetchone()
            agent = db.execute("SELECT seen,actual FROM node_agents WHERE node=?", (nid,)).fetchone()
            nodes[nid] = {**node, "online": online, "release":snap.get("release",""), "agent_seen":agent["seen"] if agent else None,
                          "agent_release":agent["actual"] if agent else "", "update":updates.view(last) if last else None}
            for w in snap["workers"]:
                workers[nid, w["worker_id"]] = {**w, "node_id": nid, "online": online and now - w["last_seen"] < WORKER_TTL}
            for a in snap["accounts"]:
                key = (nid, a["worker_id"], a["name"])
                cfg = configs.get(key)
                accounts[key] = {**a, "node_id": nid, "alias": cfg["alias"] if cfg else "",
                                 "note": cfg["note"] if cfg else "", "enabled": bool(cfg["enabled"]) if cfg else True,
                                 "in_pool": bool(cfg and cfg["in_pool"]), "account_ref": cfg["account_ref"] if cfg else "",
                                 "fresh": bool(workers[key[:2]]["online"] and a.get("read_session") == a.get("listed_session") == workers[key[:2]]["session_id"]
                                               and a["present"] and not a["read_error"]
                                               and a["observed_at"] and now - a["observed_at"] <= OBS_TTL)}
        return nodes, workers, accounts

    def state(self, node_id=None):
        with self.db.tx() as db:
            nodes, workers, accounts = self._inventory(db, node_id)
            require(not node_id or node_id in nodes, "找不到该节点", 404)
            cond, args = (" WHERE node=?", (node_id,)) if node_id else ("", ())
            recent = db.execute("SELECT * FROM commands"+cond+" ORDER BY created DESC,id DESC LIMIT 100", args)
            unknown = db.execute("SELECT COUNT(*) FROM commands WHERE status='unknown'"+(" AND node=?" if node_id else ""), args).fetchone()[0]
            strategies = [json.loads(r[0]) for r in db.execute("SELECT data FROM node_strategy"+cond+" ORDER BY node", args)]
            return dict(now=self.clock(), nodes=list(nodes.values()), workers=list(workers.values()),
                        accounts=list(accounts.values()), strategies=strategies, strategy=strategies[0] if len(strategies)==1 else None,
                        unknown_count=unknown, commands=[summary(r) for r in recent])

    def history(self, status="", offset=0, node_id=None):
        if status:
            choice(status, TERMINAL | PENDING, "状态筛选")
        offset = number(offset, "偏移量", 0, 2**31, True)
        clauses = [(k,v) for k,v in (("status", status), ("node", node_id)) if v]
        where = " WHERE " + " AND ".join(k+"=?" for k,v in clauses) if clauses else ""
        args = [v for k,v in clauses]
        with self.db.tx() as db:
            total = db.execute("SELECT COUNT(*) FROM commands" + where, args).fetchone()[0]
            rows = db.execute("SELECT * FROM commands" + where + " ORDER BY created DESC,id DESC LIMIT 50 OFFSET ?", (*args, offset))
            return {"total": total, "items": [summary(r) for r in rows]}

    def agent_secret(self, nid):
        with self.db.tx() as db:
            row = db.execute("""SELECT token FROM nodes AS n WHERE id=? AND NOT EXISTS
                             (SELECT 1 FROM nodes WHERE id!=n.id AND token=n.token)""", (nid,)).fetchone()
            return row[0] if row else None

    def agent(self, nid, op, body):
        with self.db.tx() as db:
            return updates.agent(db, nid, op, body, self.clock())

    def deployment(self, nid, key, op, body):
        with self.db.tx() as db:
            if op == "create":
                return updates.create(db,nid,key,body,self.clock())
            if op == "cancel":
                return updates.cancel(db,nid,key,self.clock())
            row = db.execute("SELECT * FROM node_updates WHERE node=? AND id=?", (nid,key)).fetchone()
            require(row, "找不到更新指令", 404)
            return updates.view(row)

    def logs(self, nid, level="", offset=0):
        with self.db.tx() as db:
            self._strategy(db, nid)
            return reporting.logs(db, nid, level, offset)

    def analytics(self, query):
        with self.db.read() as db:
            return reporting.analytics(db, query)

    def _cancel(self, db, row):
        if row["status"] == "pending":
            finish(db, row["id"], "cancelled", self.clock(), "中心已取消")
        elif row["status"] in ("sending", "queued"):
            db.execute("UPDATE commands SET cancel=1,updated=? WHERE id=? AND cancel=0", (self.clock(), row["id"]))

    def account_config(self, body):
        fields(body, ("node_id", "worker_id", "account", "alias", "note", "enabled", "in_pool", "account_ref"))
        route = (ident(body.get("node_id")), ident(body.get("worker_id")), string(body.get("account"), "账户名"))
        with self.db.tx() as db:
            a = self._inventory(db, route[0])[2].get(route)
            require(a, "找不到该账户", 404)
            alias, note = string(body.get("alias", a["alias"]), "别名", 80, True), string(body.get("note", a["note"]), "备注", 500, True)
            enabled, pool = boolean(body.get("enabled", a["enabled"])), boolean(body.get("in_pool", a["in_pool"]))
            ref = string(body.get("account_ref", a["account_ref"]), "交易账户标识", empty=True)
            require(not pool or not a["excluded"], "主账户不能加入策略池")
            db.execute("INSERT OR REPLACE INTO account_config VALUES(?,?,?,?,?,?,?,?)", (*route, alias, note, enabled, pool, ref))
            reporting.log(db, route[0], self.clock(), "account", "更新账户设置", worker=route[1], account=route[2])
            for row in db.execute("SELECT * FROM commands WHERE node=? AND worker=? AND account=?", route).fetchall():
                if ref != a["account_ref"] and row["action"] in WRITE:
                    require(row["status"] not in PENDING | {"unknown"}, "账户有未完成的资金指令，暂时无法更换交易标识", 409)
                if row["action"] in WRITE and (not enabled or not pool and json.loads(row["body"])["source"] != "manual"):
                    self._cancel(db, row)
        return {"ok": True}

    def _prepare(self, db, key, req, inventory, source="manual"):
        nodes, workers, accounts = inventory
        route = (req["node_id"], req["worker_id"])
        node, worker = nodes.get(route[0]), workers.get(route)
        require(node and node["online"] and worker and worker["online"], "节点或浏览器离线", 409)
        require(not updates.active(db,route[0]), "节点正在等待或执行软件更新", 409)
        require(not node["agent_release"] or node["agent_release"] == node["release"], "等待同步节点桥的新版本", 409)
        require(not node["release"] or worker.get("release") == node["release"], "浏览器尚未加载当前节点版本", 409)
        a = accounts.get((*route, req["account"]))
        require(req["action"] not in WRITE or a and a["enabled"], "账户已停用或不存在", 409)
        cmd = make_command(key, req, node, worker, a, self.clock(), source)
        validate_target(cmd, worker, a, self.clock())
        check_reservations(db, cmd, self.clock(), shared=True)
        return cmd

    def submit(self, key, body):
        req = request(body)
        with self.db.tx() as db:
            prior = find_command(db, ident(key))
            if prior:
                old = json.loads(prior["body"])
                require(old["source"] == "manual" and all(old[k] == v for k, v in req.items()), "该 ID 已用于其他指令", 409)
            else:
                cmd = self._prepare(db, key, req, self._inventory(db, req["node_id"]))
                insert(db, cmd, "pending", self.clock())
            return record(command(db, key))

    def get(self, key):
        with self.db.tx() as db:
            return record(command(db, ident(key)))

    def cancel(self, key):
        with self.db.tx() as db:
            row = command(db, ident(key))
            require(row["status"] in {"pending", "sending", "queued", "cancelled"}, "指令已被领取或结束", 409)
            self._cancel(db, row)
            return record(command(db, key))

    def _receipt(self, db, cmd, receipt):
        require(all(receipt.get(k) == v for k, v in cmd.items()), "节点回执与原始指令不符", 502)
        status = choice(receipt.get("status"), TERMINAL | {"queued", "running"}, "节点回执状态")
        previous = command(db, cmd["id"])
        if previous["status"] in TERMINAL and previous["status"] != "unknown" and previous["status"] != status:
            return
        if previous["status"] == "running" and status == "queued":
            return
        db.execute("""UPDATE commands SET status=?,result=?,error=?,claimed=?,intents=?,updated=?,
                   cancel=CASE WHEN ?='queued' THEN cancel ELSE 0 END WHERE id=?""",
                   (status, dump(receipt.get("result")), receipt.get("error", ""), receipt.get("claimed_at"),
                    dump(receipt.get("intents", {})), receipt["updated_at"], status, cmd["id"]))
        if status == "succeeded":
            ledger.command_evidence(db, receipt)

    def resolve(self, key, body):
        key = ident(key)
        payload = {"executed": boolean(body.get("executed")), "note": string(body.get("note"), "核验说明", 500)}
        with self.db.tx() as db:
            row = command(db, key)
            require(row["status"] in ("unknown", "resolved"), "仅可处理待核验指令", 409)
            cmd = json.loads(row["body"])
            node = dict(db.execute("SELECT * FROM nodes WHERE id=?", (row["node"],)).fetchone())
        reply = self.transport(node, "POST", f"/v1/commands/{key}/resolve", {**payload, "instance_id": cmd["instance_id"]})
        with self.db.tx() as db:
            self._receipt(db, cmd, reply)
            return record(command(db, key))

    def sync(self, nid):
        with self.db.tx() as db:
            node = dict(db.execute("SELECT * FROM nodes WHERE id=?", (nid,)).fetchone())
        try:
            snap = self.transport(node, "GET", "/v1/status")
            require(snap.get("version") == 1 and snap.get("node_id") == nid and
                    isinstance(snap.get("workers"), list) and isinstance(snap.get("accounts"), list),
                    "节点 ID 或协议版本不匹配", 502)
            worker_ids = set()
            for w in snap["workers"]:
                obj(w)
                worker_ids.add(ident(w.get("worker_id")))
                ident(w.get("session_id"))
                choice(w.get("mode"), {"readonly", "execute"}, "浏览器模式")
                number(w.get("last_seen"), "浏览器心跳", 0, 1e11)
            for a in snap["accounts"]:
                obj(a)
                require(a.get("worker_id") in worker_ids and isinstance(a.get("snapshot"), dict) and
                        all(k in a for k in ("name","present","ambiguous","excluded","category","phase","read_error","observed_at")),
                        "节点返回的账户结构不完整", 502)
                if a["observed_at"] is not None:
                    number(a["observed_at"], "读取时间", 0, 1e11)
            instance = ident(snap.get("instance_id"))
            require(not node["instance_id"] or node["instance_id"] == instance, "节点数据库身份已改变，请核对并使用新的节点 ID 登记", 409)
            with self.db.tx() as db:
                updated = db.execute("""UPDATE nodes SET snapshot=?,instance_id=?,last_seen=?,error=''
                                      WHERE id=? AND revision=?""", (dump(snap), instance, self.clock(), nid, node["revision"]))
                if not updated.rowcount:
                    return
                updates.confirm(db,nid,snap,self.clock(),WORKER_TTL)
                if not node["last_seen"] or node["error"] or self.clock()-node["last_seen"] >= NODE_TTL:
                    reporting.log(db, nid, self.clock(), "connection", "节点已连接")
                old_workers = {w["worker_id"]: w for w in json.loads(node["snapshot"])["workers"]}
                for w in snap["workers"]:
                    old = old_workers.get(w["worker_id"], {})
                    live = self.clock()-w["last_seen"] < WORKER_TTL
                    was_live = bool(old and node["last_seen"] and node["last_seen"]-old["last_seen"] < WORKER_TTL)
                    legacy_change = "log_seq" not in snap and (not old or old.get("mode") != w["mode"] or old.get("error") != w.get("error"))
                    if legacy_change or old and live != was_live:
                        mode = "执行" if w["mode"] == "execute" else "只读"
                        message = w.get("error") or ("浏览器在线 · "+mode if live else "浏览器离线")
                        reporting.log(db, nid, self.clock(), "browser", message,
                                      "warning" if w.get("error") or not live else "info", worker=w["worker_id"])
                todo = [r[0] for r in db.execute("""SELECT id FROM commands WHERE node=? AND
                        status IN ('pending','sending','queued','running','unknown') ORDER BY created,id""", (nid,))]
            for key in todo:
                with self.db.tx() as db:
                    row = command(db, key)
                    cmd = json.loads(row["body"])
                    if row["status"] not in PENDING | {"unknown"}:
                        continue
                    if row["status"] == "pending" and self.clock() >= cmd["expires_at"]:
                        finish(db, key, "expired", self.clock(), "送达前过期")
                        continue
                    cancel = bool(row["cancel"]) or row["status"] == "unknown"
                    # Commit before network I/O. All delivery attempts use the same envelope and ID.
                    put = row["status"] in ("pending", "sending") or cancel
                    if row["status"] == "pending":
                        db.execute("UPDATE commands SET status='sending',updated=? WHERE id=?", (self.clock(), key))
                path = f"/v1/commands/{key}" + ("/cancel" if cancel else "")
                reply = self.transport(node, "PUT" if put else "GET", path, cmd if put else None)
                with self.db.tx() as db:
                    self._receipt(db, cmd, reply)
            for stream, high_key, err_col, label in (("ledger","ledger_seq","history_error","历史"),
                                                     ("logs","log_seq","log_error","运行日志")):
                if high_key not in snap:
                    continue
                reason = ""
                try:
                    self._sync_stream(node, instance, stream, snap[high_key])
                except (Problem, OSError, ValueError, TypeError, KeyError) as err:
                    reason = str(err)[:300]
                if reason != node[err_col]:
                    with self.db.tx() as db:
                        if db.execute(f"UPDATE nodes SET {err_col}=? WHERE id=? AND revision=?", (reason,nid,node["revision"])).rowcount:
                            event = "history" if stream == "ledger" else "log_sync"
                            reporting.log(db, nid, self.clock(), event, label+("同步异常 · "+reason if reason else "同步恢复"),
                                          "warning" if reason else "info")
        except (Problem, OSError, ValueError) as err:
            with self.db.tx() as db:
                reason = str(err)[:300]
                if db.execute("UPDATE nodes SET error=? WHERE id=? AND revision=? AND error!=?",
                              (reason, nid, node["revision"], reason)).rowcount:
                    reporting.log(db, nid, self.clock(), "connection", reason, "error")

    def _sync_stream(self, node, instance, stream, high):
        nid = node["id"]
        table = "ledger_cursor" if stream == "ledger" else "log_cursor"
        high = number(high, "节点同步序号", 0, 2**63-1, True)
        for _ in range(4):
            with self.db.tx() as db:
                cursor = db.execute(f"SELECT seq FROM {table} WHERE node=?", (nid,)).fetchone()
                after = cursor[0] if cursor else 0
            if after >= high:
                return
            reply = self.transport(node, "GET", f"/v1/{stream}?after={after}")
            require(reply.get("node_id") == nid and reply.get("instance_id") == instance, "数据来源与节点不符", 502)
            items = reply.get("items")
            require(isinstance(items, list) and 0 < len(items) <= 200, "增量分页无效", 502)
            with self.db.tx() as db:
                if not db.execute("SELECT 1 FROM nodes WHERE id=? AND instance_id=? AND revision=?",
                                  (nid,instance,node["revision"])).fetchone():
                    return
                cursor = db.execute(f"SELECT seq FROM {table} WHERE node=?", (nid,)).fetchone()
                consumed = cursor[0] if cursor else 0
                last = after
                for item in items:
                    last = number(obj(item).get("seq"), "同步序号", last+1, 2**63-1, True)
                    if last <= consumed:
                        continue
                    if stream == "logs":
                        reporting.import_event(db, nid, item)
                        continue
                    route = (nid, ident(item.get("worker")), string(item.get("account"), "历史账户"))
                    kind = choice(item.get("kind"), {"position","order","withdrawal","payout"}, "历史类型")
                    ledger.save(db, route, kind, string(item.get("ref"), "历史编号", 350), obj(item.get("data")))
                db.execute(f"""INSERT INTO {table} VALUES(?,?) ON CONFLICT(node) DO UPDATE
                           SET seq=MAX(seq,excluded.seq)""", (nid, last))

    @staticmethod
    def _strategy(db, nid):
        row = db.execute("SELECT data FROM node_strategy WHERE node=?", (nid,)).fetchone()
        require(row, "找不到该节点", 404)
        return json.loads(row[0])

    def _save_strategy(self, db, strategy, event=None):
        nid = strategy["node_id"]
        updated = db.execute("UPDATE node_strategy SET data=? WHERE node=? AND data!=?", (dump(strategy), nid, dump(strategy)))
        if updated.rowcount:
            reporting.log(db, nid, self.clock(), "strategy", event or strategy["message"],
                          "warning" if "暂停" in strategy["message"] else "info")
        return strategy

    def _pause(self, db, s, message):
        s.update(enabled=False, draining=False, message=message)
        for key in s["members"]:
            row = command(db, key)
            if row["node"] == s["node_id"]:
                self._cancel(db, row)

    def strategy(self, op, body, node_id=None):
        with self.db.tx() as db:
            if node_id is None:
                nodes = db.execute("SELECT id FROM nodes LIMIT 2").fetchall()
                require(len(nodes) == 1, "请选择要操作的节点", 409)
                node_id = nodes[0]["id"]
            s = self._strategy(db, node_id)
            if op == "stop":
                self._pause(db, s, "策略已停止")
            elif op == "start":
                if s["enabled"]:
                    return s
                # A stopped, partially delivered batch must finish before another run.
                for key in s["members"]:
                    require(command(db, key)["status"] not in PENDING | {"unknown"}, "上一批仍有未结束的指令", 409)
                s.update(enabled=True, draining=False, run=uid(), batch=0, members=[], next_at=self.clock(), message="等待可用账户")
            elif op == "config":
                require(not s["enabled"], "请先停止策略再修改参数", 409)
                fields(body, DEFAULT_CONFIG)
                c = {**s["config"], **body}
                number(c["batch_size"], "每批账户数", 1, 100, True)
                c["batch_size"] = int(c["batch_size"])
                number(c["interval_seconds"], "批间等待秒数", 1, 86400, True)
                choice(c["side"], {"buy", "sell", "random"}, "策略方向")
                parameters("order.open", {**{k: c[k] for k in ("size_percent", "stop_loss", "take_profit")}, "side": "buy"})
                s["config"] = c
            else:
                raise Problem("接口不存在", 404)
            return self._save_strategy(db, s, {"start":"策略已启动","stop":"策略已停止","config":"更新策略参数"}[op])

    def decide(self):
        with self.db.tx() as db:
            now = self.clock()
            db.execute("""UPDATE commands SET status='expired',updated=?,error='送达前过期' WHERE status='pending'
                       AND json_extract(body,'$.expires_at')<=?""", (now, now))
            db.execute("""UPDATE commands SET status='unknown',updated=?,cancel=0,error='节点失联，资金操作回执待核验'
                WHERE status IN ('sending','queued','running') AND action IN ('order.open','order.close','position.protect','profit.withdraw')
                AND MAX(json_extract(body,'$.expires_at'),COALESCE(claimed,0))+?<=?
                AND node IN (SELECT id FROM nodes WHERE error!='' OR last_seen IS NULL OR last_seen<=?)""",
                (now, RUN_TTL, now, now - NODE_TTL))
            nodes = [r[0] for r in db.execute("SELECT node FROM node_strategy WHERE json_extract(data,'$.enabled')=1")]
        for nid in nodes:
            try:
                with self.db.tx() as db:
                    s = self._strategy(db, nid)
                    if s["enabled"] and now >= s["next_at"]:
                        self._decide_node(db, s, self._inventory(db, nid), now)
            except Exception as err:
                logging.exception("节点 %s 策略调度失败", nid)
                with self.db.tx() as db:
                    s = self._strategy(db, nid)
                    self._pause(db, s, "节点策略异常，已暂停 · "+str(err)[:200])
                    self._save_strategy(db, s)

    def _decide_node(self, db, s, inventory, now):
        if s["members"]:
            members = [record(command(db, k)) for k in s["members"]]
            failed = next((m for m in members if m["status"] in TERMINAL and m["status"] != "succeeded"), None)
            if failed:
                self._pause(db, s, f"第 {s['batch']} 批已暂停 · {failed['error'] or failed['status']}")
            elif all(m["status"] == "succeeded" for m in members):
                for m in members:
                    a = inventory[2].get((m["node_id"], m["worker_id"], m["account"]))
                    if not a or not a["fresh"] or a["snapshot"].get("position_open") is not False or a["observed_at"] <= m["updated_at"]:
                        s["message"] = "等待本批全部持仓确认结束"
                        break
                else:
                    if s.get("draining"):
                        s.update(enabled=False, draining=False, members=[], message="升级前的批次已结束")
                    else:
                        s.update(members=[], next_at=now + s["config"]["interval_seconds"], message="批间等待")
            self._save_strategy(db, s)
            return
        if updates.active(db, s["node_id"]):
            s["message"] = "等待节点完成软件更新"
            self._save_strategy(db, s)
            return
        config = s["config"]
        # The legacy random-entry policy draws one direction for the entire batch.
        side = random.choice(("buy", "sell")) if config["side"] == "random" else config["side"]
        params = {**{k: config[k] for k in ("size_percent", "stop_loss", "take_profit")}, "side": side}
        candidates = {}
        for (nid, wid, name), a in inventory[2].items():
            if not a["in_pool"] or not a["fresh"]:
                continue
            req = dict(node_id=nid, worker_id=wid, account=name, action="order.open", params=params)
            try:
                cmd = self._prepare(db, uid(), req, inventory, "strategy-" + s["run"])
                candidates.setdefault(cmd["account_ref"], []).append(cmd)
            except Problem:
                continue
        size = config["batch_size"]
        if len(candidates) < size:
            s["message"] = f"等待可用账户 · {len(candidates)} / {size}"
        else:
            batch = []
            for account_ref in random.sample(list(candidates), size):
                cmd = random.choice(candidates[account_ref])
                insert(db, cmd, "pending", now)
                batch.append(cmd["id"])
            s.update(batch=s["batch"] + 1, members=batch, message=f"第 {s['batch']+1} 批等待执行回执")
        self._save_strategy(db, s)

    def run(self, stop: threading.Event):
        active = {}
        with ThreadPoolExecutor(max_workers=12, thread_name_prefix="vest-node") as pool:
            while not stop.is_set():
                for nid, task in list(active.items()):
                    if task.done():
                        del active[nid]
                        try:
                            task.result()
                        except Exception:
                            logging.exception("节点 %s 同步失败", nid)
                with self.db.tx() as db:
                    nodes = [r[0] for r in db.execute("SELECT id FROM nodes")]
                for nid in nodes:
                    if nid not in active:
                        active[nid] = pool.submit(self.sync, nid)
                try:
                    self.decide()
                except Exception:
                    logging.exception("策略调度失败")
                stop.wait(2)
