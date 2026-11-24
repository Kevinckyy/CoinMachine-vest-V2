"""One durable public command mailbox and one local browser API per cloud node."""
import json
import os
import time
import uuid
from . import cards, daily_floor, ledger, portfolio, reporting, status_delta, strategy_payout, updates

from .protocol import (PHASES, PORTFOLIO_SCAN, PRIMARY, RUN_TTL, TERMINAL, WRITE, Problem, boolean, choice,
                       dump, ident, make_command, number, obj, plugin_version_parts, request, require, string, validate_target)
from .storage import Database, check_reservations, command, find_command, finish, insert, record
from .trading_day import entry_day_window

NOTICE_KINDS = {"phase2", "live", "closed"}

def worker_view(row):
    return dict(row) if row else None


def account_view(row):
    if not row:
        return None
    return {**{k: row[k] for k in row.keys() if k != "tracked_position"}, "snapshot": json.loads(row["snapshot"]),
            **{k:json.loads(row[k]) if row[k] else None for k in ("card","risk","portfolio","open_lock")},
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
                omitted = key=="stop_loss" and action=="order.open" and proof.get("stop_omitted") is True
                target_amount = proof.get(key, params.get(key)) if action=="order.open" else params.get(key)
                expected = "verified" if target_amount is not None or key=="stop_loss" and action=="order.open" and not omitted else "omitted"
                require(isinstance(snap.get(report), dict) and snap[report].get("status") == expected,
                        "回执未核验原生止盈止损")
                if action=="order.open" and key=="take_profit" and target_amount is not None:
                    require(snap[report].get("target_profit")==target_amount, "回执止盈与开仓许可金额不符")
                    if params.get("min_take_profit"):
                        trigger = number(snap.get("native_tp_price"),"原生止盈触发价",0.000001,1e12)
                        gross = (trigger-snap["entry_price"])*(1 if params["side"]=="buy" else -1)*proof["quantity"]
                        require(gross+1e-6 >= params["min_take_profit"],"原生止盈低于设置的最低止盈金额")
                if omitted:
                    # Receipts issued before version 3 used the daily distance for the original exemption.
                    distance = proof.get("distance_to_max_floor",proof["remaining_drawdown"])
                    low_distance = params.get("omit_stop_below") is not None and distance is not None and 0 < distance < params["omit_stop_below"]
                    low_gap = (params.get("omit_floor_gap_below") is not None and proof.get("floor_gap") is not None and
                               proof["floor_gap"] < params["omit_floor_gap_below"])
                    require(proof.get("stop_loss") is None and (low_distance or low_gap) and snap.get("native_sl_absent") is True
                            and snap.get("native_sl_price") is None, "原生止损应为空且须满足免止损阈值")
                elif action=="order.open" and key=="stop_loss" and "stop_buffer" in params:
                    target_risk = proof["stop_loss"]
                    trigger = number(snap.get("native_sl_price"),"原生止损触发价",0.000001,1e12)
                    entry = number(snap.get("entry_price"),"成交均价",0.000001,1e12)
                    risk = (entry-trigger if params["side"]=="buy" else trigger-entry)*proof["quantity"]
                    require(snap[report].get("target_risk")==target_risk and risk>0 and
                            -1e-6 <= target_risk-risk < proof["quantity"]*0.25 and
                            abs(trigger*4-round(trigger*4))<=1e-6,"原生止损价与下单时核定的风险金额不符")
    else:
        require(snap.get("position_open") is False, "执行回执未确认空仓")
        if action == "profit.withdraw":
            require(ledger.verified_withdrawal(cmd, result, snap), "主账户收款对象、申请金额或扣款余额未核验")
            policy = cmd.get("strategy_payout")
            if policy and "target_balance" in policy and policy["live_payout_mode"] == "all":
                require(abs(snap["balance"]-policy["target_balance"]) <= .005,"领取后的余额与 Live 阶段起始余额不符")


class Bridge:
    def __init__(self, path, node_id, clock=time.time):
        self.db = Database(path)
        self.status_feed = status_delta.StatusFeed()
        self.notice_seen = {}
        self.notice_until = 0
        self.node_id, self.clock = ident(node_id), clock
        self.release = os.environ.get("VEST_FLEET_RELEASE", "")
        self.launch_id = os.environ.get("VEST_FLEET_LAUNCH_ID", "")
        if self.release:
            updates.revision(self.release)
        self.db.conn.executescript("""
            CREATE TABLE IF NOT EXISTS identity(node_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS worker_build(worker_id TEXT PRIMARY KEY,release TEXT NOT NULL,
                portfolio_version INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS update_gate(slot INTEGER PRIMARY KEY CHECK(slot=1),owner TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS account_notices(worker TEXT NOT NULL,platform_id TEXT NOT NULL,kind TEXT NOT NULL,
                root TEXT NOT NULL,name TEXT NOT NULL,started REAL NOT NULL,completed REAL,PRIMARY KEY(worker,platform_id,kind));
            CREATE UNIQUE INDEX IF NOT EXISTS one_pending_notice ON account_notices(worker) WHERE completed IS NULL;
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
        cards.schema(self.db.conn)
        ledger.schema(self.db.conn)
        daily_floor.schema(self.db.conn)
        reporting.log_schema(self.db.conn)
        with self.db.tx() as db:
            if "portfolio_version" not in {r["name"] for r in db.execute("PRAGMA table_info(worker_build)")}:
                db.execute("ALTER TABLE worker_build ADD COLUMN portfolio_version INTEGER NOT NULL DEFAULT 0")
            if "strategy_version" not in {r["name"] for r in db.execute("PRAGMA table_info(worker_build)")}:
                db.execute("ALTER TABLE worker_build ADD COLUMN strategy_version INTEGER NOT NULL DEFAULT 0")
            if "plugin_version" not in {r["name"] for r in db.execute("PRAGMA table_info(worker_build)")}:
                db.execute("ALTER TABLE worker_build ADD COLUMN plugin_version TEXT NOT NULL DEFAULT ''")
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
            elif row["status"] == "running" and row["action"] == PORTFOLIO_SCAN:
                if now >= row["updated"] + RUN_TTL:
                    finish(db, row["id"], "failed", now, "全量读取超时，已保留逐户结果", portfolio.progress(row))
            elif row["status"] == "running" and now >= row["claimed"] + RUN_TTL:
                uncertain = bool(json.loads(row["intents"]))
                finish(db, row["id"], "unknown" if uncertain else "failed", now,
                       "执行回执超时，需核对平台" if uncertain else "执行超时，未签发资金操作许可")

    def status(self, since=None):
        with self.db.tx() as db:
            self._expire(db, self.clock())
            workers = []
            for row in db.execute("""SELECT w.*,COALESCE(b.release,'') AS release,COALESCE(b.portfolio_version,0) AS portfolio_version,
                    COALESCE(b.strategy_version,0) AS strategy_version,COALESCE(b.plugin_version,'') AS plugin_version,c.session AS card_session,
                    c.generation AS card_generation,c.full_at AS cards_full_at FROM workers w
                    LEFT JOIN worker_build b ON b.worker_id=w.worker_id LEFT JOIN card_sync c ON c.worker=w.worker_id ORDER BY label"""):
                scan = db.execute("""SELECT id,status,error, json_extract(result,'$.stage') AS stage,
                        json_extract(result,'$.total') AS total,json_extract(result,'$.read') AS read,
                        json_extract(result,'$.partial') AS partial,json_extract(result,'$.failed') AS failed
                        FROM commands WHERE worker=? AND action=? ORDER BY created DESC,id DESC LIMIT 1""",
                                  (row["worker_id"], PORTFOLIO_SCAN)).fetchone()
                workers.append({**worker_view(row), "portfolio_scan": dict(scan) if scan else None,
                                "notice_waiting":self.clock()-self.notice_seen.get(row["worker_id"],-float("inf"))<12})
            snap = {"version": 1, "open_policy_version":daily_floor.OPEN_POLICY_VERSION, "payout_quote_version":1, "node_id": self.node_id, "instance_id": self.instance_id, "release":self.release,
                    "launch_id": self.launch_id, "notice_until": self.notice_until,
                    "notice_waiting": any(self.clock()-at < 12 for at in self.notice_seen.values()),
                    "ledger_seq":ledger.high_water(db,False),"archive_seq":ledger.high_water(db,True),
                    "log_seq": db.execute("SELECT COALESCE(MAX(id),0) FROM node_logs").fetchone()[0],
                    "card_generation":db.execute("SELECT generation FROM card_request").fetchone()[0],
                    "workers": workers,
                    "accounts": [{**account_view(r), "tracked_position_id":(json.loads(r["tracked_position"] or "{}") or {}).get("id"),
                                  "daily_floor":daily_floor.view(db,r["worker_id"],r["name"],self.clock())}
                                 for r in db.execute("SELECT * FROM accounts ORDER BY worker_id,name")]}
            return self.status_feed.response(snap, since)

    def refresh_cards(self, body):
        require(body.get("instance_id")==self.instance_id,"节点数据库身份不匹配",409)
        with self.db.tx() as db:
            if "generation" in body:
                gen = number(body["generation"],"刷新批次",1,2**53-1,True)
                db.execute("UPDATE card_request SET generation=MAX(generation,?)",(gen,))
            if "allow_notices" in body:
                self.notice_until = self.clock()+10 if boolean(body["allow_notices"]) else 0
            require("generation" in body or "allow_notices" in body,"缺少刷新或账户提示操作")
            return {"generation":db.execute("SELECT generation FROM card_request").fetchone()[0]}

    def _notice(self, db, op, wid, body, now):
        require(body["mode"]=="execute" and now < self.notice_until and not db.execute("SELECT 1 FROM update_gate").fetchone(),
                "等待中心授权处理账户提示",409)
        platform = ident(body.get("platform_id"))
        kind = choice(body.get("kind"),NOTICE_KINDS,"账户提示")
        pending = db.execute("SELECT * FROM account_notices WHERE worker=? AND completed IS NULL",(wid,)).fetchone()
        if op=="notice.complete":
            require(pending and (pending["platform_id"],pending["kind"])==(platform,kind),"阶段处理记录不匹配",409)
            if kind=="closed":
                require(body.get("prior_active") is False,"关闭账户仍出现在活动列表",409)
            else:
                successor = ident(body.get("selected"))
                require(successor!=platform and body.get("root")==pending["root"] and
                        body.get("phase")==("2/2" if kind=="phase2" else "live") and body.get("count")==0,
                        "新阶段账户或空仓证明不匹配",409)
                number(body.get("positions_at"),"新阶段持仓读取时间",now-90,now+2)
            db.execute("UPDATE account_notices SET completed=? WHERE worker=? AND completed IS NULL",(now,wid))
            db.execute("DELETE FROM card_sync WHERE worker=?",(wid,))
            reporting.log(db,self.node_id,now,"browser","账户提示处理已核验，重新拉取活动清单",worker=wid,account=pending["name"])
            return {"completed":True}
        require(not pending and not db.execute("SELECT 1 FROM commands WHERE worker=? AND status='running'",(wid,)).fetchone(),
                "浏览器仍有未结束的操作",409)
        row = db.execute("SELECT data FROM book WHERE node=? AND worker=? AND kind='account_history' AND ref=?",
                         (self.node_id,wid,platform)).fetchone()
        require(row,"等待节点归档弹窗所对应的平台账户",409)
        old = json.loads(row[0])
        phase, name, root = old.get("phase"), old.get("name"), old.get("root_account_id") or platform
        require(phase in PHASES and name and name.lower() not in PRIMARY,"无法核验弹窗账户阶段",409)
        if kind=="phase2":
            roots = body.get("successor_roots")
            require(phase=="1/2" and isinstance(roots,list) and len(roots)<=500 and root in roots,
                    "未核验到同一考核链的第二阶段账户",409)
        elif kind=="live":
            require(phase=="2/2" and old.get("status") in ("2","3","6") and body.get("active_phase") in (None,"2/2"),
                    "弹窗与已登记的二阶段账户不符",409)
        else:
            require(body.get("active") is False and old.get("status") not in ("3","6"),"关闭通知与活动账户状态不符",409)
        reserved = db.execute("""INSERT INTO account_notices VALUES(?,?,?,?,?,?,NULL)
            ON CONFLICT(worker,platform_id,kind) DO UPDATE SET completed=NULL,started=excluded.started
            WHERE excluded.kind='closed' AND account_notices.completed IS NOT NULL AND account_notices.completed<excluded.started-5""",
            (wid,platform,kind,root,name,now))
        require(reserved.rowcount,"该账户提示已有处理记录，请核对平台结果",409)
        label = {"phase2":"开始第二阶段","live":"激活 Live","closed":"关闭亏损上限通知"}[kind]
        reporting.log(db,self.node_id,now,"browser","已登记一次页面操作 · "+label,worker=wid,account=name)
        return {"authorize":True,"name":name,"root":root}

    def ledger_page(self, after, archive=False):
        after = number(after, "同步游标", 0, 2**63-1, True)
        with self.db.tx() as db:
            return {"node_id": self.node_id, "instance_id": self.instance_id, **ledger.page(db, after,archive)}

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
        req = request({k: body[k] for k in ("node_id", "worker_id", "account", "action", "params") if k in body},legacy=True)
        require(key == ident(body.get("id")) and req["node_id"] == self.node_id
                and body.get("instance_id") == self.instance_id, "目标桥身份不符", 409)
        cmd = {**req, "id": key, "instance_id": self.instance_id, "session_id": ident(body.get("session_id")),
               "phase": body.get("phase"), "source": string(body.get("source"), "来源"),
               "created_at": number(body.get("created_at"), "创建时间", 0, 1e11),
               "expires_at": number(body.get("expires_at"), "过期时间", 0, 1e11)}
        require(cmd["phase"] is None or cmd["phase"] in PHASES, "阶段无效")
        if cmd["action"] in WRITE:
            cmd["account_ref"] = string(body.get("account_ref", cmd["account"]), "交易账户标识")
        if cmd["action"]=="order.open" and "expected_risk" in body:
            cmd["expected_risk"] = obj(body["expected_risk"])
            cmd["expected_floor"] = obj(body.get("expected_floor",{}))
        if "reentry_claim" in body:
            require(cmd["action"] == "order.open" and cmd["phase"] == "live" and cmd["source"].startswith("strategy-"), "Live 再入场指令无效")
            cmd["reentry_claim"] = ident(body["reentry_claim"])
        if "strategy_payout" in body:
            require(cmd["action"] == "profit.withdraw" and cmd["phase"] == "live", "策略领取指令无效")
            cmd["strategy_payout"] = strategy_payout.validate(obj(body["strategy_payout"]))
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
            for job in db.execute("SELECT * FROM commands WHERE worker=? AND status='running' AND action=?",
                                  (wid, PORTFOLIO_SCAN)).fetchall():
                finish(db, job["id"], "cancelled", now, "浏览器会话已更换", portfolio.progress(job))
        page = string(body.get("page", ""), "页面路径", 200, True)
        error = string(body.get("error", ""), "插件状态", 500, True)
        build = body.get("release", "")
        if build != "":
            updates.revision(build)
        version = body.get("plugin_version","")
        require(version=="" or plugin_version_parts(version),"插件版本号无效")
        db.execute("""INSERT INTO worker_build(worker_id,release,portfolio_version,strategy_version,plugin_version) VALUES(?,?,?,?,?) ON CONFLICT(worker_id) DO UPDATE
                   SET release=excluded.release,portfolio_version=excluded.portfolio_version,strategy_version=excluded.strategy_version,plugin_version=excluded.plugin_version
                   WHERE release!=excluded.release OR portfolio_version!=excluded.portfolio_version OR strategy_version!=excluded.strategy_version OR plugin_version!=excluded.plugin_version""",
                   (wid,build,int(body.get("portfolio_version") == 1),int(body.get("strategy_version") == 1),version))
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

    def _observe(self, db, wid, data, now, *, preflight=False):
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
        reference_at = number(snap.get("reference_at",observed), "底线读取时间", 0, now+10)
        if snap.get("reference_card_id"):
            require(snap["reference_card_id"] == json.loads(row["card"] or "{}").get("id") and not row["ambiguous"],
                    "风控底线不属于当前账户",409)
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
        if data.get("phase") and (phase != row["baseline_phase"] or row["initial_balance"] is None):
            baseline = snap["balance"] if snap.get("position_open") is False and snap["balance"] > 0 else None
            db.execute("UPDATE accounts SET baseline_phase=?,initial_balance=? WHERE worker_id=? AND name=?", (phase,baseline,wid,name))
        if phase and (row["phase"] != phase or row["phase_started_at"] is None):
            db.execute("UPDATE accounts SET phase_started_at=? WHERE worker_id=? AND name=?", (observed,wid,name))
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
        risk = cards.from_trade(snap)
        daily_floor.capture(db,wid,name,reference_at,risk["daily_limit"],
                            snap.get("daily_reset_equity"),snap.get("daily_floor"))
        lock = json.loads(row["open_lock"] or "{}")
        if (not preflight and lock.get("kind")=="read_retry" and snap.get("reference_card_id")
                and reference_at>=max(now-330,entry_day_window(now)["start"]) and snap.get("daily_floor") is not None
                and snap.get("max_drawdown_floor") is not None and not cards.risk_error(risk,complete=True)):
            db.execute("UPDATE accounts SET open_lock=NULL WHERE worker_id=? AND name=?",(wid,name))
        if not preflight:
            previous = json.loads(row["risk"] or "{}")
            for field in cards.AMOUNTS:
                if risk[field] is None and not (risk["daily_unlimited"] and field in ("daily_loss","daily_limit")):
                    risk[field] = previous.get(field)
            if "daily_unlimited" not in snap and "daily_unlimited" in previous:
                risk["daily_unlimited"] = previous["daily_unlimited"]
        db.execute("UPDATE accounts SET risk=?,risk_at=? WHERE worker_id=? AND name=?",
                   (dump(risk),observed,wid,name))
        return {"risk":risk,"daily_floor":daily_floor.view(db,wid,name,now)}

    def plugin(self, op, body):
        now = self.clock()
        with self.db.tx() as db:
            self._expire(db, now)
            # A stored receipt may arrive after reload. It can only finish its original lease.
            if op == "result":
                return self._result(db, body, now)
            if op == "archive":
                wid = ident(body.get("worker_id"))
                owner = db.execute("SELECT session_id,generation FROM workers WHERE worker_id=?",(wid,)).fetchone()
                generation = number(body.get("generation"),"采集会话轮次",0,2**53-1,True)
                sid = ident(body.get("session_id"))
                require(owner and (generation < owner["generation"] or
                        generation==owner["generation"] and sid==owner["session_id"]), "采集会话尚未注册",409)
                ledger.archive_rows(db,self.node_id,wid,body.get("items"))
                return {"accepted":True}
            wid, sid = self._touch(db, body, now)
            if op in ("notice.reserve","notice.complete"):
                return self._notice(db,op,wid,body,now)
            if op == "heartbeat":
                return {"ok": True}
            if op == "read-all":
                require(body.get("portfolio_version") == 1 and (not self.release or body.get("release") == self.release),
                        "请先加载当前版本插件", 409)
                require(not db.execute("SELECT 1 FROM update_gate").fetchone(), "节点更新维护中", 409)
                prior = db.execute("""SELECT id FROM commands WHERE worker=? AND action=? AND status IN ('queued','running')
                                   ORDER BY created LIMIT 1""", (wid, PORTFOLIO_SCAN)).fetchone()
                if prior:
                    return {"id": prior["id"]}
                key = ident(body.get("id"))
                if find_command(db, key):
                    portfolio.owned(db, key, wid, sid)
                    return {"id": key}
                req = request(dict(node_id=self.node_id, worker_id=wid, action=PORTFOLIO_SCAN))
                cmd = make_command(key, req, {"instance_id": self.instance_id}, {"session_id": sid}, None, now, "plugin")
                insert(db, cmd, "queued", now)
                return {"id": key}
            if op == "report":
                if "metrics" in body:
                    require(body.get("page","").rstrip("/")=="/accounts","需要活跃账户页面",409)
                    return cards.update(db, wid, sid, body["metrics"], now, metrics=True)
                if "cards" in body:
                    require(body.get("page","").rstrip("/")=="/accounts","需要活跃账户页面",409)
                    reading = obj(body["cards"])
                    if reading.get("full") and plugin_version_parts(body.get("plugin_version")) >= (1,9,0,0):
                        require(reading.get("source_at") is not None,"完整活动账户清单缺少平台读取时间",409)
                    is_scan = "scan_id" in reading
                    ack = cards.update(db, wid, sid, reading, now, defer_cache=is_scan)
                    if is_scan:
                        row = portfolio.owned(db, reading["scan_id"], wid, sid)
                        portfolio.listed(db, row, reading, now)
                        ack.update(cards.directory_cache(db, wid, now))
                    return ack
                if "portfolio" in body:
                    require(body.get("page", "").rstrip("/") == "/portfolio", "需要 Portfolio 页面", 409)
                    return portfolio.observe(db, wid, sid, body["portfolio"], now)
                if "inventory" in body:
                    self._inventory(db, wid, sid, body["inventory"])
                observed = self._observe(db, wid, body["observation"], now) if "observation" in body else None
                if "history" in body:
                    history = obj(body["history"])
                    name = string(history.get("name"), "历史账户")
                    require(db.execute("""SELECT 1 FROM accounts WHERE worker_id=? AND name=? AND present=1
                                       AND ambiguous=0 AND listed_session=? AND read_session=?""",
                                       (wid, name, sid, sid)).fetchone(), "历史与当前浏览器账户不匹配", 409)
                    ledger.native_rows(db, (self.node_id, wid, name), history)
                return {"ok": True, **(observed or {})}
            if op == "intent":
                return self._intent(db, wid, sid, body, now)
            if op == "preflight":
                cmd = record(command(db,ident(body.get("id"))))
                return self._preflight(db,cmd,wid,sid,body,now)
            require(op == "poll", "接口不存在", 404)
            if self.release and body.get("release") != self.release:
                return {"command":None, "update_release":self.release}
            running = db.execute("SELECT * FROM commands WHERE worker=? AND status='running'", (wid,)).fetchone()
            if running:
                if running["action"] == PORTFOLIO_SCAN and json.loads(running["body"])["session_id"] == sid:
                    return portfolio.delivery(db, running, body.get("cached_scan"), now)
                return {"command": None}
            if body["mode"]=="execute" and plugin_version_parts(body.get("plugin_version")) >= (1,11,3,0):
                pending = db.execute("SELECT platform_id,root,name,kind,started FROM account_notices WHERE worker=? AND completed IS NULL",(wid,)).fetchone()
                if pending or body.get("notice_kind") in NOTICE_KINDS:
                    self.notice_seen[wid] = now
                    manual = db.execute("""SELECT 1 FROM commands WHERE worker=? AND status='queued'
                        AND json_extract(body,'$.source') NOT LIKE 'strategy-%'""",(wid,)).fetchone()
                    if pending or now < self.notice_until or not manual:
                        return {"notice":{"enabled":now < self.notice_until,"pending":dict(pending) if pending else None}}
                else:
                    self.notice_seen.pop(wid,None)
            refresh_generation = None
            if body.get("cards_version")==1:
                gen = db.execute("SELECT generation FROM card_request").fetchone()[0]
                ack = db.execute("SELECT session,generation FROM card_sync WHERE worker=?",(wid,)).fetchone()
                manual_view = body.get("manual_view") is True and body["mode"]=="readonly"
                if not ack or ack["generation"]!=gen or ack["session"]!=sid and not manual_view:
                    refresh_generation = gen
            for row in db.execute("SELECT * FROM commands WHERE worker=? AND status='queued' ORDER BY created,id", (wid,)).fetchall():
                cmd = json.loads(row["body"])
                if refresh_generation is not None and cmd["action"] not in ("accounts.list", PORTFOLIO_SCAN):
                    continue
                try:
                    validate_target(cmd, *target(db, cmd), now)
                    check_reservations(db, cmd, now)
                    if cmd["action"]=="order.open":
                        require(plugin_version_parts(body.get("plugin_version")) >= (1,9,0,0), "开仓前请重新加载 1.9.0 或更高版本插件",409)
                    if cmd["action"] == "profit.available" or (cmd.get("strategy_payout") or {}).get("quote_id"):
                        require(plugin_version_parts(body.get("plugin_version")) >= (1,7,1,0),
                                "读取页面可领额需要 1.7.1 或更高版本插件",409)
                    if "omit_stop_below" in cmd["params"] or cmd.get("strategy_payout") or cmd.get("reentry_claim"):
                        require(body.get("strategy_version") == 1, "请重新加载 1.5.0 或更高版本插件", 409)
                    if cmd.get("strategy_payout"):
                        strategy_payout.check_origin(db,cmd,target(db,cmd)[1])
                    if cmd["action"] == PORTFOLIO_SCAN:
                        require(body.get("portfolio_version") == 1, "请重新加载支持全量读取账户信息的插件", 409)
                except Problem as err:
                    finish(db, row["id"], "failed", now, str(err))
                    continue
                db.execute("UPDATE commands SET status='running',claimed=?,updated=? WHERE id=?", (now, now, row["id"]))
                if cmd["action"] == PORTFOLIO_SCAN:
                    db.execute("UPDATE commands SET result=? WHERE id=?", (dump(portfolio.progress(row)), row["id"]))
                    return portfolio.delivery(db, command(db, row["id"]), None, now)
                if cmd["action"] in ("account.read", "positions.read"):
                    _, account = target(db, cmd)
                    cmd = {**cmd, "read_receipt": True, "read_card_id": (account.get("card") or {}).get("id")}
                return {"command": cmd, "run_until": now + RUN_TTL,"card_generation":db.execute("SELECT generation FROM card_request").fetchone()[0]}
            if refresh_generation is not None:
                return {"command":None,"refresh_cards":refresh_generation}
            return {"command": None,"card_generation":db.execute("SELECT generation FROM card_request").fetchone()[0]}

    def _preflight(self, db, cmd, wid, sid, body, now):
        require(cmd["action"]=="order.open" and cmd["worker_id"]==wid and cmd["session_id"]==sid and
                cmd["status"]=="running" and not cmd["intents"] and body["mode"]=="execute" and now<cmd["expires_at"],
                "开仓核对租约已失效",409)
        require(body.get("page","").rstrip("/") in ("/trade/NQ-PERP","/trade/NDX-USD-PERP"),"需要在 NQ 交易页核对",409)
        obs = obj(body.get("observation"))
        require(obs.get("name")==cmd["account"],"核对的账户不符",409)
        snap = obj(obs.get("snapshot"))
        day = entry_day_window(now)
        number(snap.get("observed_at"),"交易页核对时间",max(cmd["claimed_at"]-1,now-15,day["start"]),min(now+5,day["end"]))
        _, account = target(db,cmd)
        expected = cmd.get("expected_risk",{})
        require(account and account["present"] and not account["ambiguous"],"账户已消失或名称不唯一",409)
        require(snap["observed_at"] >= (account["risk_at"] or 0),"过期的交易页风控读数",409)
        card_id = (account["card"] or {}).get("id")
        if expected.get("card_id") != card_id:
            reason = "候选账户卡片身份已更换"
            result = {"reselect":True,"changed":["card_id"],"reason":reason}
            finish(db,cmd["id"],"cancelled",now,reason,result)
            return {**result,"approved":False}
        reference_at = snap.get("reference_at")
        identity_verified = bool(card_id and snap.get("reference_card_id")==card_id)
        recent = (snap.get("reference_source")=="active_accounts" and type(reference_at) in (int,float)
                  and max(now-330,day["start"]) <= reference_at <= min(now+5,day["end"]))
        issue = None
        if not identity_verified:
            issue = "交易页未确认当前平台账户身份或阶段"
        elif snap.get("risk_source")=="flat_balance":
            issue = {"limits":"活动账户响应缺少本交易日的风控数据", "position":"活动持仓响应显示账户已有持仓",
                     "orders":"活动挂单占用账户余额", "balance":"缺少近期余额、持仓或挂单的完整响应"}.get(snap.get("risk_issue"))
            risk_at = snap.get("risk_at")
            if not issue and (snap.get("risk_issue") is not None or not recent or type(risk_at) not in (int,float)
                              or not max(now-15,day["start"]) <= risk_at <= min(now+5,day["end"])):
                issue = "交易页风控响应不完整或已过期"
        if issue:
            lock = account.get("open_lock") or {}
            if lock.get("until",0)<=now or lock.get("kind")=="read_retry":
                lock = {"kind":"read_retry","until":now+45,"reason":issue,"card_id":card_id}
                db.execute("UPDATE accounts SET open_lock=? WHERE worker_id=? AND name=?",(dump(lock),wid,cmd["account"]))
            result = {"reselect":True,"approved":False,"reason":issue,"open_lock":lock}
            finish(db,cmd["id"],"cancelled",now,issue,result)
            return result
        if not recent:
            snap = {key:value for key,value in snap.items() if key not in ("daily_floor","max_drawdown_floor","daily_reset_equity","daily_reset_balance","reference_at")}
            obs = {**obs,"snapshot":snap}
        risk = cards.from_trade(snap)
        actual = {**risk,"phase":obs.get("phase"),"category":obs.get("category"),"card_id":card_id}
        current = {**(account["risk"] or {}),"phase":account["phase"],"category":account["category"],"card_id":card_id}
        changed = sorted(k for k in actual if current.get(k)!=actual[k])
        old_floor = daily_floor.view(db,wid,cmd["account"],now)
        issue = cards.risk_error(risk, complete=True)
        if account["excluded"] or not actual["phase"] or actual["category"] not in ("eval","funded","live"):
            issue = "交易页未确认可交易账户类别和阶段"
        self._observe(db,wid,obs,now,preflight=True)
        db.execute("UPDATE accounts SET preflight_at=? WHERE worker_id=? AND name=?",(now,wid,cmd["account"]))
        floor = daily_floor.view(db,wid,cmd["account"],now)
        if (old_floor or {}).get("floor") != (floor or {}).get("floor"):
            changed.append("daily_floor")
        stop = daily_floor.stop_decision(risk, floor, cmd["params"])
        amount = stop["stop_loss"]
        qty = body.get("quantity") if body.get("stage")!="open" else obj(body.get("proof",{})).get("quantity")
        if qty is None and "micro" in cmd["params"]:
            qty = cmd["params"]["micro"]*2
        min_stop = number(qty,"实际 Vest 数量",0.000001,1e12)*0.25 if qty is not None else None
        if risk["daily_unlimited"]:
            issue = issue or "该账户无每日亏损底线，当前止损策略不适用"
        elif (not recent or stop["remaining_drawdown"] is None or snap.get("daily_floor") != floor["floor"] or
                reference_at != floor["observed_at"]):
            issue = issue or "交易页未读到本交易日的爆仓线"
        elif stop["remaining_max_drawdown"] is None:
            issue = issue or "交易页未读到已用回撤和最大回撤上限"
        elif stop["distance_to_max_floor"] is None:
            issue = issue or "交易页未读到最大回撤线，无法核对免止损条件"
        elif stop["distance_to_max_floor"] is not None and stop["distance_to_max_floor"] <= 0:
            issue = issue or "账户价值已触及最大回撤线"
        elif amount is not None and amount <= 0:
            issue = issue or "每日或最大回撤余量不足以保留止损缓冲"
        elif amount is not None and min_stop is not None and amount<min_stop:
            issue = issue or "止损余量不足当前仓位的一个价格跳动"
            risk["size_minimum"] = {"size_percent":cmd["params"].get("size_percent"),"minimum":min_stop}
            db.execute("UPDATE accounts SET risk=? WHERE worker_id=? AND name=?",(dump(risk),wid,cmd["account"]))
        lock = account.get("open_lock")
        reason = ""
        if lock and now < lock["until"] and lock.get("kind")!="read_retry":
            reason = lock["reason"]
        elif issue:
            transient = issue in cards.READ_FAILURES
            lock = {"kind":"read_retry" if transient else "risk","until":now+45 if transient else day["end"],"reason":issue,"card_id":card_id}
            db.execute("UPDATE accounts SET open_lock=? WHERE worker_id=? AND name=?",(dump(lock),wid,cmd["account"]))
            reason = issue
        elif cmd["phase"] != actual["phase"]:
            reason = "账户阶段已更新，重新选择适用的策略参数"
        elif "stop_buffer" not in cmd["params"] or cmd["phase"] != "live" and (cmd["params"].get("take_profit") is not None or "reward_ratio" in cmd["params"]):
            reason = "原指令保护参数不适用于当前账户，需重新决策"
        if not reason and lock:
            db.execute("UPDATE accounts SET open_lock=NULL WHERE worker_id=? AND name=?",(wid,cmd["account"]))
            lock = None
        profit = None
        if not reason:
            profit = daily_floor.take_profit(cmd["params"],stop["remaining_drawdown"] if stop["stop_omitted"] else amount)
            if profit is not None and profit<=0:
                reason = "盈亏比计算的止盈金额不足一美分"
        result = {"risk":actual,"changed":changed,"daily_floor":floor,"open_lock":lock,"observed_at":snap["observed_at"]}
        if reason:
            result.update(approved=False,reselect=True,reason=reason)
            finish(db,cmd["id"],"cancelled",now,reason,result)
            return result
        if changed:
            reporting.log(db,self.node_id,now,"preflight","交易页已更正缓存并通过开仓核对 · "+", ".join(changed),
                          worker=wid,account=cmd["account"],command_id=cmd["id"])
        db.execute("INSERT OR REPLACE INTO open_preflight VALUES(?,?,?)",(cmd["id"],sid,now))
        return {**result, **stop, "approved":True, "take_profit":profit}

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
        proof = obj(body.get("proof", {}))
        if stage=="open":
            require(db.execute("SELECT 1 FROM open_preflight WHERE id=? AND session=?",(cmd["id"],sid)).fetchone(),
                    "开仓前需要先完成交易页风控核对",409)
            checked = self._preflight(db,cmd,wid,sid,body,now)
            if not checked["approved"]:
                return {**checked,"authorize_click":False}
            number(proof.get("quantity"),"实际 Vest 数量",0.000001,1e12)
            if "stop_loss" not in proof or proof["stop_loss"]!=checked["stop_loss"] or proof.get("take_profit")!=checked["take_profit"]:
                if body.get("allow_refill") is True:
                    return {**checked,"authorize_click":False,"refill":True}
                reason = "最新保护金额与表单不同，重新核对后再下单"
                finish(db,cmd["id"],"cancelled",now,reason,{**checked,"approved":False,"reselect":True})
                return {**checked,"approved":False,"authorize_click":False,"reselect":True,"reason":reason}
            proof["daily_floor"] = checked["daily_floor"]
            proof["equity"] = checked["risk"]["equity"]
            proof["drawdown"] = checked["risk"]["drawdown"]
            proof["drawdown_limit"] = checked["risk"]["drawdown_limit"]
            proof["remaining_max_drawdown"] = checked["remaining_max_drawdown"]
            proof["max_drawdown_floor"] = checked["risk"].get("max_drawdown_floor")
            proof["floor_gap"] = checked["floor_gap"]
            proof["distance_to_max_floor"] = checked["distance_to_max_floor"]
            proof["stop_buffer"] = cmd["params"]["stop_buffer"]
            proof["stop_omitted"] = checked["stop_omitted"]
            proof["remaining_drawdown"] = checked["remaining_drawdown"]
            if cmd["phase"] == "live":
                proof["initial_balance"] = target(db,cmd)[1]["initial_balance"]
        if stage == "withdraw" and cmd["params"].get("all_available"):
            require(proof.get("amount") == proof.get("available") == cmd["params"]["amount"]
                    and proof.get("recipient") == "main", "页面可领总额或收款账户已变化", 409)
        if stage == "withdraw" and cmd.get("strategy_payout"):
            strategy_payout.check_origin(db,cmd,target(db,cmd)[1])
            strategy_payout.check_quote(cmd,proof,now)
        if stage == "protect" and row["action"] == "order.open":
            require("open" in intents, "尚未提交开仓", 409)
        else:
            require(now < cmd["expires_at"], "指令已过期，禁止提交", 409)
            validate_target(cmd, *target(db, cmd), now)
        require(len(dump(proof)) < 16000, "操作依据过大")
        intents[stage] = {"time": now, "proof": proof}
        db.execute("UPDATE commands SET intents=?,updated=? WHERE id=?", (dump(intents), now, row["id"]))
        reporting.log(db, self.node_id, now, "intent", "签发单次操作许可 · " + stage, worker=wid,
                      account=cmd["account"], command_id=cmd["id"])
        return {**(checked if stage=="open" else {}),"authorize_click": True}

    def _result(self, db, body, now):
        row = command(db, ident(body.get("id")))
        cmd = record(row)
        require(row["worker"] == ident(body.get("worker_id")) and cmd["session_id"] == ident(body.get("session_id")),
                "回执不属于领取该指令的会话", 409)
        late = row["status"] == "unknown" and body.get("ok") is True
        if row["status"] in TERMINAL and not late:
            if cmd["action"] in ("account.read","positions.read") and cmd["result"].get("observation"):
                worker, account = target(db,cmd)
                if (worker and account and account["present"] and not account["ambiguous"] and account["risk"]
                        and worker["session_id"]==account["read_session"]==cmd["session_id"]):
                    return {"status":row["status"],"risk":account["risk"],"open_lock":account["open_lock"],
                            "daily_floor":daily_floor.view(db,cmd["worker_id"],cmd["account"],now)}
            return {"status": row["status"]}
        require(row["status"] == "running" or late, "指令尚未领取", 409)
        ok = boolean(body.get("ok"))
        result = obj(body.get("result", {}))
        require(len(dump(result)) < 180000, "回执过大")
        error = string(body.get("error", ""), "错误信息", 500, True)
        status = "succeeded" if ok else "unknown" if cmd["intents"] else "failed"
        if status=="failed" and cmd["action"]=="order.open" and cmd["source"].startswith("strategy-") and result.get("notice_kind") in NOTICE_KINDS:
            status, result = "cancelled", {"reselect":True,"notice_kind":result["notice_kind"]}
        if row["action"] == PORTFOLIO_SCAN:
            require(not ok, "全量读取须先确认清单，再逐户提交详情", 409)
            finish(db, row["id"], status, now, error, portfolio.progress(row))
            return {"status": status}
        if ok and row["action"] in WRITE:
            try:
                step = {"order.open": "open", "order.close": "close", "profit.withdraw": "withdraw"}.get(row["action"])
                require(not step or step in cmd["intents"], "缺少操作提交记录")
                verify_financial_receipt(cmd, result)
            except Problem as err:
                status, error = "unknown", str(err)
        if ok and row["action"] == "profit.available":
            try:
                require(result.get("account") == cmd["account"] and result.get("phase") == cmd["phase"] == "live",
                        "页面可领额来源账户或阶段不符")
                number(result.get("available"),"页面可领额",0,1e12)
                number(result.get("observed_at"),"可领额读取时间",row["claimed"]-10,min(cmd["expires_at"]+RUN_TTL,now+10))
            except Problem as err:
                status, error = "failed", str(err)
        obs = result.get("observation")
        observed = None
        worker, current = target(db, cmd)
        if obs and cmd["account"] and current and current["present"] and worker["session_id"] == cmd["session_id"]:
            require(obs.get("name") == cmd["account"], "回执账户不符", 409)
            if now - 180 <= obs.get("snapshot", {}).get("observed_at", 0) <= now + 10:
                observed = self._observe(db, cmd["worker_id"], obs, now)
        finish(db, row["id"], status, now, error, result)
        if status == "succeeded":
            ledger.command_evidence(db, record(command(db, row["id"])))
        return {"status": status, **((observed or {}) if cmd["action"] in ("account.read","positions.read") else {})}
