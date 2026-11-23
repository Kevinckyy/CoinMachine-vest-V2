"""One durable public command mailbox and one local browser API per cloud node."""
import json
import os
import time
import uuid
from . import ledger, reporting, updates

from .protocol import (PHASES, PRIMARY, RUN_TTL, TERMINAL, WRITE, Problem, boolean, choice,
                       dump, ident, number, obj, request, require, string, validate_target)
from .storage import Database, check_reservations, command, find_command, finish, insert, record


def worker_view(row):
    return dict(row) if row else None


def account_view(row):
    if not row:
        return None
    return {**{k: row[k] for k in row.keys() if k != "tracked_position"}, "snapshot": json.loads(row["snapshot"]),
            **{key: bool(row[key]) for key in ("present", "ambiguous", "excluded")}}


def target(db, cmd):
    worker = db.execute("SELECT * FROM workers WHERE worker_id=?", (cmd["worker_id"],)).fetchone()
    account = db.execute("SELECT * FROM accounts WHERE worker_id=? AND name=?",
                         (cmd["worker_id"], cmd["account"])).fetchone()
    return worker_view(worker), account_view(account)


def verify_financial_receipt(cmd, result):
    """Only a page observation can complete a financial command."""
    action, params = cmd["action"], cmd["params"]
    obs = obj(result.get("observation"))
    snap = obj(obs.get("snapshot"))
    require(obs.get("name") == cmd["account"] and (not cmd["phase"] or obs.get("phase") == cmd["phase"]),
            "执行回执的账户或阶段不匹配")
    if action in ("order.open", "position.protect"):
        require(snap.get("position_open") is True and snap.get("position_id"), "回执未确认持仓")
        if action == "order.open":
            proof = cmd["intents"]["open"]["proof"]
            require(snap.get("symbol") == "NQ-PERP" and snap.get("side") == params["side"]
                    and snap.get("quantity") == proof.get("quantity") and snap.get("quantity", 0) > 0, "成交方向或数量未确认")
        else:
            require(all(snap.get(k) == v for k, v in cmd["expected_position"].items()), "修改保护的持仓不符")
        for key, report in (("stop_loss", "stop_check"), ("take_profit", "take_profit_check")):
            if action == "order.open" or key in params:
                expected = "verified" if params.get(key) is not None else "omitted"
                require(isinstance(snap.get(report), dict) and snap[report].get("status") == expected,
                        "回执未核验原生止盈止损")
    else:
        require(snap.get("position_open") is False, "执行回执未确认空仓")
        if action == "profit.withdraw":
            require(ledger.verified_withdrawal(cmd, result, snap), "主账户收款对象、申请金额或扣款余额未核验")


