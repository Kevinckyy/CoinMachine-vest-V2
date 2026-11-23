"""Live profit policy shared by the controller and the bridge."""
from decimal import Decimal, ROUND_DOWN

from .protocol import choice, fields, ident, number, require
from .storage import command, record


def validate(policy):
    fields(policy, ("open_id", "target_balance", "live_payout_mode", "live_payout_recipient",
                    "live_payout_amount", "live_payout_percent"))
    ident(policy.get("open_id"))
    number(policy.get("target_balance"), "Live 起始余额", 0.000001, 1e12)
    choice(policy.get("live_payout_mode"), {"all", "amount", "percent"}, "领取方式")
    choice(policy.get("live_payout_recipient"), {"main"}, "领取目标")
    number(policy.get("live_payout_amount"), "领取金额", 0.000001, 1e9)
    number(policy.get("live_payout_percent"), "领取比例", 0.000001, 100)
    return policy


def amount(available, policy):
    available = Decimal(str(available))
    mode = policy["live_payout_mode"]
    value = (available if mode == "all" else Decimal(str(policy["live_payout_amount"])) if mode == "amount"
             else available * Decimal(str(policy["live_payout_percent"])) / 100)
    value = value.quantize(Decimal(".000001"), rounding=ROUND_DOWN)
    return float(value) if 0 < value <= available else None


def check_origin(db, cmd, account):
    policy = cmd["strategy_payout"]
    opened = record(command(db, policy["open_id"]))
    require(opened["action"] == "order.open" and opened["status"] == "succeeded" and opened["phase"] == "live"
            and cmd["phase"] == "live" and cmd["source"].startswith("strategy-")
            and all(opened[k] == cmd[k] for k in ("source","node_id","worker_id","account","account_ref"))
            and opened["intents"].get("open",{}).get("proof",{}).get("initial_balance") == policy["target_balance"]
            and account.get("initial_balance") == policy["target_balance"]
            and opened.get("expected_risk",{}).get("card_id") == (account.get("card") or {}).get("id"),
            "领取来源或阶段起始余额已变化", 409)
    other = db.execute("""SELECT 1 FROM commands WHERE node=? AND worker=? AND account=? AND action='profit.withdraw'
        AND json_extract(body,'$.strategy_payout.open_id')=? AND id!=?
        AND (status IN ('pending','sending','queued','running','succeeded','unknown') OR intents!='{}') LIMIT 1""",
        (cmd["node_id"],cmd["worker_id"],cmd["account"],opened["id"],cmd["id"])).fetchone()
    require(not other, "此开仓已有关联的领取指令", 409)


def check_quote(cmd, proof, now):
    policy = cmd["strategy_payout"]
    available = number(proof.get("available"), "可领取净利润", 0.000001, 1e12)
    received = number(proof.get("received"), "预计实收", 0.000001, cmd["params"]["amount"])
    before = number(proof.get("balance_before"), "领取前余额", 0.000001, 1e12)
    flat = proof.get("flat")
    require(isinstance(flat,dict) and all(flat.get(k) == 0 for k in ("leverage","position_margin","order_margin"))
            and type(flat.get("observed_at")) in (int,float) and now-15 <= flat["observed_at"] <= now+5
            and proof.get("recipient") == "main"
            and proof.get("amount") == amount(available, policy) == cmd["params"]["amount"]
            and received <= available and abs(before - available - policy["target_balance"]) <= .005,
            "平台领取预览与策略金额、主账户或阶段起始余额不符", 409)
