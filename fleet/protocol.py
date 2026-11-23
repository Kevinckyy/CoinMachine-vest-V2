"""Version 1 command contract, shared by the controller and the bridge."""
import json
import math
import re
from urllib.parse import urlsplit

from .trading_day import entry_day_window


PORTFOLIO_SCAN = "accounts.read_all"
READ = {"accounts.list", PORTFOLIO_SCAN, "account.read", "positions.read", "history.read", "page.navigate"}
WRITE = {"order.open", "order.close", "position.protect", "profit.withdraw"}
ACTIONS = READ | WRITE
PENDING = {"pending", "sending", "queued", "running"}
TERMINAL = {"succeeded", "failed", "unknown", "expired", "cancelled", "resolved"}
PHASES = {"1/2", "2/2", "live"}
WORKER_TTL = 25
NODE_TTL = 20
OBS_TTL = 180
QUEUE_TTL = 90
RUN_TTL = 120
PRIMARY = {"default", "main", "primary", "master", "主账户", "主账号", "主帳戶", "主帳號",
           "main account", "primary account", "master account"}


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def require(ok, message, status=400):
    if not ok:
        raise Problem(message, status)


def obj(value):
    require(isinstance(value, dict), "请求必须是 JSON 对象")
    return value


def string(value, label, limit=160, empty=False):
    require(isinstance(value, str) and (empty or value.strip()) and len(value) <= limit
            and all(ord(ch) >= 32 for ch in value), f"{label}无效")
    return value.strip()


def ident(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", value),
            "标识仅支持 1–80 位字母、数字、点、下划线和短横线")
    return value


def number(value, label, low=0, high=1_000_000_000, integer=False):
    require(type(value) in (int, float) and low <= value <= high and math.isfinite(value)
            and (not integer or int(value) == value), f"{label}无效")
    return int(value) if integer else value


def boolean(value):
    require(type(value) is bool, "开关值必须是布尔值")
    return value


def choice(value, options, label):
    require(isinstance(value, str) and value in options, f"{label}无效")
    return value


def fields(data, allowed):
    obj(data)
    require(not (set(data) - set(allowed)), "存在未识别字段")


