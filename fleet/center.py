"""Controller inventory, durable command delivery and per-node strategy scheduling."""
import json
import logging
import random
import threading
import time
import uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from . import account_pool, daily_floor, ledger, positions, reporting, status_delta, strategy_config, strategy_payout, updates
from .trading_day import entry_day_window

from .protocol import (NODE_TTL, OBS_TTL, PENDING, PORTFOLIO_SCAN, RUN_TTL, TERMINAL, WORKER_TTL, WRITE, Problem, boolean,
                       bridge_url, choice, dump, fields, ident, make_command, number, obj, parameters,
                       plugin_version_parts, request, require, string, validate_target)
from .storage import Database, check_reservations, command, find_command, finish, insert, record, summary

BATCH_LIST_RETRY = 30
LIVE_READ_RETRY = 30
DAILY_READ_RETRY = 60

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


def initial_strategy(nid, config):
    return {"node_id": nid, "enabled": False, "run": None, "batch": 0, "members": [], "next_at": 0,
            "message": "尚未启动", "config": config, "draining": False}


def batch_account(opened, accounts):
    route = (opened["node_id"], opened["worker_id"], opened["account"])
    account = accounts.get(route)
    card_id = (opened.get("expected_risk") or {}).get("card_id")
    if account and account["present"]:
        current_id = (account.get("card") or {}).get("id")
        if not card_id or not current_id or card_id == current_id:
            return account
    if card_id:
        return next((a for (nid,wid,_),a in accounts.items() if (nid,wid) == route[:2] and a["present"]
                     and (a.get("card") or {}).get("id") == card_id), None)


def batch_flat(account, opened):
    if not account or not account["fresh"] or account["ambiguous"]:
        return False
    card_at, trade_at = account.get("card_at") or 0, account["observed_at"] or 0
    if account["card_fresh"] and card_at >= trade_at:
        return card_at > opened["updated_at"] and account["card"].get("active_positions") == 0
    return (trade_at > opened["updated_at"] and not account["read_error"]
            and account["read_session"] == account["listed_session"]
            and account["snapshot"].get("position_open") is False)


def exit_list_excludes(check, opened, worker, accounts):
    result = check["result"] or {}
    rows = result.get("inventory")
    if (check["status"] != "succeeded" or check["session_id"] != worker["session_id"]
            or worker.get("card_session") != worker["session_id"] or not check["claimed_at"]
            or (worker.get("cards_full_at") or 0) < check["claimed_at"]
            or result.get("source") != "accounts" or result.get("full") is not True
            or not isinstance(rows,list) or type(result.get("count")) is not int or result["count"] != len(rows)
            or any(not isinstance(r,dict) or not isinstance(r.get("name"),str) or not r["name"] for r in rows)):
        return False
    original_id = (opened.get("expected_risk") or {}).get("card_id")
    if "source_at" in result:
        if type(result["source_at"]) not in (int,float) or result["source_at"]<check["created_at"] or any(not r.get("id") for r in rows):
            return False
        if original_id:
            return all(r["id"]!=original_id for r in rows)
    matches = [r for r in rows if r["name"] == opened["account"]]
    if not matches:
        return True
    # The platform can reuse a name. The full read and the corresponding card must identify a replacement.
    a = accounts.get((opened["node_id"],opened["worker_id"],opened["account"]))
    return bool(len(matches) == 1 and not matches[0].get("ambiguous") and a and not a["ambiguous"]
                and a["card_fresh"] and a["card_at"] >= check["claimed_at"] and original_id
                and a["card"].get("id") and a["card"]["id"] != original_id)


