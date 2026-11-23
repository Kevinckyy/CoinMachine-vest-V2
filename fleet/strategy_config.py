"""Saved forms for the reference random-entry strategy. Node runs own a copy of the settings."""
import json

from .account_pool import DEFAULT_ACCOUNT_PRIORITY, POOL_DEFAULTS, dynamic_exam_slots, normalize_account_priority, pool_settings
from .protocol import Problem, boolean, choice, dump, fields, number, positive, require


DEFAULT_CONFIG = dict(strategy_id="random_entry", symbol="NQ-PERP", batch_size=2,
                      order_delay_min=2, order_delay_max=8, batch_delay_min=15, batch_delay_max=45,
                      side="random", size_percent=25, stop_buffer=20, take_profit=None,
                      skip_stop_loss_on_low_drawdown=False, drawdown_stop_loss_threshold=200,
                      live_priority=True, account_priority_order=list(DEFAULT_ACCOUNT_PRIORITY), refresh_account_pool=True,
                      live_default_locked=True, live_side="random", live_size_percent=25, live_stop_buffer=20,
                      live_take_profit=None, live_skip_stop_loss_on_low_drawdown=False, live_drawdown_stop_loss_threshold=200,
                      live_payout_recipient="main", live_payout_mode="all",
                      live_payout_amount=1, live_payout_percent=100, **POOL_DEFAULTS)


def settings(base, patch):
    fields(patch, (*DEFAULT_CONFIG, "interval_seconds"))
    config = {**base, **patch}
    # Older API clients used one fixed interval for the batch cooldown.
    interval = config.pop("interval_seconds", None)
    if interval is not None:
        require(not ({"batch_delay_min", "batch_delay_max"} & patch.keys()), "固定间隔和区间不能同时指定")
        config["batch_delay_min"] = config["batch_delay_max"] = number(interval, "批间等待秒数", 1, 86400, True)
    choice(config["strategy_id"], {"random_entry"}, "策略")
    choice(config["symbol"], {"NQ-PERP"}, "品种")
    config["batch_size"] = number(config["batch_size"], "每批账户数", 1, 100, True)
    for prefix in ("order", "batch"):
        low, high = (number(config[f"{prefix}_delay_{bound}"], "等待秒数", 0, 86400) for bound in ("min", "max"))
        require(low <= high, "等待时间下限不能大于上限")
    for prefix in ("", "live_"):
        choice(config[prefix+"side"], {"buy","sell","random"}, "下单方向")
        pct = config[prefix+"size_percent"]
        require(type(pct) is int and pct in (25,50,75,100), "仓位大小应为 25%、50%、75% 或 100%")
        number(config[prefix+"stop_buffer"], "爆仓线上方净值缓冲 M", 0, 1e9)
        boolean(config[prefix+"skip_stop_loss_on_low_drawdown"])
        positive(config[prefix+"drawdown_stop_loss_threshold"], "剩余回撤阈值")
        if config[prefix+"take_profit"] is not None:
            positive(config[prefix+"take_profit"], "止盈金额")
    for key in ("live_priority", "refresh_account_pool", "live_default_locked"):
        boolean(config[key])
    try:
        config["account_priority_order"] = normalize_account_priority(config["account_priority_order"])
    except ValueError as err:
        raise Problem(str(err)) from err
    config.update(pool_settings(config))
    config["dynamic_exam_slots"] = dynamic_exam_slots(config, config["batch_size"])
    choice(config["live_payout_recipient"], {"main"}, "利润收款账户")
    choice(config["live_payout_mode"], {"all", "amount", "percent"}, "利润领取方式")
    amount = positive(config["live_payout_amount"], "领取金额")
    require(round(amount, 6) == amount, "领取金额最多六位小数")
    number(config["live_payout_percent"], "领取比例", 0.000001, 100)
    return config


def migrate(config):
    if "order_delay_min" in config:
        return settings(DEFAULT_CONFIG, config)
    old = {k:v for k,v in config.items() if k in DEFAULT_CONFIG or k == "interval_seconds"}
    # Existing V2 nodes used one common direction, size, buffer and optional take profit.
    for key in ("side", "size_percent", "take_profit", "stop_buffer"):
        if key in old:
            old["live_"+key] = old[key]
    old.update(order_delay_min=0, order_delay_max=0, live_priority=False, live_default_locked=False)
    return settings(DEFAULT_CONFIG, old)


def library(db):
    defaults = json.loads(db.execute("SELECT config FROM strategy_defaults WHERE slot=1").fetchone()[0])
    presets = [{**dict(row), "config":json.loads(row["config"])} for row in
               db.execute("SELECT id,name,config FROM strategy_presets ORDER BY name COLLATE NOCASE,id")]
    return {"defaults": defaults, "presets": presets}


def initialize(db):
    db.execute("CREATE TABLE IF NOT EXISTS strategy_defaults(slot INTEGER PRIMARY KEY CHECK(slot=1),config TEXT NOT NULL)")
    db.execute("""CREATE TABLE IF NOT EXISTS strategy_presets(id TEXT PRIMARY KEY,
               name TEXT NOT NULL UNIQUE COLLATE NOCASE,config TEXT NOT NULL)""")
    db.execute("INSERT OR IGNORE INTO strategy_defaults VALUES(1,?)", (dump(DEFAULT_CONFIG),))