def dump(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def bridge_url(value):
    value = string(value, "桥地址", 512).rstrip("/")
    try:
        url = urlsplit(value)
        port = url.port
        local = url.hostname in ("localhost", "127.0.0.1", "::1")
        valid = url.hostname and not url.username and not url.password and url.path == "" and not url.query and not url.fragment
        require(valid and (port is None or port > 0) and (url.scheme == "https" or local and url.scheme == "http"),
                "公网桥地址须为 HTTPS，本机可用 HTTP；填写根地址")
    except ValueError as err:
        raise Problem("桥地址格式无效") from err
    return value


def positive(value, label):
    return number(value, label, 0.000001)


def parameters(action, raw, legacy=False):
    p = dict(obj(raw))
    if action in {"accounts.list", PORTFOLIO_SCAN, "account.read", "positions.read", "history.read"}:
        fields(p, ())
    elif action == "page.navigate":
        fields(p, ("destination",))
        choice(p.get("destination"), {"accounts","trade", "portfolio"}, "目标页面")
    elif action == "profit.withdraw":
        fields(p, ("amount",))
        amount = positive(p.get("amount"), "领取金额")
        require(abs(round(amount, 6) - amount) < 1e-12, "领取金额最多六位小数")
    elif action == "order.close":
        fields(p, ("position_id",))
        string(p.get("position_id"), "持仓 ID")
    elif action == "position.protect":
        fields(p, ("position_id", "stop_loss", "take_profit"))
        string(p.get("position_id"), "持仓 ID")
        require("stop_loss" in p or "take_profit" in p, "请指定要修改的止盈或止损金额")
        for key in p.keys() & {"stop_loss", "take_profit"}:
            positive(p[key], key)
    elif action == "order.open":
        fields(p, ("side", "micro", "size_percent", "stop_buffer", "take_profit", "omit_stop_below") + (("stop_loss",) if legacy else ()))
        choice(p.get("side"), {"buy", "sell"}, "方向")
        require(("micro" in p) != ("size_percent" in p), "请指定 Micro 数量或仓位比例")
        if "micro" in p:
            p["micro"] = number(p["micro"], "Micro 数量", 1, 1_000_000, True)
        else:
            require(type(p["size_percent"]) is int and p["size_percent"] in (25, 50, 75, 100), "仓位比例无效")
        if legacy and "stop_loss" in p and "stop_buffer" not in p:
            positive(p["stop_loss"],"旧版止损金额")
        else:
            p["stop_buffer"] = number(p.get("stop_buffer",20),"爆仓线净值缓冲",0,1e9)
        if p.get("take_profit") is not None:
            positive(p["take_profit"], "止盈金额")
        if "omit_stop_below" in p:
            positive(p["omit_stop_below"], "免止损剩余回撤阈值")
    return p


def request(data, legacy=False):
    fields(data, ("node_id", "worker_id", "account", "action", "params"))
    action = choice(data.get("action"), ACTIONS, "指令类型")
    account = data.get("account")
    if action in {"accounts.list", PORTFOLIO_SCAN, "page.navigate"}:
        require(account is None, "该指令作用于浏览器，无需账户")
    else:
        account = string(account, "账户名")
    return dict(node_id=ident(data.get("node_id")), worker_id=ident(data.get("worker_id")),
                account=account, action=action, params=parameters(action, data.get("params", {}),legacy))


def validate_target(cmd, worker, account, now):
    require(worker and now - worker["last_seen"] < WORKER_TTL, "浏览器离线，请先连接插件", 409)
    require(worker["session_id"] == cmd["session_id"], "浏览器会话已更换，请刷新后重新下达指令", 409)
    if cmd["account"] is not None:
        require(account and account["present"] and not account["ambiguous"], "账户已消失或名称不唯一", 409)
    if cmd["action"] not in WRITE:
        return
    require(worker["mode"] == "execute", "插件处于只读模式", 409)
    require(not account["excluded"] and account["category"] not in ("failed", "closed", "default"),
            "主账户、已关闭或失败账户仅支持读取", 409)
    card_candidate = cmd["action"]=="order.open" and account.get("card") and account["listed_session"]==worker["session_id"] and now-(account.get("card_at") or 0)<=OBS_TTL
    require(card_candidate or account.get("listed_session") == account.get("read_session") == worker["session_id"],
            "等待本次浏览器会话重新确认账户和读数", 409)
    require(account["phase"] == cmd["phase"], "账户阶段已变化", 409)
    require(card_candidate or not account["read_error"] and account["observed_at"] and now - account["observed_at"] <= OBS_TTL,
            "账户读数过期或不完整，请刷新账户", 409)
    snap = account["snapshot"]
    if cmd["action"]=="order.open":
        from .cards import risk_error
        risk = account.get("risk") or {}
        issue = risk_error(risk,complete=bool(account.get("risk_at") and now-account["risk_at"]<60))
        require(not issue,issue,409)
        require(account["category"] in ("active","eval","funded","live"),"该账户状态不可开仓",409)
        return
    if cmd["action"] == "profit.withdraw":
        require(snap.get("position_open") is False, "需要已确认的空仓读数", 409)
    else:
        require(snap.get("position_open") is True and snap.get("position_id") == cmd["params"]["position_id"],
                "当前持仓与指令不匹配", 409)
        require(all(snap.get(k) == v for k, v in cmd["expected_position"].items()), "持仓数量、方向或均价已变化", 409)
    if cmd["action"] == "profit.withdraw":
        require(account["phase"] == "live" and account["category"] in ("funded", "live"), "仅 Live 账户可领取利润", 409)


def make_command(key, req, node, worker, account, now, source="manual"):
    end = now + QUEUE_TTL
    if req["action"] == "order.open":
        end = min(end, entry_day_window(now)["end"])
    cmd = {**req, "id": ident(key), "instance_id": node["instance_id"], "session_id": worker["session_id"],
            "phase": account["phase"] if account else None, "source": source, "created_at": now, "expires_at": end}
    if req["action"] in WRITE:
        cmd["account_ref"] = account["account_ref"] or req["account"]
    if req["action"]=="order.open":
        cmd["expected_risk"] = {**(account.get("risk") or {}),"phase":account["phase"],"category":account["category"],
                                "card_id":(account.get("card") or {}).get("id")}
        floor = account.get("daily_floor") or {}
        cmd["expected_floor"] = {k:floor.get(k) for k in ("start","floor","verified")}
    if req["action"] in ("order.close", "position.protect"):
        cmd["expected_position"] = {k: account["snapshot"].get(k) for k in ("position_id", "symbol", "side", "quantity", "entry_price")}
    return cmd