class Center:
    def __init__(self, path, clock=time.time, transport=remote):
        self.db = Database(path)
        self.clock, self.transport = clock, transport
        self.state_feeds = {}
        manifest = Path(__file__).resolve().parents[1] / "extension" / "manifest.json"
        self.plugin_version = json.loads(manifest.read_text(encoding="utf-8"))["version"] if manifest.is_file() else ""
        self.db.conn.executescript("""
            CREATE TABLE IF NOT EXISTS nodes(
                id TEXT PRIMARY KEY, label TEXT NOT NULL, url TEXT NOT NULL UNIQUE, token TEXT NOT NULL,
                instance_id TEXT, snapshot TEXT NOT NULL DEFAULT '{"workers":[],"accounts":[]}',
                last_seen REAL, error TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS account_config(node TEXT,worker TEXT,name TEXT,alias TEXT,note TEXT,
                enabled INTEGER NOT NULL,in_pool INTEGER NOT NULL,account_ref TEXT NOT NULL DEFAULT '',PRIMARY KEY(node,worker,name));
            CREATE TABLE IF NOT EXISTS node_strategy(node TEXT PRIMARY KEY REFERENCES nodes(id), data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS directory_refresh(node TEXT PRIMARY KEY REFERENCES nodes(id),generation INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS platform_accounts(node TEXT,worker TEXT,platform_id TEXT,config_name TEXT NOT NULL,
                PRIMARY KEY(node,worker,platform_id), UNIQUE(node,worker,config_name));
            CREATE TABLE IF NOT EXISTS ledger_cursor(node TEXT PRIMARY KEY REFERENCES nodes(id), seq INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS archive_cursor(node TEXT PRIMARY KEY REFERENCES nodes(id), seq INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS log_cursor(node TEXT PRIMARY KEY REFERENCES nodes(id), seq INTEGER NOT NULL);
        """)
        ledger.schema(self.db.conn)
        reporting.log_schema(self.db.conn)
        updates.schema(self.db.conn)
        with self.db.tx() as db:
            strategy_config.initialize(db)
            columns = {r["name"] for r in db.execute("PRAGMA table_info(nodes)")}
            for col in ("history_error","log_error"):
                if col not in columns:
                    db.execute(f"ALTER TABLE nodes ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")
            if "account_ref" not in {r["name"] for r in db.execute("PRAGMA table_info(account_config)")}:
                db.execute("ALTER TABLE account_config ADD COLUMN account_ref TEXT NOT NULL DEFAULT ''")
            if "live_unlocked" not in {r["name"] for r in db.execute("PRAGMA table_info(account_config)")}:
                db.execute("ALTER TABLE account_config ADD COLUMN live_unlocked INTEGER NOT NULL DEFAULT 0")
            for row in db.execute("SELECT id,snapshot FROM nodes"):
                self._remember_accounts(db,row["id"],json.loads(row["snapshot"])["accounts"])
            self._migrate_strategies(db)
            db.execute("""UPDATE node_strategy SET data=json_set(json_remove(data,'$.config.stop_loss'),
                      '$.config.stop_buffer',20) WHERE json_extract(data,'$.config.stop_buffer') IS NULL""")
            for row in db.execute("SELECT node,data FROM node_strategy").fetchall():
                s = json.loads(row["data"])
                migrated = strategy_config.migrate(s["config"])
                if migrated != s["config"]:
                    s["config"] = migrated
                    db.execute("UPDATE node_strategy SET data=? WHERE node=?", (dump(s),row["node"]))
            ledger.backfill(db)

    def _migrate_strategies(self, db):
        old = None
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='strategy'").fetchone():
            row = db.execute("SELECT data FROM strategy WHERE id=1").fetchone()
            old = json.loads(row[0]) if row else None
        count = db.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
        for row in db.execute("SELECT id FROM nodes WHERE id NOT IN (SELECT node FROM node_strategy)").fetchall():
            nid = row["id"]
            s = initial_strategy(nid, self._default_config(db))
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
            db.execute("INSERT OR IGNORE INTO node_strategy VALUES(?,?)", (key, dump(initial_strategy(key, self._default_config(db)))))
            reporting.log(db, key, self.clock(), "node", "更新服务器配置" if prior else "登记服务器")
        return {"id": key}

    @staticmethod
    def _remember_accounts(db, node, accounts):
        for account in accounts:
            platform_id = (account.get("card") or {}).get("id")
            if not platform_id or not account["present"] or account["ambiguous"]:
                continue
            worker, name = account["worker_id"], account["name"]
            if db.execute("SELECT 1 FROM platform_accounts WHERE node=? AND worker=? AND platform_id=?",(node,worker,platform_id)).fetchone():
                continue
            while db.execute("SELECT 1 FROM platform_accounts WHERE node=? AND worker=? AND config_name=?",(node,worker,name)).fetchone():
                name = uid()
            db.execute("INSERT INTO platform_accounts VALUES(?,?,?,?)",(node,worker,platform_id,name))

    def _inventory(self, db, nid=None):
        now = self.clock()
        day = entry_day_window(now)["start"]
        args = (nid,) if nid else ()
        configs = {(r["node"], r["worker"], r["name"]): r for r in db.execute("SELECT * FROM account_config" + (" WHERE node=?" if nid else ""), args)}
        identities = {(r["node"],r["worker"],r["platform_id"]): r["config_name"] for r in
                      db.execute("SELECT * FROM platform_accounts" + (" WHERE node=?" if nid else ""),args)}
        nodes, workers, accounts = {}, {}, {}
        for row in db.execute("SELECT * FROM nodes" + (" WHERE id=?" if nid else "") + " ORDER BY label,id", args):
            nid = row["id"]
            online = bool(row["last_seen"] and now - row["last_seen"] < NODE_TTL and not row["error"])
            node = {k: row[k] for k in ("id", "label", "url", "instance_id", "last_seen", "error", "history_error", "log_error")}
            snap = json.loads(row["snapshot"])
            last = db.execute("SELECT * FROM node_updates WHERE node=? ORDER BY created DESC,rowid DESC LIMIT 1", (nid,)).fetchone()
            agent = db.execute("SELECT seen,actual FROM node_agents WHERE node=?", (nid,)).fetchone()
            refresh = db.execute("SELECT generation FROM directory_refresh WHERE node=?",(nid,)).fetchone()
            config = self._strategy(db,nid)["config"]
            nodes[nid] = {**node, "online": online, "release":snap.get("release",""), "agent_seen":agent["seen"] if agent else None,
                          "open_policy_version":snap.get("open_policy_version",0),
                          "payout_quote_version":snap.get("payout_quote_version",0),
                          "agent_release":agent["actual"] if agent else "", "update":updates.view(last) if last else None,
                          "card_generation":refresh[0] if refresh else 0}
            for w in snap["workers"]:
                actual,target = plugin_version_parts(w.get("plugin_version")),plugin_version_parts(self.plugin_version)
                status = "unknown" if not actual or not target else "current" if actual==target else "behind" if actual<target else "ahead"
                workers[nid, w["worker_id"]] = {**w, "node_id": nid, "online": online and now - w["last_seen"] < WORKER_TTL,
                                                "supports_open_policy":nodes[nid]["open_policy_version"]>=daily_floor.TWO_FLOOR_STOP_VERSION and actual>=(1,9,0,0),
                                                "plugin_version":w.get("plugin_version",""),"version_status":status}
            for a in snap["accounts"]:
                key = (nid, a["worker_id"], a["name"])
                platform_id = (a.get("card") or {}).get("id")
                config_name = identities.get((*key[:2],platform_id),a["name"])
                cfg = configs.get((*key[:2],config_name))
                worker = workers[key[:2]]
                detail = a.get("portfolio") or {}
                awaiting_daily_read = worker.get("account_refresh_day", day) < day and (
                    detail.get("session_id") != worker["session_id"] or detail.get("observed_at", 0) < day or bool(detail.get("missing")))
                card_fresh = bool(a.get("card") and a["present"] and worker["online"] and
                                  worker["session_id"]==a["listed_session"] and now-a["card_at"]<=OBS_TTL)
                eligible = a["present"] and not a["ambiguous"] and not a["excluded"] and a["category"] in ("active","eval","funded","live")
                live_locked = a["phase"] == "live" and config["live_default_locked"] and not (cfg and cfg["live_unlocked"])
                accounts[key] = {**a, "node_id": nid, "alias": cfg["alias"] if cfg else "",
                                 "note": cfg["note"] if cfg else "", "enabled": bool(cfg["enabled"]) if cfg else True,
                                 "live_default_locked":bool(live_locked),"open_locked":bool(a.get("open_lock") and now < a["open_lock"]["until"]),
                                 "in_pool": bool(eligible and not live_locked and (cfg["enabled"] and cfg["in_pool"] if cfg else a.get("card"))),
                                 "account_ref": (cfg["account_ref"] if cfg else "") or (config_name if config_name!=a["name"] else ""),
                                 "card_fresh":card_fresh, "awaiting_daily_read":awaiting_daily_read,
                                 "fresh": card_fresh or bool(worker["online"] and a.get("read_session") == a.get("listed_session") == worker["session_id"]
                                               and a["present"] and not a["read_error"]
                                               and a["observed_at"] and now - a["observed_at"] <= OBS_TTL)}
        return nodes, workers, accounts

    def state(self, node_id=None, since=None):
        with self.db.tx() as db:
            nodes, workers, accounts = self._inventory(db, node_id)
            require(not node_id or node_id in nodes, "找不到该节点", 404)
            cond, args = (" WHERE node=?", (node_id,)) if node_id else ("", ())
            recent = db.execute("SELECT * FROM commands"+cond+" ORDER BY created DESC,id DESC LIMIT 100", args)
            unknown = db.execute("SELECT COUNT(*) FROM commands WHERE status='unknown'"+(" AND node=?" if node_id else ""), args).fetchone()[0]
            strategies = [json.loads(r[0]) for r in db.execute("SELECT data FROM node_strategy"+cond+" ORDER BY node", args)]
            for a in accounts.values():
                a["position_detail"] = positions.detail(db, a)
                a["candidate"] = False
            for s in strategies:
                startup_wait = ""
                if s["enabled"] and not s["batch"] and "startup_scans" in s:
                    online = [w for w in workers.values() if w["node_id"]==s["node_id"] and w["online"]]
                    scans = s["startup_scans"]
                    if not scans or any(not v.get("confirmed") for v in scans.values()) or any(
                            scans.get(w["worker_id"],{}).get("session")!=w["session_id"] for w in online):
                        startup_wait = ("等待浏览器全量拉取账户列表" if not scans else "等待启动前全量读取账户信息完成")
                    else:
                        startup_wait = s.get("startup_position_wait","")
                for cmd in self._strategy_candidates(db,s,(nodes,workers,accounts),"buy"):
                    a = accounts[cmd["node_id"],cmd["worker_id"],cmd["account"]]
                    if startup_wait:
                        a["candidate_reason"] = startup_wait
                    else:
                        a["candidate"] = True
            result = dict(now=self.clock(), plugin_version=self.plugin_version, nodes=list(nodes.values()), workers=list(workers.values()),
                        accounts=list(accounts.values()), strategies=strategies, strategy=strategies[0] if len(strategies)==1 else None,
                        strategy_settings=strategy_config.library(db), unknown_count=unknown, commands=[summary(r) for r in recent])
            if since is None:
                return result
            if node_id not in self.state_feeds:
                self.state_feeds[node_id] = status_delta.StatusFeed(keep=4)
            return self.state_feeds[node_id].response(result, since)

    def position_metrics(self, node_id=None):
        with self.db.read() as db:
            return positions.metrics(db, node_id)

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

    def worker_mode(self, nid, wid, body):
        fields(body,("mode","session_id"))
        mode = choice(body.get("mode"),{"readonly","execute"},"浏览器模式")
        sid = ident(body.get("session_id"))
        with self.db.tx() as db:
            node = db.execute("SELECT * FROM nodes WHERE id=?",(nid,)).fetchone()
            require(node,"找不到该节点",404)
            node = dict(node)
            worker = next((w for w in json.loads(node["snapshot"])["workers"] if w["worker_id"]==wid),None)
            now = self.clock()
            require(worker and not node["error"] and now-(node["last_seen"] or 0) < NODE_TTL
                    and now-worker["last_seen"] < WORKER_TTL and worker.get("page"),"节点或浏览器离线、未绑定",409)
            require(worker["session_id"]==sid,"浏览器会话已变化，请刷新后重试",409)
            require(worker.get("mode_control"),"请升级节点桥和插件至 1.12.0",409)
            if mode == "execute":
                require(not updates.active(db,nid),"节点更新期间不能切换为执行模式",409)
        return self.transport(node,"PUT","/v1/status",{"instance_id":node["instance_id"],
                              "mode_request":{"worker_id":wid,"session_id":sid,"mode":mode}})

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

    def import_archive(self, body):
        nid, wid = ident(body.get("node_id")), ident(body.get("worker_id"))
        with self.db.tx() as db:
            node = db.execute("SELECT snapshot FROM nodes WHERE id=?",(nid,)).fetchone()
            require(node and any(w["worker_id"]==wid for w in json.loads(node[0]).get("workers",[])),
                    "找不到所选节点的浏览器",404)
            ledger.archive_rows(db,nid,wid,body.get("items"))
        return {"accepted":len(body["items"])}

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
            require(a["present"] and not a["ambiguous"],"账户已移出或名称不唯一，无法修改设置",409)
            identity = db.execute("SELECT config_name FROM platform_accounts WHERE node=? AND worker=? AND platform_id=?",
                                  (*route[:2],(a.get("card") or {}).get("id"))).fetchone()
            config_name = identity[0] if identity else route[2]
            alias, note = string(body.get("alias", a["alias"]), "别名", 80, True), string(body.get("note", a["note"]), "备注", 500, True)
            enabled, pool = boolean(body.get("enabled", a["enabled"])), boolean(body.get("in_pool", a["in_pool"]))
            ref = string(body.get("account_ref", a["account_ref"]), "交易账户标识", empty=True)
            require(not pool or not a["excluded"], "主账户不能加入策略池")
            db.execute("""INSERT INTO account_config(node,worker,name,alias,note,enabled,in_pool,account_ref,live_unlocked)
                       VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(node,worker,name) DO UPDATE SET alias=excluded.alias,
                       note=excluded.note,enabled=excluded.enabled,in_pool=excluded.in_pool,account_ref=excluded.account_ref,
                       live_unlocked=CASE WHEN ? THEN excluded.live_unlocked ELSE account_config.live_unlocked END""",
                       (*route[:2],config_name,alias,note,enabled,pool,ref,a["phase"]=="live" and pool,a["phase"]=="live" and "in_pool" in body))
            reporting.log(db, route[0], self.clock(), "account", "更新账户设置", worker=route[1], account=route[2])
            for row in db.execute("SELECT * FROM commands WHERE node=? AND worker=? AND account=?", route).fetchall():
                if ref != a["account_ref"] and row["action"] in WRITE:
                    require(row["status"] not in PENDING | {"unknown"}, "账户有未完成的资金指令，暂时无法更换交易标识", 409)
                if row["action"] in WRITE and (not enabled or not pool and json.loads(row["body"])["source"] != "manual"):
                    self._cancel(db, row)
        return {"ok": True}

    def _prepare(self, db, key, req, inventory, source="manual", reentry=None):
        nodes, workers, accounts = inventory
        route = (req["node_id"], req["worker_id"])
        node, worker = nodes.get(route[0]), workers.get(route)
        require(node and node["online"] and worker and worker["online"], "节点或浏览器离线", 409)
        require(req["action"] not in WRITE or not worker.get("pending_mode"),"浏览器权限正在切换",409)
        require(not updates.active(db,route[0]), "节点正在等待或执行软件更新", 409)
        require(not node["agent_release"] or node["agent_release"] == node["release"], "等待同步节点桥的新版本", 409)
        require(not node["release"] or worker.get("release") == node["release"], "浏览器尚未加载当前节点版本", 409)
        if req["action"] == PORTFOLIO_SCAN:
            require(worker.get("portfolio_version") == 1, "请更新节点桥并重新加载 1.4.0 或更高版本插件", 409)
        a = accounts.get((*route, req["account"]))
        if a and a["phase"] in ("1/2","2/2") and req["action"]=="position.protect":
            require("take_profit" not in req["params"],"考核账户不设止盈",409)
        if reentry or "omit_stop_below" in req["params"] or source.startswith("strategy-") and a and a["phase"]=="live":
            require(worker.get("strategy_version")==1,"Live 策略和免止损规则需要节点桥及 1.5.0 或更高版本插件",409)
        if req["action"]=="order.open" and a:
            require(worker["supports_open_policy"],
                    "开仓风控需要支持两条底线的节点桥及 1.9.0 或更高版本插件",409)
            if "reward_ratio" in req["params"]:
                require(node["open_policy_version"]>=daily_floor.TWO_FLOOR_REWARD_VERSION,
                        "Live 盈亏比止盈需要 1.12.2 或更高版本节点桥",409)
            require(a["phase"]=="live" or req["params"].get("take_profit") is None and "reward_ratio" not in req["params"],
                    "考核账户开仓不设止盈",409)
            budget = daily_floor.stop_decision(a.get("risk") or {},a.get("daily_floor"),req["params"])["stop_loss"]
            last_lock = a.get("open_lock") or {}
            reread = last_lock and last_lock["until"] <= self.clock() and (last_lock.get("kind")=="read_retry" or
                        (a.get("risk_at") or 0) < last_lock["until"])
            if budget is not None and not reread:
                require(budget>0 and budget>=req["params"].get("micro",0)*2*0.25,"净值缓冲后的止损余量不足",409)
                size = (a.get("risk") or {}).get("size_minimum")
                if size and req["params"].get("size_percent") and size["size_percent"]==req["params"]["size_percent"] and self.clock()-(a["preflight_at"] or 0)<60:
                    require(budget>=size["minimum"],"止损余量不足当前仓位的一个价格跳动",409)
        require(req["action"] not in WRITE or a and a["enabled"], "账户已停用或不存在", 409)
        cmd = make_command(key, req, node, worker, a, self.clock(), source)
        if reentry:
            cmd["reentry_claim"] = reentry
        validate_target(cmd, worker, a, self.clock())
        check_reservations(db, cmd, self.clock(), shared=True)
        return cmd

    def submit(self, key, body):
        req = request(body)
        with self.db.tx() as db:
            prior = find_command(db, ident(key))
            inventory = None if prior else self._inventory(db,req["node_id"])
            if req["action"]=="order.open" and "stop_buffer" not in body.get("params",{}):
                if prior:
                    req["params"]["stop_buffer"] = json.loads(prior["body"])["params"].get("stop_buffer",20)
                else:
                    account = inventory[2].get((req["node_id"],req["worker_id"],req["account"]),{})
                    key_name = "live_stop_buffer" if account.get("phase")=="live" else "stop_buffer"
                    req["params"]["stop_buffer"] = self._strategy(db,req["node_id"])["config"][key_name]
            if prior:
                old = json.loads(prior["body"])
                require(old["source"] == "manual" and all(old[k] == v for k, v in req.items()), "该 ID 已用于其他指令", 409)
            else:
                cmd = self._prepare(db, key, req, inventory)
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

    def _queue_closed_history(self, db, nid, snapshot):
        events = [a for a in snapshot["accounts"] if a.get("history_due_at") and a["present"] and not a["ambiguous"]]
        if not events:
            return
        inventory = self._inventory(db,nid)
        for a in events:
            event = [snapshot["instance_id"],a["worker_id"],a["name"],a["history_due_at"]]
            key = str(uuid.uuid5(uuid.NAMESPACE_URL,dump(event)))
            if find_command(db,key):
                continue
            req = dict(node_id=nid,worker_id=a["worker_id"],account=a["name"],action="history.read",params={})
            try:
                cmd = self._prepare(db,key,req,inventory,"card-close")
            except Problem:
                continue
            insert(db,cmd,"pending",self.clock())

    def sync(self, nid, *, metrics_only=False):
        with self.db.tx() as db:
            node = dict(db.execute("SELECT * FROM nodes WHERE id=?", (nid,)).fetchone())
        try:
            previous = json.loads(node["snapshot"])
            cursor = previous.get("status_cursor")
            if metrics_only and (not cursor or node["error"]):
                return
            response = self.transport(node, "GET", "/v1/status?since="+(ident(cursor) if cursor else "initial"))
            def directory(snapshot):
                return {(a["worker_id"],a["name"],(a.get("card") or {}).get("id")) for a in snapshot["accounts"]
                        if a["present"] and not a["ambiguous"]}
            old_directory = directory(previous)
            snap = status_delta.unpack(previous, response)
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
                                      WHERE id=? AND revision=? AND snapshot=?""",
                                     (dump(snap), instance, self.clock(), nid, node["revision"], node["snapshot"]))
                if not updated.rowcount:
                    return
                if old_directory!=directory(snap):
                    self._remember_accounts(db,nid,snap["accounts"])
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
                if metrics_only:
                    return
                self._queue_daily_reads(db, nid, snap["workers"])
                self._queue_closed_history(db,nid,snap)
                todo = [r[0] for r in db.execute("""SELECT id FROM commands WHERE node=? AND
                        status IN ('pending','sending','queued','running','unknown') ORDER BY created,id""", (nid,))]
                requested = db.execute("SELECT generation FROM directory_refresh WHERE node=?",(nid,)).fetchone()
                control = {}
                if "notice_until" in snap:
                    state = self._strategy(db,nid)
                    allow = bool(state["enabled"] and not state.get("draining") and snap.get("notice_waiting"))
                    if allow and snap["notice_until"] < self.clock()+5 or not allow and snap["notice_until"]:
                        control["allow_notices"] = allow
                if requested and "card_generation" in snap and snap["card_generation"] < requested[0]:
                    control["generation"] = requested[0]
            if control:
                self.transport(node,"PUT","/v1/status",{"instance_id":instance,**control})
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
                    if stream=="ledger" and "archive_seq" in snap:
                        self._sync_stream(node,instance,"archive",snap["archive_seq"])
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
        table = {"ledger":"ledger_cursor","archive":"archive_cursor","logs":"log_cursor"}[stream]
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
                    kind = choice(item.get("kind"), ledger.BOOK_KINDS, "历史类型")
                    ledger.save(db, route, kind, string(item.get("ref"), "历史编号", 350), obj(item.get("data")))
                db.execute(f"""INSERT INTO {table} VALUES(?,?) ON CONFLICT(node) DO UPDATE
                           SET seq=MAX(seq,excluded.seq)""", (nid, last))

    @staticmethod
    def _strategy(db, nid):
        row = db.execute("SELECT data FROM node_strategy WHERE node=?", (nid,)).fetchone()
        require(row, "找不到该节点", 404)
        return json.loads(row[0])

    @staticmethod
    def _default_config(db):
        return json.loads(db.execute("SELECT config FROM strategy_defaults WHERE slot=1").fetchone()[0])

    def save_defaults(self, body):
        with self.db.tx() as db:
            config = strategy_config.settings(self._default_config(db), body)
            db.execute("UPDATE strategy_defaults SET config=? WHERE slot=1", (dump(config),))
            return config

    def preset(self, key, body, remove=False):
        key = ident(key)
        with self.db.tx() as db:
            if remove:
                require(db.execute("DELETE FROM strategy_presets WHERE id=?", (key,)).rowcount, "找不到预设", 404)
                return {"ok":True}
            fields(body, ("name","config"))
            name = string(body.get("name"), "预设名称", 80)
            require(not db.execute("SELECT 1 FROM strategy_presets WHERE name=? AND id!=?",(name,key)).fetchone(),
                    "此预设名称已被使用", 409)
            prior = db.execute("SELECT config FROM strategy_presets WHERE id=?", (key,)).fetchone()
            config = strategy_config.settings(json.loads(prior[0]) if prior else self._default_config(db), obj(body.get("config")))
            db.execute("""INSERT INTO strategy_presets VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET
                       name=excluded.name,config=excluded.config""", (key,name,dump(config)))
            return {"id":key,"name":name,"config":config}

    def _save_strategy(self, db, strategy, event=None):
        nid = strategy["node_id"]
        updated = db.execute("UPDATE node_strategy SET data=? WHERE node=? AND data!=?", (dump(strategy), nid, dump(strategy)))
        if updated.rowcount:
            reporting.log(db, nid, self.clock(), "strategy", event or strategy["message"],
                          "warning" if "暂停" in strategy["message"] else "info")
        return strategy

    def _pause(self, db, s, message):
        s.update(enabled=False, draining=False, planned=[], message=message)
        if s.get("run"):
            for row in db.execute("SELECT * FROM commands WHERE node=? AND json_extract(body,'$.source')=?",
                                  (s["node_id"],"strategy-"+s["run"])).fetchall():
                self._cancel(db, row)
        for key in s["members"]:
            row = command(db,key)
            if row["node"] == s["node_id"]:
                self._cancel(db,row)

    def _request_cards(self, db, nid):
        self._strategy(db,nid)
        gen = int(self.clock()*1000000)
        db.execute("""INSERT INTO directory_refresh VALUES(?,?) ON CONFLICT(node) DO UPDATE SET
                   generation=MAX(directory_refresh.generation+1,excluded.generation)""",(nid,gen))
        return db.execute("SELECT generation FROM directory_refresh WHERE node=?",(nid,)).fetchone()[0]

    def refresh_accounts(self, nid):
        with self.db.tx() as db:
            generation = self._request_cards(db,nid)
            reporting.log(db,nid,self.clock(),"account","已请求全量拉取账户列表")
            return {"generation":generation}

    def _queue_account_scan(self, db, inventory, worker, source="manual", since=0):
        nid, wid = worker["node_id"], worker["worker_id"]
        prior = db.execute("""SELECT id FROM commands WHERE node=? AND worker=? AND action=?
            AND status IN ('pending','sending','queued','running') AND json_extract(body,'$.session_id')=?
            AND created>=? ORDER BY created LIMIT 1""", (nid, wid, PORTFOLIO_SCAN, worker["session_id"], since)).fetchone()
        if prior:
            return prior["id"]
        req = request(dict(node_id=nid, worker_id=wid, action=PORTFOLIO_SCAN))
        cmd = self._prepare(db, uid(), req, inventory, source)
        insert(db, cmd, "pending", self.clock())
        return cmd["id"]

    def _queue_daily_reads(self, db, nid, workers):
        now = self.clock()
        day = entry_day_window(now)["start"]
        due = [w for w in workers if w.get("account_refresh_day", day) < day and
               w.get("portfolio_version") == 1 and now - w["last_seen"] < WORKER_TTL
               and (w.get("portfolio_scan") or {}).get("status") not in PENDING]
        if not due:
            return
        inventory = self._inventory(db, nid)
        for w in due:
            wid = w["worker_id"]
            # A partial scan may need to wait for the platform's own day reset.
            recent = db.execute("""SELECT 1 FROM commands WHERE node=? AND worker=? AND action=?
                AND json_extract(body,'$.session_id')=? AND status IN ('succeeded','failed','expired','cancelled')
                AND created>=? AND updated>=? LIMIT 1""", (nid, wid, PORTFOLIO_SCAN, w["session_id"], day, now-DAILY_READ_RETRY)).fetchone()
            if not recent:
                try:
                    self._queue_account_scan(db, inventory, inventory[1][nid,wid], "daily-refresh")
                except Problem:
                    continue  # A node or extension update in progress can temporarily prevent reads.

    def read_accounts(self, nid):
        with self.db.tx() as db:
            inventory = self._inventory(db, nid)
            require(nid in inventory[0], "找不到该节点", 404)
            ids, skipped = [], []
            for worker in inventory[1].values():
                if not worker["online"]:
                    continue
                wid = worker["worker_id"]
                if worker.get("portfolio_version") != 1:
                    skipped.append(wid)
                    continue
                ids.append(self._queue_account_scan(db, inventory, worker))
            require(ids, "请更新节点桥并重新加载 1.4.0 或更高版本插件" if skipped else "此节点尚无在线浏览器", 409)
            return {"commands": ids, "skipped": skipped}

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
                if s.get("run"):
                    require(not db.execute("""SELECT 1 FROM commands WHERE node=? AND json_extract(body,'$.source')=?
                        AND status IN ('pending','sending','queued','running','unknown') LIMIT 1""",
                        (node_id,"strategy-"+s["run"])).fetchone(),"上一轮策略仍有未结束的指令",409)
                self._request_cards(db,node_id)
                s.pop("exit_lists",None)
                s.pop("startup_position_wait",None)
                s.update(enabled=True, draining=False, run=uid(), batch=0, members=[], replace=0,
                         started_at=self.clock(), next_at=self.clock(), message="等待浏览器全量拉取账户列表",planned=[], reentries={}, claims={},
                         policy_version=2, startup_scans={}, avoid_once=[], pool_day=entry_day_window(self.clock())["start"])
                for key in ("pool_exam_ids","pool_live_ids","pool_waiting_live_ids","pool_refilling","run_pool","batch_side","batch_phase"):
                    s.pop(key,None)
            elif op == "config":
                require(not s["enabled"], "请先停止策略再修改参数", 409)
                s["config"] = strategy_config.settings(s["config"], body)
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
                    if s["enabled"] and (s["members"] or now >= s["next_at"]):
                        self._decide_node(db, s, self._inventory(db, nid), now)
            except Exception as err:
                logging.exception("节点 %s 策略调度失败", nid)
                with self.db.tx() as db:
                    s = self._strategy(db, nid)
                    self._pause(db, s, "节点策略异常，已暂停 · "+str(err)[:200])
                    self._save_strategy(db, s)

    def _strategy_candidates(self, db, s, inventory, side):
        config = s["config"]
        for (nid,wid,name), a in inventory[2].items():
            if nid != s["node_id"] or not a["in_pool"]:
                continue
            worker = inventory[1][nid,wid]
            reason = None
            if not inventory[0][nid]["online"]:
                reason = "节点离线"
            elif not worker["online"]:
                reason = "浏览器离线"
            elif worker.get("pending_mode"):
                reason = "等待插件确认权限切换"
            elif worker["mode"] != "execute":
                reason = "浏览器处于只读模式"
            elif worker.get("notice_waiting"):
                reason = "等待处理账户弹窗"
            elif a["awaiting_daily_read"]:
                reason = "等待美东日切后的账户风控读数"
            elif not a["fresh"]:
                reason = "等待当前浏览器会话更新账户读数"
            elif a["phase"] not in account_pool.PHASES:
                reason = "账户阶段尚未确认"
            if reason:
                a["candidate_reason"] = reason
                continue
            prefix = "live_" if a["phase"] == "live" else ""
            params = {key:config[prefix+key] for key in ("size_percent","stop_buffer")}
            if a["phase"] == "2/2":
                params["size_percent"] = config["phase2_size_percent"]
            if a["phase"] == "live":
                mode = config["live_take_profit_mode"]
                if mode == "ratio":
                    params.update(reward_ratio=config["live_reward_ratio"],min_take_profit=config["live_min_take_profit"])
                elif mode == "entries":
                    tier = "repeat" if self._opened_today(db,a) else "first"
                    params.update(take_profit=config["live_"+tier+"_take_profit"],size_percent=config["live_"+tier+"_size_percent"])
                else:
                    params["take_profit"] = config["live_take_profit"]
                if mode != "ratio" and params["take_profit"] is None:
                    a["candidate_reason"] = "Live 止盈金额尚未设置"
                    continue
            params["side"] = side
            if config[prefix+"skip_stop_loss_on_low_drawdown"]:
                params["omit_stop_below"] = config[prefix+"drawdown_stop_loss_threshold"]
            if config["skip_stop_loss_on_floor_gap"]:
                params["omit_floor_gap_below"] = config["floor_gap_threshold"]
            req = dict(node_id=nid,worker_id=wid,account=name,action="order.open",params=params)
            reentry = s.get("reentries",{}).get(a["account_ref"] or name)
            if reentry and command(db,reentry)["worker"] != wid:
                a["candidate_reason"] = "再入场须使用原领取浏览器"
                continue
            try:
                yield self._prepare(db,uid(),req,inventory,"strategy-"+(s.get("run") or "preview"),reentry)
            except Problem as err:
                a["candidate_reason"] = str(err)

    def _startup_details(self, db, s, inventory):
        scans = s["startup_scans"]
        workers = [w for w in inventory[1].values() if w["online"]]
        for w in workers:
            wid = w["worker_id"]
            prior = scans.get(wid)
            if prior and prior["session"] == w["session_id"]:
                continue
            key = self._queue_account_scan(db, inventory, w, "strategy-"+s["run"], s.get("started_at", 0))
            scans[wid] = {"id":key,"session":w["session_id"]}
        complete = 0
        for wid, scan in scans.items():
            if scan.get("confirmed"):
                complete += 1
                continue
            receipt = command(db,scan["id"])
            if receipt["status"] in PENDING:
                continue
            detail = json.loads(receipt["result"] or "null") or {}
            items = detail.get("accounts") or []
            if (receipt["status"]!="succeeded" or detail.get("stage")!="done" or detail.get("total")!=len(items)
                    or detail.get("read")!=len(items) or detail.get("partial") or detail.get("failed")):
                label = inventory[1].get((s["node_id"],wid),{}).get("label",wid)
                reason = receipt["error"] or f"完整 {detail.get('read',0)} / {detail.get('total',0)}，字段不全 {detail.get('partial',0)}"
                incomplete = [i["name"] for i in items if i.get("status")!="read"]
                if incomplete:
                    reason += " · "+ "、".join(incomplete[:3])
                raise Problem("启动前全量读取账户信息未完成 · "+label+" · "+reason,409)
            # A receipt can reach the center one sync before the snapshot containing its account details.
            for item in items:
                account = inventory[2].get((s["node_id"],wid,item["name"]))
                if account and account["present"] and (account.get("card") or {}).get("id")==item["card_id"] and (
                        (account.get("portfolio") or {}).get("observed_at",0) < item["values"]["observed_at"]):
                    break
            else:
                scan["confirmed"] = True
                complete += 1
        if workers and complete==len(scans):
            return True
        s["message"] = f"启动前全量读取账户信息 · 已确认 {complete} / {len(scans)} 个浏览器"
        return False

    def _startup_positions_flat(self, db, s, inventory, now, has_candidates):
        nid = s["node_id"]
        started = s.get("started_at",s["next_at"])
        seen = {}
        for (_,wid,name), a in inventory[2].items():
            if a["present"]:
                held = seen.setdefault(wid,[])
                if (positions.latest_count(a) or 0)>0:
                    held.append((name,max(a.get("card_at") or 0,a.get("observed_at") or 0)))
        workers = {wid:worker for (_,wid), worker in inventory[1].items()}
        waits = [wid+" 离线，等待复核持仓" for wid in s["startup_scans"] if wid not in workers]
        for wid, worker in workers.items():
            scan = s["startup_scans"].get(wid)
            held = seen.get(wid,[])
            count, at = worker.get("position_count"), worker.get("positions_at") or 0
            if not worker["online"]:
                if scan or wid in seen or count:
                    waits.append(wid+" 离线，等待复核持仓")
                continue
            if not scan or worker.get("card_session")!=worker["session_id"]:
                waits.append(wid+" 等待当前会话同步")
                continue
            if "position_count" not in worker or plugin_version_parts(worker.get("plugin_version"))<(1,12,2,0):
                waits.append(wid+" 需升级节点桥及插件至 1.12.2 或更高版本")
                continue
            # A disappearing card, a P&L of zero, or a previous session cannot confirm a flat browser.
            last_open = max([scan.get("last_open_at",0),at if count else 0]+[t for _,t in held])
            if last_open:
                scan["last_open_at"] = last_open
            fresh = at>=started and now-at<BATCH_LIST_RETRY
            if count==0 and at>=started and at>last_open and (fresh or not has_candidates):
                scan.pop("visible_holding",None)
                continue
            just_disappeared = scan.get("visible_holding") and not held
            scan["visible_holding"] = bool(held)
            if held:
                waits.append(wid+" · "+ "、".join(name for name,_ in held[:3]))
            elif count:
                waits.append(f"{wid} · {count} 笔")
            else:
                waits.append(wid+" 等待最新持仓响应")
            if count and fresh and not just_disappeared:
                continue
            # A full list command reuses Vest's page reads and also checks accounts absent from the grid.
            prior = command(db,scan["position_request"]) if scan.get("position_request") else None
            if prior and (prior["status"] in PENDING or now-prior["updated"]<BATCH_LIST_RETRY):
                continue
            req = request(dict(node_id=nid,worker_id=wid,action="accounts.list"))
            try:
                check = self._prepare(db,uid(),req,inventory,"strategy-"+s["run"])
            except Problem as err:
                waits[-1] += " · "+str(err)
                continue
            insert(db,check,"pending",now)
            scan["position_request"] = check["id"]
        if waits:
            s["startup_position_wait"] = s["message"] = "首批开仓等待确认全部空仓 · "+" / ".join(waits)
            return False
        s.pop("startup_position_wait",None)
        return True

    def _opened_today(self, db, account):
        start = entry_day_window(self.clock())["start"]
        ref = account["account_ref"] or account["name"]
        # A retry or cancelled command consumes no tier. Platform position history has an actual opening time.
        now = self.clock()
        return bool(db.execute("""SELECT 1 FROM commands WHERE action='order.open'
            AND COALESCE(json_extract(body,'$.account_ref'),account)=?
            AND (status='succeeded' OR status='resolved' AND json_extract(result,'$.executed')=1)
            AND COALESCE(json_extract(intents,'$.open.time'),created) BETWEEN ? AND ? LIMIT 1""",(ref,start,now)).fetchone() or db.execute(
            """SELECT 1 FROM book b LEFT JOIN account_config c ON c.node=b.node AND c.worker=b.worker AND c.name=b.account
            WHERE b.kind='position' AND COALESCE(NULLIF(c.account_ref,''),b.account)=? AND b.at>=?
            AND json_extract(b.data,'$.opened_at') BETWEEN ? AND ? LIMIT 1""",(ref,start,start,now)).fetchone())

    def _refresh_strategy_directory(self, db, s, inventory, now):
        nid = s["node_id"]
        node = inventory[0][nid]
        online = [w for w in inventory[1].values() if w["online"]]
        day = entry_day_window(now)["start"]
        legacy_rollover = (s["config"]["refresh_account_pool"] and s.get("pool_day", day) < day
                           and any("account_refresh_day" not in w for w in online))
        if not node["card_generation"] or legacy_rollover:
            self._request_cards(db,nid)
            s["pool_day"] = day
            return False
        return bool(online) and all(w.get("card_generation") == node["card_generation"] and
                   (w["mode"] != "execute" or w.get("card_session") == w["session_id"]) for w in online)

    def _discover_phase(self, db, s, inventory):
        # Only a previously unclassified card needs a targeted read. Regular monitoring stays on /accounts.
        for (nid,wid,name), a in inventory[2].items():
            if a["phase"] or not a["in_pool"] or not a["fresh"] or inventory[1][nid,wid]["mode"] != "execute":
                continue
            generation = inventory[0][nid]["card_generation"]
            key = str(uuid.uuid5(uuid.NAMESPACE_URL,dump([s["run"],generation,wid,name,(a.get("card") or {}).get("id")])))
            prior = find_command(db,key)
            if prior and prior["status"] not in PENDING:
                continue
            if not prior:
                req = request(dict(node_id=nid,worker_id=wid,account=name,action="account.read"))
                insert(db,self._prepare(db,key,req,inventory,"strategy-"+s["run"]),"pending",self.clock())
            return True
        return False

    def _strategy_pool(self, s, inventory, candidates):
        accounts = {}
        conflicts = set()
        for a in inventory[2].values():
            if not a["in_pool"] or a.get("open_locked") or a["phase"] not in account_pool.PHASES:
                continue
            ref = a["account_ref"] or a["name"]
            if ref in accounts and accounts[ref]["phase"] != a["phase"]:
                conflicts.add(ref)
            accounts[ref] = {"phase":a["phase"],"status":"active","phase_started_at":a.get("phase_started_at")}
        for ref in conflicts:
            accounts.pop(ref)
            candidates.pop(ref,None)
        return accounts

    def _plan_orders(self, s, inventory, candidates, members):
        cfg = s["config"]
        ranks = account_pool.account_priority_ranks(cfg)
        accounts = self._strategy_pool(s,inventory,candidates)
        replacing = s.get("replace",0)
        size = replacing or cfg["batch_size"]
        eligible = list(candidates)
        if replacing:
            taken = {m["account_ref"] for m in members} | {p["ref"] for p in s["planned"]}
            eligible = [ref for ref in eligible if ref not in taken and
                        (not s.get("batch_phase") or accounts[ref]["phase"] == s["batch_phase"]) and
                        cfg[("live_" if accounts[ref]["phase"] == "live" else "")+"side"] in ("random",s["batch_side"])]
            preferred = [ref for ref in eligible if ref not in s.get("avoid_once",[])]
            if len(preferred) >= size:
                eligible = preferred
        picked = account_pool.choose_pool_batch(s,{**cfg,"batch_size":size},accounts,eligible,lambda a:a["phase"],ranks,random)
        if not picked:
            s["message"] = f"等待可用账户 · {len(eligible)} 个就绪 / 目标 {size} 个"
            return False
        if not replacing:
            preferences = [cfg[("live_" if accounts[ref]["phase"] == "live" else "")+"side"] for ref in picked]
            s["batch_side"] = account_pool.choose_batch_side(cfg["strategy_id"],random,preferences)
            s["batch_phase"] = accounts[picked[0]]["phase"] if cfg["pool_strategy"] == "same_stage" else None
            s["batch"] += 1
        if ranks:
            picked.sort(key=lambda ref:ranks[accounts[ref]["phase"]])
        s["planned"].extend({"ref":ref,"phase":accounts[ref]["phase"]} for ref in picked)
        if cfg["pool_limits_enabled"] or cfg["pool_strategy"] != "random":
            admitted = s.setdefault("pool_exam_ids",[])
            admitted.extend(ref for ref in picked if accounts[ref]["phase"] != "live" and ref not in admitted)
        s.update(replace=max(0,replacing-len(picked)),avoid_once=[])
        return True

    def _live_exit(self, db, s, opened, account, inventory, now):
        """Reconcile at most one payout for a strategy-owned exit. A verified debit can release one reentry."""
        if s.get("policy_version") != 2 or opened["phase"] != "live" or opened["source"] != "strategy-"+s["run"]:
            return True
        claims = s.setdefault("claims",{})
        claim = claims.setdefault(opened["id"],{})
        if claim.get("done"):
            return True
        if claim.get("withdraw"):
            row = command(db,claim["withdraw"])
            if row["status"] in PENDING:
                s["message"] = "等待 Live 利润领取和扣款核验"
                return False
            require(row["status"] == "succeeded","Live 利润领取未确认 · "+(row["error"] or row["status"]),409)
            if account and account["name"] == opened["account"]:
                s["reentries"][opened["account_ref"]] = row["id"]
                if s["config"]["pool_strategy"] != "dynamic" and account["in_pool"]:
                    s["planned"].append({"ref":opened["account_ref"],"phase":"live"})
                    s["next_at"] = now + self._strategy_delay(s,"order")
            claim["done"] = True
            return True
        if not account or not account["in_pool"] or account["phase"] != "live":
            claim["done"] = True
            return True
        if account["name"] != opened["account"]:
            s["message"] = "Live 开仓账户已更名，等待核对领取账户"
            return False
        req = dict(node_id=opened["node_id"],worker_id=opened["worker_id"],account=opened["account"])
        node, worker = inventory[0][req["node_id"]], inventory[1][req["node_id"],req["worker_id"]]
        for step, label in (("read","平仓后余额"),("quote","页面可领额")):
            if not claim.get(step):
                continue
            last = record(command(db,claim[step]))
            if last["status"] == "succeeded":
                continue
            if last["status"] in PENDING:
                s["message"] = "等待读取 Live "+label
                return False
            retry = (last.get("result") or {}).get("read_retry")
            transient = retry == "navigation" or step=="read" and retry=="balance" or last["error"] in {
                "页面跳转未完成或授权已变化","浏览器会话已更换","浏览器会话已更换，请刷新后重新下达指令",
                "执行超时，未签发资金操作许可","浏览器离线，请先连接插件"}
            require(not last["intents"] and last["action"]==("account.read" if step=="read" else "profit.available") and
                    (last["status"]=="expired" or last["status"] in ("failed","cancelled") and transient),
                    "Live "+label+"读取失败 · "+(last["error"] or last["status"]),409)
            if now < last["updated_at"]+LIVE_READ_RETRY:
                s["message"] = "Live "+label+"读取中断，等待重试"
                return False
            del claim[step]
        if not worker["online"] or worker["mode"] != "execute" or account["listed_session"] != worker["session_id"]:
            s["message"] = "等待浏览器恢复执行绑定并同步活动账户，继续 Live 平仓结算"
            return False
        snap = account["snapshot"]
        if (account["read_session"] != worker["session_id"] or account["read_error"]
                or snap.get("position_open") is not False or snap.get("unrealized_pnl") != 0 or not account["observed_at"]
                or account["observed_at"] <= opened["updated_at"] or now-account["observed_at"] > OBS_TTL):
            reading = db.execute("""SELECT 1 FROM commands WHERE node=? AND worker=? AND account=?
                AND action IN ('history.read','account.read') AND status IN ('pending','sending','queued','running')
                AND created>=? LIMIT 1""",(req["node_id"],req["worker_id"],req["account"],opened["updated_at"])).fetchone()
            s["message"] = "等待平仓后的 Live 账户余额"
            if reading:
                return False
            read = record(command(db,claim["read"])) if claim.get("read") else None
            if not read or read["session_id"] != worker["session_id"] or now-read["updated_at"] > OBS_TTL:
                cmd = self._prepare(db,uid(),request({**req,"action":"account.read"}),inventory,opened["source"])
                insert(db,cmd,"pending",now)
                claim["read"] = cmd["id"]
            return False
        if not node["payout_quote_version"] or plugin_version_parts(worker.get("plugin_version")) < (1,7,1,0):
            s["message"] = "等待节点桥和插件升级以读取 Live 页面可领额"
            return False
        quote = record(command(db,claim["quote"])) if claim.get("quote") else None
        if not quote or quote["session_id"] != worker["session_id"] or now-quote["result"]["observed_at"] > OBS_TTL:
            cmd = self._prepare(db,uid(),request({**req,"action":"profit.available","params":{}}),inventory,opened["source"])
            insert(db,cmd,"pending",now)
            claim["quote"] = cmd["id"]
            s["message"] = "等待读取 Portfolio 页面可领额"
            return False
        available = number(quote["result"].get("available"),"页面可领额",0,1e12)
        if available == 0:
            claim["done"] = True
            return True
        policy = {k:v for k,v in s["config"].items() if k.startswith("live_payout_")}
        policy.update(open_id=opened["id"],quote_id=quote["id"])
        amount = strategy_payout.amount(available,policy)
        require(amount is not None, "页面可领额不足配置的领取金额",409)
        key = str(uuid.uuid5(uuid.NAMESPACE_URL,dump(["strategy-payout",opened["id"]])))
        cmd = self._prepare(db,key,request({**req,"action":"profit.withdraw","params":{"amount":amount}}),inventory,opened["source"])
        cmd["strategy_payout"] = policy
        strategy_payout.check_origin(db,cmd,account)
        insert(db,cmd,"pending",now)
        claim["withdraw"] = cmd["id"]
        s["message"] = "等待 Live 利润领取和扣款核验"
        return False

    @staticmethod
    def _strategy_delay(s,kind):
        cfg = s["config"]
        return random.uniform(cfg[kind+"_delay_min"],cfg[kind+"_delay_max"])

    def _verify_batch_lists(self, db, s, members, accounts_by_order, inventory, now):
        """Recheck missing accounts and stalled position telemetry with one list read per worker."""
        _, workers, accounts = inventory
        checks = s.setdefault("exit_lists",{})
        confirmed, pending_workers, requests, receipts = set(), set(), {}, {}
        stalled = False
        for opened in members:
            key, wid = opened["id"], opened["worker_id"]
            if key not in accounts_by_order:
                continue
            entry = checks.get(key,{})
            account = accounts_by_order[key]
            if account is None and entry.get("removed"):
                confirmed.add(key)
                continue
            if account is not None:
                if entry.get("removed"):
                    checks.pop(key)
                    entry = {}
                card = account.get("card") or {}
                last_sample = account.get("card_at") if card.get("active_positions") is not None else None
                if batch_flat(account,opened) or now-max(opened["updated_at"],last_sample or 0)<BATCH_LIST_RETRY:
                    checks.pop(key,None)
                    continue
                stalled = True
            worker = workers.get((s["node_id"],wid))
            if not worker or not worker["online"]:
                continue
            check_id = entry.get("id")
            if check_id:
                if check_id not in receipts:
                    receipts[check_id] = record(command(db,check_id))
                check = receipts[check_id]
                if check["status"] in PENDING:
                    pending_workers.add(wid)
                    continue
                if account is None and exit_list_excludes(check,opened,worker,accounts):
                    entry["removed"] = True
                    confirmed.add(key)
                    continue
                if now - check["updated_at"] < BATCH_LIST_RETRY:
                    continue
            requests.setdefault(wid,[]).append(key)
        for wid, keys in requests.items():
            if wid in pending_workers:
                continue
            req = request(dict(node_id=s["node_id"],worker_id=wid,action="accounts.list"))
            since = max(m["updated_at"] for m in members if m["id"] in keys)
            existing = db.execute("""SELECT id,created FROM commands WHERE node=? AND worker=? AND action='accounts.list'
                AND status IN ('pending','sending','queued','running') ORDER BY created DESC LIMIT 1""",(s["node_id"],wid)).fetchone()
            if existing:
                if existing["created"]<since:
                    continue
                check_id = existing["id"]
            else:
                try:
                    check = self._prepare(db,uid(),req,inventory,"strategy-"+(s.get("run") or "legacy"))
                except Problem:
                    continue
                insert(db,check,"pending",now)
                check_id = check["id"]
            for key in keys:
                checks[key] = {"id":check_id}
        return confirmed,stalled

    def _monitor_batch(self, db, s, members, inventory, now):
        accounts = {m["id"]:batch_account(m,inventory[2]) for m in members if m["status"] == "succeeded"}
        missing = [m for m in members if m["id"] in accounts and accounts[m["id"]] is None]
        removed,stalled = self._verify_batch_lists(db,s,members,accounts,inventory,now)
        complete = True
        for opened in members:
            account = accounts.get(opened["id"])
            if opened["id"] not in removed and not batch_flat(account,opened):
                complete = False
                continue
            if not s.get("draining") and not self._live_exit(db,s,opened,account,inventory,now):
                return
        if s["planned"]:
            s["message"] = "Live 领取已核验，等待本批同向再入场"
        elif not complete:
            if len(removed)<len(missing):
                s["message"] = "等待全量拉取活动账户列表，核对本批已移出的账户"
            elif stalled:
                s["message"] = "持仓读数未更新，等待全量拉取账户列表复核"
            else:
                s["message"] = "等待本批全部持仓确认结束"
        else:
            s.pop("exit_lists",None)
            s["members"] = []
            if s.get("draining"):
                s.update(enabled=False,draining=False,message="升级前的批次已结束")
            else:
                s.update(claims={},next_at=now+self._strategy_delay(s,"batch"),message="批间等待")

    def _advance_node(self, db, s, inventory, now):
        s.setdefault("planned",[])
        members = [record(command(db,k)) for k in s["members"]]
        for m in members[:]:
            if m["status"] not in TERMINAL or m["status"] == "succeeded":
                continue
            day_end = entry_day_window(m["created_at"])["end"]
            rolled = (m["status"] == "expired" and
                      m["expires_at"] == day_end and now >= day_end and not m["intents"])
            reselect = m["status"] == "cancelled" and not m["intents"] and (m["result"] or {}).get("reselect")
            if not (rolled or reselect):
                self._pause(db,s,f"第 {s['batch']} 批已暂停 · {m['error'] or m['status']}")
                return
            a = inventory[2].get((m["node_id"],m["worker_id"],m["account"]))
            if reselect and a and a["present"] and (a.get("risk_at") or 0) < m["result"].get("observed_at",0):
                s["message"] = "等待节点同步已修正的交易页风控读数"
                return
            s.setdefault("avoid_once",[]).append(m["account_ref"])
            s["replace"] = s.get("replace",0)+1
            s["members"].remove(m["id"])
            members.remove(m)
            if m.get("reentry_claim"):
                s.setdefault("reentries",{})[m["account_ref"]] = m["reentry_claim"]
        if now < s["next_at"]:
            return
        if updates.active(db,s["node_id"]):
            s["message"] = "等待节点完成软件更新"
            return
        if not self._refresh_strategy_directory(db,s,inventory,now):
            s["message"] = "等待浏览器全量拉取账户列表"
            return
        startup = not s["batch"] and "startup_scans" in s
        if startup and not self._startup_details(db,s,inventory):
            return
        if members and not s["planned"] and not s.get("replace"):
            self._monitor_batch(db,s,members,inventory,now)
            return
        candidates = {}
        for cmd in self._strategy_candidates(db,s,inventory,s.get("batch_side","buy")):
            candidates.setdefault(cmd["account_ref"],[]).append(cmd)
        if startup and not self._startup_positions_flat(db,s,inventory,now,bool(candidates)):
            return
        if not s["planned"] and not self._plan_orders(s,inventory,candidates,members):
            if any(a["in_pool"] and a["awaiting_daily_read"] and inventory[1][nid,wid]["online"]
                   and inventory[1][nid,wid]["mode"] == "execute" for (nid,wid,_),a in inventory[2].items()):
                s["message"] = "等待美东日切后全量读取账户信息"
            elif self._discover_phase(db,s,inventory):
                s["message"] = "等待读取新账户的阶段"
            elif not s["config"]["refresh_account_pool"] and not members and not s.get("replace") and any(
                    w["online"] and w["mode"] == "execute" for w in inventory[1].values()):
                s.update(enabled=False,message="策略完成，当前账户池无法组成下一批")
            return
        while s["planned"]:
            item = s["planned"].pop(0)
            routes = [cmd for cmd in candidates.get(item["ref"],[]) if cmd["phase"] == item["phase"]]
            if not routes:
                s["replace"] = s.get("replace",0)+1
                s["message"] = "账户状态已变，重新选择同批候选"
                continue
            cmd = random.choice(routes)
            cmd["params"]["side"] = s["batch_side"]
            insert(db,cmd,"pending",now)
            s.get("reentries",{}).pop(item["ref"],None)
            s["members"].append(cmd["id"])
            s["message"] = f"第 {s['batch']} 批等待执行回执"
            if s["planned"]:
                s["next_at"] = now + self._strategy_delay(s,"order")
                s["message"] = f"第 {s['batch']} 批还有 {len(s['planned'])} 个账户等待下单"
                if now < s["next_at"]:
                    break

    def _decide_node(self, db, s, inventory, now):
        try:
            self._advance_node(db,s,inventory,now)
        except (Problem, ValueError) as err:
            self._pause(db,s,"节点策略已暂停 · "+str(err))
        self._save_strategy(db,s)

    def run(self, stop: threading.Event):
        active = {}
        control_due = {}
        decision_due = 0
        with ThreadPoolExecutor(max_workers=12, thread_name_prefix="vest-node") as pool:
            while not stop.is_set():
                started = time.monotonic()
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
                        metrics_only = started < control_due.get(nid, 0)
                        active[nid] = pool.submit(self.sync, nid, metrics_only=metrics_only)
                        if not metrics_only:
                            control_due[nid] = started + 2
                if started >= decision_due:
                    decision_due = started + 2
                    try:
                        self.decide()
                    except Exception:
                        logging.exception("策略调度失败")
                stop.wait(max(0, 1 - (time.monotonic() - started)))