class Bridge:
    def __init__(self, path, node_id, clock=time.time):
        self.db = Database(path)
        self.node_id, self.clock = ident(node_id), clock
        self.release = os.environ.get("VEST_FLEET_RELEASE", "")
        self.launch_id = os.environ.get("VEST_FLEET_LAUNCH_ID", "")
        if self.release:
            updates.revision(self.release)
        self.db.conn.executescript("""
            CREATE TABLE IF NOT EXISTS identity(node_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS worker_build(worker_id TEXT PRIMARY KEY,release TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS update_gate(slot INTEGER PRIMARY KEY CHECK(slot=1),owner TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS workers(
                worker_id TEXT PRIMARY KEY, label TEXT NOT NULL, generation INTEGER NOT NULL,
                session_id TEXT NOT NULL, mode TEXT NOT NULL, last_seen REAL NOT NULL,
                page TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS accounts(
                worker_id TEXT NOT NULL REFERENCES workers(worker_id), name TEXT NOT NULL,
                category TEXT NOT NULL, phase TEXT, present INTEGER NOT NULL, ambiguous INTEGER NOT NULL,
                excluded INTEGER NOT NULL, snapshot TEXT NOT NULL DEFAULT '{}', observed_at REAL,
                read_error TEXT NOT NULL DEFAULT '', listed_session TEXT, read_session TEXT, PRIMARY KEY(worker_id,name)
            );
        """)
        ledger.schema(self.db.conn)
        reporting.log_schema(self.db.conn)
        with self.db.tx() as db:
            cols = {r["name"] for r in db.execute("PRAGMA table_info(accounts)")}
            for col in ("listed_session", "read_session", "tracked_position"):
                if col not in cols:
                    db.execute(f"ALTER TABLE accounts ADD COLUMN {col} TEXT")
            row = db.execute("SELECT * FROM identity").fetchone()
            if not row:
                db.execute("INSERT INTO identity VALUES(?,?)", (self.node_id, str(uuid.uuid4())))
                row = db.execute("SELECT * FROM identity").fetchone()
            require(row["node_id"] == self.node_id, "此数据库已属于另一个节点")
            self.instance_id = row["instance_id"]
            db.execute("UPDATE workers SET last_seen=0")
            ledger.backfill(db)
            if "tracked_position" not in cols:
                for a in db.execute("SELECT * FROM accounts WHERE present=1 AND ambiguous=0").fetchall():
                    snap = json.loads(a["snapshot"])
                    if snap.get("position_open") is True and snap.get("position_id") and snap.get("observed_at"):
                        confirmed = a["read_session"] and a["read_session"] == a["listed_session"]
                        phase = a["phase"] if confirmed else None
                        ledger.position_observation(db, (self.node_id, a["worker_id"], a["name"]), snap, phase)
                        if confirmed:
                            track = {"id":snap["position_id"], "phase":phase, "session":a["read_session"]}
                            db.execute("UPDATE accounts SET tracked_position=? WHERE worker_id=? AND name=?",
                                       (dump(track), a["worker_id"], a["name"]))

    def _expire(self, db, now):
        for row in db.execute("SELECT * FROM commands WHERE status IN ('queued','running')").fetchall():
            if row["status"] == "queued" and now >= json.loads(row["body"])["expires_at"]:
                finish(db, row["id"], "expired", now, "插件未在有效期内领取")
            elif row["status"] == "running" and now >= row["claimed"] + RUN_TTL:
                uncertain = bool(json.loads(row["intents"]))
                finish(db, row["id"], "unknown" if uncertain else "failed", now,
                       "执行回执超时，需核对平台" if uncertain else "执行超时，未签发资金操作许可")

    def status(self):
        with self.db.tx() as db:
            self._expire(db, self.clock())
            return {"version": 1, "node_id": self.node_id, "instance_id": self.instance_id, "release":self.release,
                    "launch_id": self.launch_id,
                    "ledger_seq": db.execute("SELECT COALESCE(MAX(seq),0) FROM book").fetchone()[0],
                    "log_seq": db.execute("SELECT COALESCE(MAX(id),0) FROM node_logs").fetchone()[0],
                    "workers": [worker_view(r) for r in db.execute("""SELECT w.*,COALESCE(b.release,'') AS release FROM workers w
                                LEFT JOIN worker_build b ON b.worker_id=w.worker_id ORDER BY label""")],
                    "accounts": [account_view(r) for r in db.execute("SELECT * FROM accounts ORDER BY worker_id,name")]}

    def ledger_page(self, after):
        after = number(after, "同步游标", 0, 2**63-1, True)
        with self.db.tx() as db:
            return {"node_id": self.node_id, "instance_id": self.instance_id, **ledger.page(db, after)}

    def log_page(self, after):
        after = number(after, "同步游标", 0, 2**63-1, True)
        with self.db.read() as db:
            rows = db.execute("""SELECT id AS seq,at,event,message,level,worker,account,command_id
                               FROM node_logs WHERE id>? ORDER BY id LIMIT 200""", (after,))
            return {"node_id": self.node_id, "instance_id": self.instance_id, "items":[dict(r) for r in rows]}

    def get(self, key):
        with self.db.tx() as db:
            self._expire(db, self.clock())
            return record(command(db, key))

    def submit(self, key, body, cancel=False):
        now = self.clock()
        req = request({k: body[k] for k in ("node_id", "worker_id", "account", "action", "params") if k in body})
        require(key == ident(body.get("id")) and req["node_id"] == self.node_id
                and body.get("instance_id") == self.instance_id, "目标桥身份不符", 409)
        cmd = {**req, "id": key, "instance_id": self.instance_id, "session_id": ident(body.get("session_id")),
               "phase": body.get("phase"), "source": string(body.get("source"), "来源"),
               "created_at": number(body.get("created_at"), "创建时间", 0, 1e11),
               "expires_at": number(body.get("expires_at"), "过期时间", 0, 1e11)}
        require(cmd["phase"] is None or cmd["phase"] in PHASES, "阶段无效")
        if cmd["action"] in WRITE:
            cmd["account_ref"] = string(body.get("account_ref", cmd["account"]), "交易账户标识")
        if cmd["action"] in ("order.close", "position.protect"):
            expected = obj(body.get("expected_position"))
            require(expected.get("position_id") == cmd["params"]["position_id"] and expected.get("symbol") == "NQ-PERP",
                    "目标持仓凭据无效")
            choice(expected.get("side"), {"buy", "sell"}, "持仓方向")
            for k in ("quantity", "entry_price"):
                number(expected.get(k), k, 0.000001, 1e12)
            cmd["expected_position"] = expected
        require(0 < cmd["expires_at"] - cmd["created_at"] <= 91 and cmd["created_at"] <= now + 10, "指令时间窗无效")
        with self.db.tx() as db:
            self._expire(db, now)
            prior = find_command(db, key)
            if prior:
                require(prior["body"] == dump(cmd), "该指令 ID 已用于其他内容", 409)
                if cancel and prior["status"] == "queued":
                    finish(db, key, "cancelled", now, "中心已取消")
                return record(command(db, key))
            require(cancel or not db.execute("SELECT 1 FROM update_gate").fetchone(), "节点更新维护中", 409)
            insert(db, cmd, "queued", now)
            if cancel:
                finish(db, key, "cancelled", now, "中心已取消")
            elif now >= cmd["expires_at"]:
                finish(db, key, "expired", now, "指令已过期")
            else:
                try:
                    if self.release:
                        require(db.execute("SELECT 1 FROM worker_build WHERE worker_id=? AND release=?",
                                           (cmd["worker_id"],self.release)).fetchone(), "浏览器尚未加载当前节点版本", 409)
                    validate_target(cmd, *target(db, cmd), now)
                    check_reservations(db, cmd, now)
                except Problem as err:
                    finish(db, key, "failed", now, str(err))
            return record(command(db, key))

    def resolve(self, key, body):
        executed = boolean(body.get("executed"))
        note = string(body.get("note"), "核验说明", 500)
        with self.db.tx() as db:
            row = command(db, key)
            if row["status"] == "resolved":
                require(record(row)["result"]["executed"] == executed and record(row)["result"]["note"] == note,
                        "已记录另一份核验结论", 409)
            else:
                require(row["status"] == "unknown", "仅可核验结果未知的指令", 409)
                finish(db, key, "resolved", self.clock(), result={"executed": executed, "note": note, "original": record(row)["result"]})
            return record(command(db, key))

    def _touch(self, db, body, now):
        wid, sid = ident(body.get("worker_id")), ident(body.get("session_id"))
        generation = number(body.get("generation"), "会话序号", 1, 2**53 - 1, True)
        mode = choice(body.get("mode"), {"readonly", "execute"}, "浏览器模式")
        label = string(body.get("label", wid), "浏览器名称", 80)
        row = db.execute("SELECT * FROM workers WHERE worker_id=?", (wid,)).fetchone()
        if row:
            require(generation > row["generation"] or generation == row["generation"]
                    and sid == row["session_id"] and mode == row["mode"], "旧浏览器会话已失效", 409)
        if not row or generation > row["generation"]:
            for job in db.execute("SELECT * FROM commands WHERE worker=? AND status='queued'", (wid,)).fetchall():
                finish(db, job["id"], "cancelled", now, "浏览器会话已更换")
        page = string(body.get("page", ""), "页面路径", 200, True)
        error = string(body.get("error", ""), "插件状态", 500, True)
        build = body.get("release", "")
        if build != "":
            updates.revision(build)
        db.execute("""INSERT INTO worker_build VALUES(?,?) ON CONFLICT(worker_id) DO UPDATE
                   SET release=excluded.release WHERE release!=excluded.release""", (wid,build))
        if not row or row["session_id"] != sid or row["error"] != error:
            message = error or ("浏览器已连接 · 执行模式" if mode == "execute" else "浏览器已连接 · 只读模式")
            reporting.log(db, self.node_id, now, "browser", message, "warning" if error else "info", worker=wid)
        db.execute("""INSERT INTO workers VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE SET
            label=excluded.label,generation=excluded.generation,session_id=excluded.session_id,mode=excluded.mode,
            last_seen=excluded.last_seen,page=excluded.page,error=excluded.error""",
            (wid, label, generation, sid, mode, now, page, error))
        return wid, sid

    def _inventory(self, db, wid, sid, items):
        require(isinstance(items, list) and len(items) <= 500, "账户列表无效")
        seen = set()
        db.execute("UPDATE accounts SET present=0 WHERE worker_id=?", (wid,))
        for item in items:
            item = obj(item)
            name = string(item.get("name"), "账户名")
            category = string(item.get("category"), "账户类别", 40)
            phase = item.get("phase")
            require(phase is None or phase in PHASES, "未知阶段")
            dup = name in seen or boolean(item.get("ambiguous", False))
            seen.add(name)
            excluded = category.lower() in PRIMARY or name.lower() in PRIMARY
            db.execute("""INSERT INTO accounts(worker_id,name,category,phase,present,ambiguous,excluded,listed_session)
                VALUES(?,?,?,?,1,?,?,?) ON CONFLICT(worker_id,name) DO UPDATE SET present=1,listed_session=excluded.listed_session,
                category=excluded.category,ambiguous=excluded.ambiguous,excluded=MAX(accounts.excluded,excluded.excluded),
                read_session=CASE WHEN excluded.phase IS NOT NULL AND excluded.phase IS NOT accounts.phase THEN NULL ELSE accounts.read_session END,
                phase=COALESCE(excluded.phase,accounts.phase)""", (wid, name, category, phase, dup, excluded, sid))

    def _observe(self, db, wid, data, now):
        data = obj(data)
        name = string(data.get("name"), "账户名")
        row = db.execute("SELECT * FROM accounts WHERE worker_id=? AND name=?", (wid, name)).fetchone()
        require(row and row["present"], "请先上报该浏览器的账户列表", 409)
        if data.get("error"):
            if data["error"] != row["read_error"]:
                reporting.log(db, self.node_id, now, "observation", string(data["error"], "读取错误", 500), "warning", wid, name)
            db.execute("UPDATE accounts SET read_error=? WHERE worker_id=? AND name=?",
                       (string(data["error"], "读取错误", 500), wid, name))
            return
        snap = obj(data.get("snapshot"))
        require(len(dump(snap)) <= 16000, "读数过大")
        observed = number(snap.get("observed_at"), "读取时间", now - 180, now + 10)
        if row["observed_at"] and observed < row["observed_at"]:
            return
        for key in ("equity", "balance", "unrealized_pnl"):
            number(snap.get(key), key, -1e12, 1e12)
        require(snap.get("position_open") is None or type(snap["position_open"]) is bool, "持仓状态无效")
        if snap.get("position_open"):
            string(snap.get("position_id"), "持仓 ID")
            choice(snap.get("side"), {"buy", "sell"}, "持仓方向")
            require(snap.get("symbol") == "NQ-PERP", "持仓品种无效")
            for key in ("quantity", "entry_price"):
                number(snap.get(key), key, 0.000001, 1e12)
        if snap.get("account_health") is not None:
            number(snap["account_health"], "账户健康度", 0, 100)
        category = string(data.get("category") or row["category"], "账户类别", 40)
        phase = data.get("phase") or row["phase"]
        require(phase is None or phase in PHASES, "未知阶段")
        route = (self.node_id, wid, name)
        tracked = json.loads(row["tracked_position"]) if row["tracked_position"] else None
        if row["read_error"]:
            reporting.log(db, self.node_id, now, "observation", "账户读数恢复", worker=wid, account=name)
        if snap.get("position_open") is True:
            if not tracked or tracked["id"] != snap["position_id"]:
                reporting.log(db, self.node_id, now, "observation", "观察到活动持仓 " + snap["position_id"], worker=wid, account=name)
            ledger.position_observation(db, route, snap, data.get("phase"))
            tracked = {"id": snap["position_id"], "phase": data.get("phase"), "session": row["listed_session"]}
        elif snap.get("position_open") is False and tracked:
            if tracked["session"] == row["listed_session"] and tracked["phase"] == data.get("phase"):
                ledger.save(db, route, "position", tracked["id"], {"position_id": tracked["id"],
                            "phase": tracked["phase"], "close_seen": observed})
                reporting.log(db, self.node_id, now, "observation", "观察到持仓结束 " + tracked["id"], worker=wid, account=name)
            tracked = None
        db.execute("""UPDATE accounts SET snapshot=?,category=?,phase=?,observed_at=?,read_error='',read_session=listed_session,
            tracked_position=?,excluded=MAX(excluded,?) WHERE worker_id=? AND name=?""",
            (dump(snap), category, phase, observed, dump(tracked) if tracked else None, category.lower() in PRIMARY, wid, name))

    def plugin(self, op, body):
        now = self.clock()
        with self.db.tx() as db:
            self._expire(db, now)
            # A stored receipt may arrive after reload. It can only finish its original lease.
            if op == "result":
                return self._result(db, body, now)
            wid, sid = self._touch(db, body, now)
            if op == "heartbeat":
                return {"ok": True}
            if op == "report":
                if "inventory" in body:
                    self._inventory(db, wid, sid, body["inventory"])
                if "observation" in body:
                    self._observe(db, wid, body["observation"], now)
                if "history" in body:
                    history = obj(body["history"])
                    name = string(history.get("name"), "历史账户")
                    require(db.execute("""SELECT 1 FROM accounts WHERE worker_id=? AND name=? AND present=1
                                       AND ambiguous=0 AND listed_session=? AND read_session=?""",
                                       (wid, name, sid, sid)).fetchone(), "历史与当前浏览器账户不匹配", 409)
                    ledger.native_rows(db, (self.node_id, wid, name), history)
                return {"ok": True}
            if op == "intent":
                return self._intent(db, wid, sid, body, now)
            require(op == "poll", "接口不存在", 404)
            if self.release and body.get("release") != self.release:
                return {"command":None, "update_release":self.release}
            if db.execute("SELECT 1 FROM commands WHERE worker=? AND status='running'", (wid,)).fetchone():
                return {"command": None}
            for row in db.execute("SELECT * FROM commands WHERE worker=? AND status='queued' ORDER BY created,id", (wid,)).fetchall():
                cmd = json.loads(row["body"])
                try:
                    validate_target(cmd, *target(db, cmd), now)
                    check_reservations(db, cmd, now)
                except Problem as err:
                    finish(db, row["id"], "failed", now, str(err))
                    continue
                db.execute("UPDATE commands SET status='running',claimed=?,updated=? WHERE id=?", (now, now, row["id"]))
                return {"command": cmd, "run_until": now + RUN_TTL}
            return {"command": None}

    def _intent(self, db, wid, sid, body, now):
        row = command(db, ident(body.get("id")))
        cmd = record(row)
        require(row["worker"] == wid and cmd["session_id"] == sid and row["status"] == "running"
                and body["mode"] == "execute", "执行租约已失效", 409)
        allowed = {"order.open": {"open", "protect"}, "order.close": {"close"},
                   "position.protect": {"protect"}, "profit.withdraw": {"withdraw"}}
        stage = choice(body.get("stage"), allowed.get(row["action"], set()), "操作步骤")
        intents = cmd["intents"]
        if stage in intents:
            return {"authorize_click": False}
        if stage == "protect" and row["action"] == "order.open":
            require("open" in intents, "尚未提交开仓", 409)
        else:
            require(now < cmd["expires_at"], "指令已过期，禁止提交", 409)
            validate_target(cmd, *target(db, cmd), now)
        proof = obj(body.get("proof", {}))
        require(len(dump(proof)) < 16000, "操作依据过大")
        intents[stage] = {"time": now, "proof": proof}
        db.execute("UPDATE commands SET intents=?,updated=? WHERE id=?", (dump(intents), now, row["id"]))
        reporting.log(db, self.node_id, now, "intent", "签发单次操作许可 · " + stage, worker=wid,
                      account=cmd["account"], command_id=cmd["id"])
        return {"authorize_click": True}

    def _result(self, db, body, now):
        row = command(db, ident(body.get("id")))
        cmd = record(row)
        require(row["worker"] == ident(body.get("worker_id")) and cmd["session_id"] == ident(body.get("session_id")),
                "回执不属于领取该指令的会话", 409)
        late = row["status"] == "unknown" and body.get("ok") is True
        if row["status"] in TERMINAL and not late:
            return {"status": row["status"]}
        require(row["status"] == "running" or late, "指令尚未领取", 409)
        ok = boolean(body.get("ok"))
        result = obj(body.get("result", {}))
        require(len(dump(result)) < 180000, "回执过大")
        error = string(body.get("error", ""), "错误信息", 500, True)
        status = "succeeded" if ok else "unknown" if cmd["intents"] else "failed"
        if ok and row["action"] in WRITE:
            try:
                step = {"order.open": "open", "order.close": "close", "profit.withdraw": "withdraw"}.get(row["action"])
                require(not step or step in cmd["intents"], "缺少操作提交记录")
                verify_financial_receipt(cmd, result)
            except Problem as err:
                status, error = "unknown", str(err)
        obs = result.get("observation")
        worker, current = target(db, cmd)
        if obs and cmd["account"] and current and current["present"] and worker["session_id"] == cmd["session_id"]:
            require(obs.get("name") == cmd["account"], "回执账户不符", 409)
            if now - 180 <= obs.get("snapshot", {}).get("observed_at", 0) <= now + 10:
                self._observe(db, cmd["worker_id"], obs, now)
        finish(db, row["id"], status, now, error, result)
        if status == "succeeded":
            ledger.command_evidence(db, record(command(db, row["id"])))
        return {"status": status}
