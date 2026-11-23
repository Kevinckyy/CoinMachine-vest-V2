"""Offline protocol and recovery tests. Browser financial actions are never invoked."""
import concurrent.futures
import json
import secrets
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from datetime import datetime

from fleet.bridge import Bridge, verify_financial_receipt
from fleet.center import Center
from fleet import account_pool, daily_floor, ledger, strategy_config, strategy_payout
from fleet.http import make_server
from fleet.protocol import Problem
from fleet.reporting import ZONE


class FleetTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.time = 1_800_000_000
        self.clock = lambda: self.time
        self.nodes = {name: Bridge(self.root / name, name, self.clock) for name in ("east", "west")}
        self.center = Center(self.root / "center", self.clock, self.transport)
        self.lose_delivery = False
        self.plugin_meta = dict(worker_id="browser", session_id="session-1", generation=1,
                                mode="execute", label="Browser A", page="/trade/NQ-PERP", strategy_version=1,plugin_version="1.6.0")
        self.addCleanup(self.close)
        for nid in self.nodes:
            self.center.configure_node(nid, dict(url="https://" + nid + ".example", label=nid, token=secrets.token_hex(20)))
            self.center.strategy("config",dict(batch_size=1,order_delay_min=0,order_delay_max=0,
                                 batch_delay_min=60,batch_delay_max=60,live_default_locked=False,live_take_profit=15),nid)
            self.report(nid, inventory=[dict(name="Shared", category="eval", phase="1/2"),
                                        dict(name="Only-" + nid, category="eval", phase="1/2"),
                                        dict(name="Main", category="default")])
            self.observe(nid, "Shared")
            self.observe(nid, "Only-" + nid)
            self.center.sync(nid)
            for name in ("Shared","Only-"+nid):
                self.center.account_config(dict(node_id=nid,worker_id="browser",account=name,in_pool=False))

    def close(self):
        self.center.db.close()
        for bridge in self.nodes.values():
            bridge.db.close()

    def transport(self, node, verb, path, data=None):
        bridge = self.nodes[node["id"]]
        if path.startswith("/v1/status?since="):
            return bridge.status(path.split("=")[1])
        if path == "/v1/status":
            return bridge.refresh_cards(data) if verb=="PUT" else bridge.status()
        if path.startswith("/v1/ledger?after="):
            return bridge.ledger_page(int(path.split("=")[1]))
        if path.startswith("/v1/logs?after="):
            return bridge.log_page(int(path.split("=")[1]))
        key = path.split("/")[3]
        if path.endswith("/resolve"):
            return bridge.resolve(key, data)
        if verb == "GET":
            return bridge.get(key)
        response = bridge.submit(key, data, cancel=path.endswith("/cancel"))
        if self.lose_delivery:
            self.lose_delivery = False
            raise Problem("模拟桥已落盘但中心未收到响应", 502)
        return response

    def plugin(self, nid, op, **body):
        if op=="intent" and body["stage"]=="open" and "observation" not in body:
            cmd = self.nodes[nid].get(body["id"])
            obs = self.reading(cmd["account"])
            if cmd["status"]=="running" and not cmd["intents"]:
                checked = self.plugin(nid,"preflight",id=cmd["id"],observation=obs)
                self.assertTrue(checked["approved"],checked)
                body["proof"] = {"quantity":2,**body.get("proof",{}),"stop_loss":checked["stop_loss"]}
            body["observation"] = obs
        return self.nodes[nid].plugin(op, {**self.plugin_meta, **body})

    def report(self, nid, **body):
        return self.plugin(nid, "report", **body)

    def reading(self, name):
        return dict(name=name,phase="1/2",category="eval",snapshot=dict(position_open=False,balance=1000,equity=1000,
                    account_health=90,daily_reset_equity=1000,daily_floor=970,capital_metrics={"daily_loss":{"current":0,"limit":30},
                    "drawdown":{"current":26.08,"limit":300}},unrealized_pnl=0,observed_at=self.time))

    def observe(self, nid, name):
        self.report(nid, observation=self.reading(name))

    def card_report(self, nid, items=None, full=True):
        bridge = self.nodes[nid]
        if items is None:
            items = [{"name":a["name"],"category":a["category"],"phase":a["phase"],"active_positions":0}
                     for a in bridge.status()["accounts"] if a["present"]]
        return self.plugin(nid,"report",page="/accounts",cards=dict(items=items,full=full,observed_at=self.time,
                           generation=bridge.status()["card_generation"]))

    def start_ready(self,nid):
        self.center.strategy("start",{},nid)
        self.center.sync(nid)
        self.card_report(nid)
        self.center.sync(nid)

    @staticmethod
    def card(name, **changes):
        return dict({"name":name,"id":"card-"+name,"category":"eval","phase":"1/2","active_positions":0,
                     "daily_loss":0,"daily_limit":30,"drawdown":26.08,"drawdown_limit":300,"equity":1000},**changes)

    def start_portfolio_scan(self):
        self.plugin_meta["portfolio_version"] = 1
        self.plugin("east", "heartbeat")
        self.center.sync("east")
        batch = self.center.read_accounts("east")
        self.assertEqual(self.center.read_accounts("east"), batch)
        self.assertEqual(batch["skipped"], [])
        key, = batch["commands"]
        self.center.sync("east")
        first = self.plugin("east", "poll", cards_version=1)
        self.assertEqual((first["command"]["id"], first["scan"]), (key, {"stage": "list"}))
        return key

    def scan_directory(self, key, names, **changes):
        return self.report("east", page="/accounts", cards={
            "generation": 0, "full": True, "observed_at": self.time,
            "items": [self.card(name) for name in names], "scan_id": key, **changes})

    def test_portfolio_requires_new_directory_and_local_cache_before_each_scan(self):
        self.card_report("east", [self.card("Stale"), self.card("Shared")])
        self.observe("east", "Shared")
        trade_at = self.time
        self.time += 2
        key = self.start_portfolio_scan()
        obs = dict(id=key, name="New", card_id="card-New",
                   values=dict(equity=1200, health=83, daily_loss=3, daily_limit=36,
                               drawdown=16, drawdown_limit=300, observed_at=self.time))
        with self.assertRaises(Problem):
            self.report("east", page="/portfolio", portfolio=obs)
        with self.assertRaises(Problem):
            self.scan_directory(key, ["New"], full=False)
        with self.assertRaisesRegex(Problem, "清单早于本次指令"):
            self.scan_directory(key, ["New"], observed_at=trade_at)
        self.assertEqual({a["name"] for a in self.nodes["east"].status()["accounts"] if a["present"]}, {"Stale","Shared"})
        self.scan_directory(key, ["New", "Shared"])
        self.assertEqual(self.plugin("east", "poll", cached_scan="prior")["scan"]["stage"], "list")
        with self.assertRaises(Problem):
            self.plugin("east", "result", id=key, ok=True, result={})
        first = self.plugin("east", "poll", cached_scan=key)["scan"]["target"]
        self.assertEqual(first["name"], "New")
        with self.assertRaises(Problem):
            self.report("east", page="/trade/NQ-PERP", portfolio=obs)
        with self.assertRaises(Problem):
            self.report("east", page="/portfolio", portfolio={**obs, "name":"Shared", "card_id":"card-Shared"})
        self.time += 82
        self.report("east", page="/portfolio", portfolio=obs)
        self.report("east", page="/portfolio", portfolio=obs)
        self.nodes["east"].db.close()
        self.nodes["east"] = Bridge(self.root / "east", "east", self.clock)
        self.time += 72
        self.assertEqual(self.plugin("east", "poll")["scan"]["target"]["name"], "Shared")
        self.report("east", page="/portfolio", portfolio={**obs, "name":"Shared","card_id":"card-Shared",
                    "values":{**obs["values"], "observed_at":self.time}})
        self.center.sync("east")
        result = self.center.get(key)
        self.assertEqual((result["status"],result["result"]["read"],result["intents"]), ("succeeded",2,{}))
        accounts = {a["name"]: a for a in self.center.state("east")["accounts"]}
        self.assertFalse(accounts["Stale"]["present"])
        self.assertIsNone(accounts["New"]["risk_at"])
        self.assertEqual(accounts["New"]["snapshot"], {})
        self.assertEqual(accounts["Shared"]["risk_at"], trade_at)
        self.assertEqual(accounts["Shared"]["snapshot"]["equity"], 1000)
        self.assertEqual(accounts["Shared"]["risk"]["equity"], 1200)
        self.assertEqual(accounts["Shared"]["portfolio"]["daily_limit"], 36)
        self.assertIsNone(self.plugin("west", "poll")["command"])

    def test_portfolio_skips_ambiguous_missing_and_partial_accounts(self):
        key = self.start_portfolio_scan()
        self.scan_directory(key, ["Twice", "Missing", "Partial", "Unlimited", "Twice"])
        self.assertEqual(self.plugin("east","poll",cached_scan=key)["scan"]["target"]["name"], "Missing")
        for name, detail in [("Missing", {"error":"选择器中无此账户"}),
                ("Partial", {"values":{"health":40,"equity":0,"observed_at":self.time}}),
                ("Unlimited", {"values":{"health":80,"equity":1200,"drawdown":18,"drawdown_limit":300,
                                        "daily_unlimited":True,"observed_at":self.time}})]:
            self.report("east", page="/portfolio", portfolio={"id":key,"name":name,"card_id":"card-"+name,**detail})
        self.center.sync("east")
        cmd = self.center.get(key)
        scan = cmd["result"]
        self.assertEqual((cmd["status"],scan["total"],scan["read"],scan["partial"],scan["failed"]), ("failed",4,1,1,2))
        partial = scan["accounts"][2]["values"]
        self.assertIsNone(partial["daily_limit"])
        self.assertIn("daily_limit", partial["missing"])
        self.assertEqual(partial["equity"], 0)
        latest = self.center.state("east")["workers"][0]["portfolio_scan"]
        self.assertEqual((latest["id"],latest["partial"]), (key,1))

    def test_empty_portfolio_scan_cache_ack_and_idle_timeout(self):
        key = self.start_portfolio_scan()
        self.scan_directory(key, [])
        self.assertEqual(self.nodes["east"].get(key)["status"], "running")
        self.assertIsNone(self.plugin("east","poll",cached_scan=key)["command"])
        self.assertEqual(self.nodes["east"].get(key)["status"], "succeeded")
        self.plugin("east","read-all",id="local")
        self.plugin("east","poll")
        self.scan_directory("local", ["A", "B"])
        self.plugin("east","poll",cached_scan="local")
        self.report("east",page="/portfolio",portfolio=dict(id="local",name="A",card_id="card-A",error="已消失"))
        self.time += 119
        self.plugin("east","heartbeat")
        self.time += 2
        expired = self.nodes["east"].get("local")
        self.assertEqual((expired["status"],expired["result"]["failed"]), ("failed",1))

    def test_scan_requires_capable_browser_and_stops_on_new_session(self):
        with self.assertRaisesRegex(Problem, "重新加载"):
            self.center.read_accounts("east")
        key = self.start_portfolio_scan()
        self.scan_directory(key, ["A"])
        self.plugin("east","poll",cached_scan=key)
        self.plugin("east","heartbeat",session_id="next-session",generation=2)
        self.assertEqual(self.nodes["east"].get(key)["status"], "cancelled")
        with self.assertRaises(Problem):
            self.report("east",page="/portfolio",portfolio=dict(id=key,name="A",card_id="card-A",error="旧回执"))

    def start_cards(self, items):
        self.center.strategy("start",{},"east")
        self.center.sync("east")
        self.card_report("east",items)
        self.center.sync("east")
        self.center.decide()

    def test_defaults_presets_node_copies_and_legacy_config(self):
        original = self.center.state()["strategy_settings"]["defaults"]
        self.assertEqual((original["batch_size"],original["order_delay_min"],original["order_delay_max"],
                          original["batch_delay_min"],original["batch_delay_max"]),(2,2,8,15,45))
        defaults = self.center.save_defaults({"batch_size":5,"live_size_percent":75})
        preset = self.center.preset("evening",{"name":"Evening","config":{"batch_size":3,"pool_strategy":"dynamic","dynamic_exam_slots":1}})
        with self.assertRaisesRegex(Problem,"名称"):
            self.center.preset("other",{"name":"evening","config":{}})
        self.assertEqual(preset["config"]["live_size_percent"],75)
        self.center.configure_node("new",dict(label="new",url="https://new.example",token=secrets.token_hex(20)))
        self.assertEqual(self.center.state("new")["strategy"]["config"],defaults)
        self.center.strategy("config",preset["config"],"west")
        self.center.preset("evening",{"name":"Night","config":{"live_size_percent":50}})
        self.center.save_defaults({"live_size_percent":100})
        self.center.db.close()
        self.center = Center(self.root/"center",self.clock,self.transport)
        self.assertEqual(self.center.state("new")["strategy"]["config"],defaults)
        self.assertEqual(self.center.state("west")["strategy"]["config"],preset["config"])
        self.assertEqual(self.center.state("east")["strategy"]["config"]["batch_size"],1)
        self.assertEqual(self.center.state()["strategy_settings"]["presets"][0]["name"],"Night")
        self.center.preset("evening",{},remove=True)
        self.assertEqual(self.center.state()["strategy_settings"]["presets"],[])
        with self.assertRaises(Problem):
            self.center.save_defaults({"order_delay_min":25})
        old = {"interval_seconds":37,"batch_size":4,"size_percent":50,"side":"sell","take_profit":12,"stop_buffer":7}
        with self.center.db.tx() as db:
            db.execute("UPDATE node_strategy SET data=json_set(data,'$.config',json(?)) WHERE node='east'",(json.dumps(old),))
        self.center.db.close()
        self.center = Center(self.root/"center",self.clock,self.transport)
        migrated = self.center.state("east")["strategy"]["config"]
        self.assertEqual((migrated["batch_delay_min"],migrated["batch_delay_max"],migrated["live_stop_buffer"],
                          migrated["live_side"],migrated["order_delay_max"]),(37,37,7,"sell",0))

    def test_stage_priority_order_jitter_and_restart(self):
        items = [self.card("First"),self.card("Second",phase="2/2"),self.card("Funded",phase="live",category="funded")]
        self.center.strategy("config",dict(batch_size=2,order_delay_min=12,order_delay_max=12,
                         side="random",live_side="sell",live_size_percent=75,live_stop_buffer=11,
                         live_skip_stop_loss_on_low_drawdown=True,live_drawdown_stop_loss_threshold=150),"east")
        self.start_cards(items)
        state = self.center.state("east")
        first, = state["commands"]
        self.assertEqual((first["account"],first["params"]["size_percent"],first["params"]["stop_buffer"],
                          first["params"]["omit_stop_below"],first["params"]["side"]),("Funded",75,11,150,"sell"))
        self.assertEqual((state["strategy"]["planned"],state["strategy"]["next_at"]),
                         ([{"ref":"Second","phase":"2/2"}],self.time+12))
        self.center.db.close()
        self.center = Center(self.root/"center",self.clock,self.transport)
        self.time += 11
        self.center.decide()
        self.assertEqual(len(self.center.state("east")["commands"]),1)
        self.time += 1
        self.center.decide()
        second = self.center.state("east")["commands"][0]
        self.assertEqual((second["account"],second["params"]["side"],second["params"]["size_percent"],
                          second["params"]["stop_buffer"],second["created_at"]),("Second","sell",25,20,self.time))
        self.assertNotIn("omit_stop_below",second["params"])

    def test_mixed_directions_and_explicit_live_unlock(self):
        live = self.card("Funded",phase="live",category="funded")
        items = [self.card("First"),live]
        self.center.strategy("config",dict(batch_size=2,live_default_locked=True,side="buy",live_side="sell"),"east")
        self.start_cards(items)
        self.assertFalse(self.center.state("east")["commands"])
        self.assertTrue(next(a for a in self.center.state("east")["accounts"] if a["name"]=="Funded")["live_default_locked"])
        self.center.account_config(dict(node_id="east",worker_id="browser",account="Funded",in_pool=True))
        self.center.decide()
        s = self.center.state("east")
        self.assertFalse(s["commands"])
        self.assertFalse(s["strategy"]["enabled"])
        self.assertIn("方向冲突",s["strategy"]["message"])

    def test_grouped_and_dynamic_pools(self):
        items = [self.card("First"),self.card("Second",phase="2/2"),self.card("Another",phase="2/2"),
                 self.card("Live",phase="live",category="funded")]
        self.center.strategy("config",dict(batch_size=2,pool_strategy="same_stage",same_stage_full_batch=True),"east")
        self.start_cards(items)
        self.assertEqual({c["phase"] for c in self.center.state("east")["commands"]},{"2/2"})
        import random
        cfg = strategy_config.settings(strategy_config.DEFAULT_CONFIG,dict(pool_strategy="dynamic",batch_size=3,
                     pool_limits_enabled=True,exam_pool_limit=2,live_pool_limit=3,dynamic_exam_slots=1))
        accounts = {str(i):dict(phase="live" if i>3 else "1/2",status="active",phase_started_at=i) for i in range(8)}
        state = {"batch":0}
        chosen = account_pool.choose_pool_batch(state,cfg,accounts,list(accounts),lambda a:a["phase"],
                                                account_pool.account_priority_ranks(cfg),random.Random(4))
        self.assertEqual((len(state["pool_live_ids"]),len(state["pool_waiting_live_ids"])),(3,1))
        self.assertEqual(sum(accounts[i]["phase"]=="live" for i in chosen),2)
        accounts["8"] = dict(phase="live",status="active",phase_started_at=8)
        chosen = account_pool.choose_pool_batch(state,cfg,accounts,list(accounts),lambda a:a["phase"],
                                                account_pool.account_priority_ranks(cfg),random.Random(4))
        self.assertFalse(state["pool_refilling"])
        self.assertEqual(sum(accounts[i]["phase"]=="live" for i in chosen),3)

    def test_skip_stop_compares_pre_buffer_floor_distance_and_verifies_absence(self):
        obs = self.reading("Shared")
        snap = obs["snapshot"]
        snap.update(equity=9850,balance=9850,daily_reset_equity=10000,daily_floor=9700)
        snap["capital_metrics"].update(daily_loss={"current":150,"limit":300},drawdown={"current":60,"limit":300})
        self.report("east",observation=obs)
        self.center.sync("east")
        floor = {"verified":True,"floor":9700}
        self.assertEqual(daily_floor.stop_decision(9850,floor,dict(stop_buffer=20,omit_stop_below=150)),(150,130,False))
        self.assertEqual(daily_floor.stop_decision(9850,floor,dict(stop_buffer=20,omit_stop_below=140)),(150,130,False))
        self.assertEqual(daily_floor.stop_decision(9850,floor,dict(stop_buffer=20)),(150,130,False))
        self.assertFalse(daily_floor.stop_decision(9700,floor,dict(stop_buffer=20,omit_stop_below=151))[2])
        params = dict(side="buy",micro=1,stop_buffer=20,omit_stop_below=150.01)
        self.center.submit("omit",self.req(action="order.open",params=params))
        self.center.sync("east")
        cmd = self.plugin("east","poll")["command"]
        checked = self.plugin("east","preflight",id=cmd["id"],observation=obs)
        self.assertEqual((checked["remaining_drawdown"],checked["stop_loss"],checked["stop_omitted"]),(150,None,True))
        self.plugin("east","intent",id="omit",stage="open",observation=obs,proof=dict(quantity=2,stop_loss=None))
        cmd = self.nodes["east"].get("omit")
        filled = {**snap,"position_open":True,"position_id":"p","symbol":"NQ-PERP","side":"buy","quantity":2,"entry_price":20000,
                  "stop_check":{"status":"omitted"},"take_profit_check":{"status":"omitted"},"native_sl_absent":True,"native_sl_price":None}
        proof = {"observation":{**obs,"snapshot":filled}}
        verify_financial_receipt(cmd,proof)
        filled["native_sl_price"] = 19950
        with self.assertRaisesRegex(Problem,"原生止损"):
            verify_financial_receipt(cmd,proof)

    def test_strategy_live_debit_is_verified_before_one_same_batch_reentry(self):
        self.plugin_meta["plugin_version"] = self.center.plugin_version
        live = self.card("Live",category="funded",phase="live")
        obs = {**self.reading("Live"),"category":"funded","phase":"live"}
        self.card_report("east",[live])
        self.report("east",observation=obs)
        self.center.strategy("config",dict(live_side="buy",live_payout_mode="percent",live_payout_percent=50,
                             live_take_profit_mode="entries",live_first_take_profit=15,live_first_size_percent=25,
                             live_repeat_take_profit=30,live_repeat_size_percent=75),"east")
        self.start_cards([live])
        self.center.sync("east")
        opened = self.plugin("east","poll")["command"]
        checked = self.plugin("east","preflight",id=opened["id"],observation=obs)
        self.assertTrue(checked["approved"],checked)
        self.assertEqual((opened["params"]["size_percent"],checked["take_profit"]),(25,15))
        self.plugin("east","intent",id=opened["id"],stage="open",observation=obs,proof=dict(quantity=2,stop_loss=10,take_profit=15))
        filled = {**obs["snapshot"],"position_open":True,"position_id":"live-position","symbol":"NQ-PERP","side":"buy",
                  "quantity":2,"entry_price":1000,"native_sl_price":995,"stop_check":{"status":"verified","target_risk":10},
                  "native_tp_price":1007.5,"take_profit_check":{"status":"verified","target_profit":15}}
        self.plugin("east","result",id=opened["id"],ok=True,result={"observation":{**obs,"snapshot":filled}})
        self.center.sync("east")
        self.time += 1
        flat = {**obs,"snapshot":{**obs["snapshot"],"observed_at":self.time,"balance":1070,"equity":1070}}
        self.report("east",observation=flat)
        self.center.sync("east")
        self.center.decide()
        self.center.decide()
        self.center.sync("east")
        quote = self.plugin("east","poll")["command"]
        self.assertEqual(quote["action"],"profit.available")
        self.plugin("east","result",id=quote["id"],ok=True,result=dict(account="Live",phase="live",available=20,observed_at=self.time))
        self.center.sync("east")
        self.center.decide()
        self.center.sync("east")
        claim = self.plugin("east","poll")["command"]
        self.assertEqual((claim["action"],claim["params"]["amount"],claim["strategy_payout"]["open_id"]),
                         ("profit.withdraw",10,opened["id"]))
        self.assertEqual(claim["strategy_payout"]["quote_id"],quote["id"])
        proof = dict(amount=10,received=8,balance_before=1070,available=20,recipient="main",
                     flat=dict(leverage=0,position_margin=0,order_margin=0,observed_at=self.time))
        with self.assertRaisesRegex(Problem,"领取预览"):
            self.plugin("east","intent",id=claim["id"],stage="withdraw",proof={**proof,"available":40})
        self.assertTrue(self.plugin("east","intent",id=claim["id"],stage="withdraw",proof=proof)["authorize_click"])
        self.assertFalse(self.plugin("east","intent",id=claim["id"],stage="withdraw",proof=proof)["authorize_click"])
        self.time += 1
        after = {**obs,"snapshot":{**flat["snapshot"],"observed_at":self.time,"balance":1060,"equity":1060,"daily_floor":959.75}}
        res = self.plugin("east","result",id=claim["id"],ok=True,result=dict(observation=after,amount=10,expected_received=8,
                               recipient="main",balance_before=1070,balance_after=1060,verification="source_balance_debited"))
        self.assertEqual(res["status"],"succeeded")
        self.center.sync("east")
        for _ in range(3):
            self.center.decide()
        records = self.center.state("east")["commands"]
        self.assertEqual(len(records),4)
        again, = [c for c in records if c.get("reentry_claim")]
        self.assertEqual((again["reentry_claim"],again["params"]["side"],again["expected_floor"]["floor"]),(claim["id"],"buy",959.75))
        self.assertEqual((again["params"]["size_percent"],again["params"]["take_profit"]),(75,30))
        self.assertEqual(self.center.state("east")["strategy"]["batch"],1)
        self.center.sync("east")
        self.assertEqual(self.plugin("east","poll")["command"]["id"],again["id"])
        self.assertEqual(strategy_payout.amount(20.123457,{"live_payout_mode":"percent","live_payout_percent":25}),5.030864)

    def test_full_directory_generation_and_new_accounts_during_strategy(self):
        self.center.strategy("start",{},"east")
        self.center.sync("east")
        bridge = self.nodes["east"]
        generation = bridge.status()["card_generation"]
        self.assertEqual(self.plugin("east","poll",cards_version=1)["refresh_cards"],generation)
        with self.assertRaises(Problem):
            self.report("east",page="/accounts",cards=dict(generation=generation-1,items=[],full=True,observed_at=self.time))
        self.center.decide()
        self.assertEqual(self.center.state("east")["commands"],[])
        initial = [self.card("Shared"),self.card("Only-east")]
        self.card_report("east",initial)
        self.center.sync("east")
        self.center.decide()
        self.assertEqual(self.center.state("east")["commands"],[])
        self.time += 2
        new = self.card("New")
        self.card_report("east",initial+[new],full=False)
        self.center.sync("east")
        self.center.decide()
        state = self.center.state("east")
        self.assertEqual([c["account"] for c in state["commands"]],["New"])
        self.assertEqual({a["name"] for a in state["accounts"] if a["in_pool"]},{"New"})
        self.time += 1
        self.card_report("east",[new,new],full=False)
        self.center.sync("east")
        by_name = {a["name"]:a for a in self.center.state("east")["accounts"]}
        self.assertTrue(by_name["New"]["ambiguous"])
        self.assertFalse(by_name["New"]["in_pool"])
        self.assertFalse(by_name["Shared"]["present"])
        self.assertTrue(next(a for a in self.center.state("west")["accounts"] if a["name"]=="Shared")["present"])

    def test_unclassified_new_card_is_read_once_before_using_stage_policy(self):
        card = self.card("New",phase=None,category="active")
        self.start_cards([card])
        self.center.decide()
        self.center.sync("east")
        probe = self.plugin("east","poll")["command"]
        self.assertEqual((probe["account"],probe["action"]),("New","account.read"))
        self.assertEqual(len(self.center.state("east")["commands"]),1)
        self.time += 1
        self.plugin("east","result",id=probe["id"],ok=True,result={"observation":{**self.reading("New"),"phase":"2/2"}})
        self.center.sync("east")
        self.center.decide()
        records = self.center.state("east")["commands"]
        self.assertEqual([(c["action"],c["phase"]) for c in records],[("order.open","2/2"),("account.read",None)])

    def test_disabled_pool_refresh_finishes_after_authoritative_list(self):
        self.center.strategy("config",dict(batch_size=3,refresh_account_pool=False),"east")
        self.start_cards([self.card("First")])
        state = self.center.state("east")
        self.assertGreater(state["nodes"][0]["card_generation"],0)
        self.assertFalse(state["commands"])
        self.assertFalse(state["strategy"]["enabled"])
        self.assertIn("无法组成下一批",state["strategy"]["message"])

    def test_preflight_replaces_one_member_without_disturbing_batch(self):
        items = [self.card(name) for name in ("One","Two","Three")]
        self.card_report("east",items)
        for a in items:
            self.observe("east",a["name"])
        self.center.sync("east")
        self.center.strategy("config",{"batch_size":2},"east")
        self.center.strategy("start",{},"east")
        self.center.sync("east")
        self.card_report("east",items)
        self.center.sync("east")
        self.center.decide()
        self.center.sync("east")
        first = self.plugin("east","poll")["command"]
        original = self.center.state("east")["strategy"]["members"]
        self.time += 1
        obs = self.reading(first["account"])
        obs["snapshot"]["account_health"] = 10
        reply = self.plugin("east","preflight",id=first["id"],observation=obs)
        self.assertFalse(reply["approved"])
        self.assertEqual(self.nodes["east"].get(first["id"])["intents"],{})
        self.card_report("east",items,full=False)
        self.center.sync("east")
        self.center.decide()
        s = self.center.state("east")["strategy"]
        self.assertTrue(s["enabled"])
        self.assertEqual((s["batch"],len(s["members"])),(1,2))
        self.assertEqual(set(s["members"]) & set(original),set(original)-{first["id"]})
        self.assertTrue(all(self.center.get(k)["account"]!=first["account"] and
                            self.center.get(k)["params"]["side"]==first["params"]["side"] for k in s["members"]))

    def test_daily_stop_rechecked_with_equity_buffer_at_final_intent(self):
        obs = self.reading("Shared")
        snap = obs["snapshot"]
        snap.update(equity=9850,balance=9850,daily_reset_equity=10000,daily_floor=9700)
        snap["capital_metrics"]["daily_loss"].update(limit=300,current=150)
        self.report("east",observation=obs)
        self.center.sync("east")
        self.center.strategy("config",{"stop_buffer":10},"east")
        params = {"side":"buy","micro":1}
        self.center.submit("dynamic",self.req(action="order.open",params=params))
        self.center.sync("east")
        cmd = self.plugin("east","poll")["command"]
        self.assertEqual(cmd["params"]["stop_buffer"],10)
        intent = dict(id=cmd["id"],stage="open",proof={"quantity":2,"stop_loss":140},observation=obs)
        with self.assertRaisesRegex(Problem,"先完成"):
            self.plugin("east","intent",**intent)
        self.assertEqual(self.plugin("east","preflight",id=cmd["id"],observation=obs)["stop_loss"],140)
        refill = self.plugin("east","intent",**{**intent,"allow_refill":True,"proof":{"quantity":2,"stop_loss":139}})
        self.assertTrue(refill["refill"])
        self.assertFalse(refill["authorize_click"])
        snap["equity"] = 9849
        correction = self.plugin("east","intent",allow_refill=True,**intent)
        self.assertEqual((correction["authorize_click"],correction["stop_loss"]),(False,139))
        self.assertEqual(self.nodes["east"].get(cmd["id"])["intents"],{})
        self.center.sync("east")
        self.assertEqual(self.center.get("dynamic")["status"],"running")
        self.assertIn("equity",correction["changed"])
        self.assertEqual(self.plugin("east","preflight",id=cmd["id"],observation=obs)["stop_loss"],139)
        intent.update(id=cmd["id"],proof={"quantity":6,"stop_loss":139})
        self.assertTrue(self.plugin("east","intent",**intent)["authorize_click"])
        proof = self.nodes["east"].get("dynamic")["intents"]["open"]["proof"]
        self.assertEqual((proof["daily_floor"]["floor"],proof["stop_buffer"]),(9700,10))

    def test_corrected_account_is_locked_until_new_york_cutoff_then_rechecked(self):
        items = [self.card("Shared")]
        self.card_report("east",items)
        self.center.sync("east")
        params = dict(side="buy",micro=1)
        self.center.submit("risk-lock",self.req(action="order.open",params=params))
        self.center.sync("east")
        cmd = self.plugin("east","poll")["command"]
        bad = self.reading("Shared")
        bad["snapshot"]["account_health"] = 10
        checked = self.plugin("east","preflight",id=cmd["id"],observation=bad)
        end = checked["open_lock"]["until"]
        self.assertTrue(checked["reselect"])
        self.assertEqual(self.nodes["east"].get(cmd["id"])["intents"],{})
        self.card_report("east",items)
        self.nodes["east"].db.close()
        self.nodes["east"] = Bridge(self.root/"east","east",self.clock)
        self.plugin("east","heartbeat")
        self.center.sync("east")
        a = next(a for a in self.center.state("east")["accounts"] if a["name"]=="Shared")
        self.assertTrue(a["open_locked"])
        self.assertEqual(a["risk"]["health"],10)
        with self.assertRaisesRegex(Problem,"锁定"):
            self.center.submit("too-early",self.req(action="order.open",params=params))
        self.observe("east","Shared")
        self.center.sync("east")
        with self.assertRaisesRegex(Problem,"锁定"):
            self.center.submit("recovered-before-cutoff",self.req(action="order.open",params=params))
        self.report("east",observation=bad)
        self.time = end+1
        self.card_report("east",items)
        self.center.sync("east")
        self.center.submit("new-day",self.req(action="order.open",params=params))
        self.center.sync("east")
        self.assertEqual(self.plugin("east","poll")["command"]["id"],"new-day")
        seen = self.reading("Shared")
        seen["snapshot"]["daily_floor"] = 956.25
        check = self.plugin("east","preflight",id="new-day",observation=seen)
        self.assertTrue(check["approved"])
        self.assertEqual((check["stop_loss"],check["open_lock"]),(23.75,None))

    def test_live_ratio_uses_current_floor_and_minimum_for_both_stop_modes(self):
        card = self.card("Live",phase="live",category="funded")
        self.card_report("east",[card])
        obs = {**self.reading("Live"),"category":"funded","phase":"live"}
        self.report("east",observation=obs)
        self.center.sync("east")
        params = dict(side="buy",micro=1,reward_ratio=2,min_take_profit=50,omit_stop_below=30)
        self.center.submit("ratio",self.req(name="Live",action="order.open",params=params))
        self.center.sync("east")
        self.plugin("east","poll")
        def check():
            return self.plugin("east","preflight",id="ratio",observation=obs)
        first = check()
        self.assertEqual((first["stop_loss"],first["take_profit"]),(10,50))
        obs["snapshot"]["daily_floor"] = 974
        updated = check()
        self.assertEqual((updated["stop_loss"],updated["take_profit"]),(None,52))
        self.assertIn("daily_floor",updated["changed"])
        obs["snapshot"].pop("daily_floor")
        missing = check()
        self.assertTrue(missing["reselect"])
        self.assertIn("爆仓线",missing["open_lock"]["reason"])
        self.assertFalse(self.nodes["east"].get("ratio")["intents"])

    def test_phase_two_size_and_migrated_take_profit_defaults(self):
        self.center.strategy("config",dict(size_percent=25,phase2_size_percent=75),"east")
        self.start_cards([self.card("Second",phase="2/2")])
        cmd, = self.center.state("east")["commands"]
        self.assertEqual(cmd["params"]["size_percent"],75)
        self.assertNotIn("take_profit",cmd["params"])
        old = {**strategy_config.DEFAULT_CONFIG,"size_percent":50,"live_size_percent":100,"live_take_profit":30,"take_profit":14}
        for k in ("phase2_size_percent","live_first_size_percent","live_repeat_size_percent","live_take_profit_mode"):
            old.pop(k)
        cfg = strategy_config.migrate(old)
        self.assertEqual((cfg["phase2_size_percent"],cfg["live_first_size_percent"],cfg["live_repeat_size_percent"]),(50,100,100))
        self.assertEqual((cfg["live_take_profit_mode"],cfg["live_take_profit"],cfg["live_reward_ratio"]),("fixed",30,1))
        self.assertNotIn("take_profit",cfg)

    def test_full_payout_uses_native_six_decimal_amount_and_actual_debit(self):
        policy = dict(open_id="fill",quote_id="quote",live_payout_mode="all",live_payout_recipient="main",
                      live_payout_amount=10,live_payout_percent=50)
        gross = 62.549876
        proof = dict(available=gross,amount=gross,received=50.039900,balance_before=5062.55,recipient="main",
                     flat=dict(leverage=0,position_margin=0,order_margin=0,observed_at=self.time))
        cmd = dict(action="profit.withdraw",account="Live",phase="live",params={"amount":gross},
                   strategy_payout=policy,intents={"withdraw":{"proof":proof}})
        strategy_payout.validate(policy)
        strategy_payout.check_quote(cmd,proof,self.time)
        snap = dict(position_open=False,balance=5000)
        receipt = dict(observation=dict(name="Live",phase="live",snapshot=snap),amount=gross,recipient="main")
        verify_financial_receipt(cmd,receipt)
        snap["balance"] = 4970
        with self.assertRaises(Problem):
            verify_financial_receipt(cmd,receipt)

    def test_zero_page_quote_ends_live_settlement_without_a_withdrawal(self):
        self.plugin_meta["plugin_version"] = self.center.plugin_version
        self.card_report("east",[self.card("Live",category="funded",phase="live")])
        self.report("east",observation={**self.reading("Live"),"category":"funded","phase":"live"})
        self.center.sync("east")
        s = {"run":"zero-test","policy_version":2,"claims":{}}
        opened = dict(id="closed-fill",node_id="east",worker_id="browser",account="Live",
                      source="strategy-zero-test",phase="live",updated_at=self.time-2)
        def settle():
            with self.center.db.tx() as db:
                inv = self.center._inventory(db,"east")
                return self.center._live_exit(db,s,opened,inv[2]["east","browser","Live"],inv,self.time)
        self.assertFalse(settle())
        self.center.sync("east")
        quote = self.plugin("east","poll")["command"]
        self.plugin("east","result",id=quote["id"],ok=True,result=dict(account="Live",phase="live",available=0,observed_at=self.time))
        self.center.sync("east")
        self.assertTrue(settle())
        self.assertTrue(s["claims"]["closed-fill"]["done"])
        self.assertFalse(any(c["action"]=="profit.withdraw" for c in self.center.state("east")["commands"]))

    def test_entry_tiers_only_use_confirmed_openings_of_that_account_and_day(self):
        req = self.req(action="order.open",params=dict(side="buy",micro=1))
        self.center.submit("unfilled",req)
        self.center.cancel("unfilled")
        with self.center.db.tx() as db:
            a = self.center._inventory(db,"east")[2]["east","browser","Shared"]
            self.assertFalse(self.center._opened_today(db,a))
            for name in ("Other","Shared"):
                ledger.save(db,("east","browser",name),"position","p-"+name,
                            {"phase":"live","history":True,"opened_at":self.time-10,"closed_at":self.time})
                self.assertEqual(self.center._opened_today(db,a),name=="Shared")
            self.time = daily_floor.entry_day_window(self.time)["end"]
            self.assertFalse(self.center._opened_today(db,a))

    def test_plugin_version_reporting_and_old_clients(self):
        target = self.center.plugin_version
        for actual,status,can_open in (("1.5.1","behind",False),("1.6.0","behind",True),(target,"current",True),
                                      ("1.10.0","ahead",True),("","unknown",False)):
            self.plugin("east","heartbeat",plugin_version=actual)
            self.center.sync("east")
            state = self.center.state("east")
            worker = state["workers"][0]
            self.assertEqual((state["plugin_version"],worker["plugin_version"],worker["version_status"]),(target,actual,status))
            self.assertEqual(worker["supports_open_policy"],can_open)
        with self.assertRaisesRegex(Problem,"插件版本号"):
            self.plugin("east","heartbeat",plugin_version="invalid")

    def test_position_metrics_keep_trade_identity_and_allow_sparse_recovery(self):
        bridge = self.nodes["east"]
        initial = [self.card("Shared",active_positions=1,pnl=3), self.card("Other")]
        self.card_report("east",initial)
        obs = self.reading("Shared")
        obs["snapshot"].update(position_open=True,position_id="pid",symbol="NQ-PERP",side="sell",quantity=2,
                               entry_price=1250,native_sl_absent=True,native_tp_price=1230)
        self.report("east",observation=obs)
        self.plugin("east","heartbeat",page="/accounts")
        self.center.sync("east")
        baseline = bridge.status("initial")
        gen = baseline["card_generation"]
        def tick(changes, *, base=None):
            previous = self.time
            self.time += 1
            return self.plugin("east","report",page="/accounts",metrics=dict(generation=gen,base_at=previous if base is None else base,
                               observed_at=self.time,directory=False,items=changes))
        tick([dict(name="Shared",pnl=-7.25,drawdown=42,daily_loss=0)])
        delta = bridge.status(baseline["status_cursor"])
        self.assertNotIn("accounts",delta)
        self.assertTrue(all(isinstance(value,(int,float)) for _,value in delta["changes"]))
        self.center.sync("east",metrics_only=True)
        a = next(a for a in self.center.state("east")["accounts"] if a["name"]=="Shared")
        self.assertEqual([a["position_detail"][k] for k in ("symbol","quantity","take_profit","stop_loss","submitted_at")],
                         ["NQ-PERP",2,40,"omitted",None])
        self.assertEqual(len(self.center.position_metrics("east")["items"]),1)
        m = self.center.position_metrics("east")["items"][0]
        self.assertEqual([m[k] for k in ("position_id","at","pnl","drawdown","daily_loss")],["pid",self.time,-7.25,42,0])
        self.assertNotIn("snapshot",m)
        self.assertFalse(self.center.position_metrics("west")["items"])
        self.assertTrue(next(a for a in bridge.status()["accounts"] if a["name"]=="Other")["present"])
        base = self.time
        with self.assertRaisesRegex(Problem,"基线"):
            tick([],base=base-1)
        with self.assertRaisesRegex(Problem,"未识别"):
            tick([dict(name="Shared",quantity=99)],base=base)
        tick([dict(name="Shared",active_positions=0)],base=base)
        self.center.sync("east")
        self.assertEqual(self.center.position_metrics("east")["items"],[])
        tick([dict(name="Shared",active_positions=1,pnl=0)])
        self.center.sync("east")
        reopened = next(a for a in self.center.state("east")["accounts"] if a["name"]=="Shared")
        self.assertIsNone(reopened["position_detail"])

    def test_displayed_order_time_and_protection_belong_to_the_confirmed_fill(self):
        self.start_cards([self.card("One")])
        self.center.sync("east")
        opened = self.fill_exam_order()
        submitted = self.nodes["east"].get(opened["id"])["intents"]["open"]["time"]
        self.time += 8
        self.card_report("east",[self.card("One",active_positions=1,pnl=25)])
        self.center.sync("east")
        account = next(a for a in self.center.state("east")["accounts"] if a["name"]=="One")
        detail = account["position_detail"]
        self.assertEqual([detail[k] for k in ("quantity","entry_price","take_profit","stop_loss","submitted_at")],
                         [2,1000,"omitted",10,submitted])
        self.assertLess(detail["submitted_at"],account["card_at"])
        self.time += 1
        self.card_report("east",[self.card("One",active_positions=2,pnl=35)])
        self.center.sync("east")
        account = next(a for a in self.center.state("east")["accounts"] if a["name"]=="One")
        self.assertIsNone(account["position_detail"])

    def test_floor_reset_with_dst_gross_debits_and_duplicate_history(self):
        at = datetime.fromisoformat("2026-11-01T14:00:00+00:00").timestamp()
        route = ("east","browser","Live")
        with self.nodes["east"].db.tx() as db:
            def level(stamp=at):
                return daily_floor.view(db,*route[1:],stamp)
            daily_floor.capture(db,*route[1:],at-2000,300)
            self.assertFalse(level()["verified"])
            self.assertIsNone(daily_floor.stop_amount(9850,level(),10))
            daily_floor.capture(db,*route[1:],at-2000,300,10000,9700)
            day = level()
            self.assertEqual(day["end"]-day["start"],25*3600)
            self.assertEqual(daily_floor.stop_amount(9850,day,20),130)
            for ref,stamp in (("a",at-600),("b",at-400)):
                ledger.save(db,route,"withdrawal",ref,dict(phase="live",amount=40,expected_received=32,verified_at=stamp))
            def payout(ref,amount,created,executed):
                ledger.native_rows(db,route,{"items":[dict(kind="payout",ref=ref,status="completed",gross_amount=amount,
                                   net_amount=amount*0.8,created_at=created,executed_at=executed,phase="live")]})
            for _ in range(2):
                payout("platform-a",40,at-605,at-590)
                payout("external",15,at-150,at-120)
            self.assertIsNone(level()["floor"])
            daily_floor.capture(db,*route[1:],at,300,10000,9605)
            self.assertEqual((level()["gross_withdrawn"],level()["floor"]),(95,9605))
            reset = day["end"]
            self.assertIsNone(level(reset))
            daily_floor.capture(db,*route[1:],reset,297,9900)
            payout("settled-later",40,at-401,reset+90)
            self.assertEqual((level(reset+90)["gross_withdrawn"],level(reset+90)["floor"]),(0,None))
            spring = datetime.fromisoformat("2026-03-08T14:00:00+00:00").timestamp()
            daily_floor.capture(db,*route[1:],spring,platform=9700)
            self.assertEqual(level(spring)["end"]-level(spring)["start"],23*3600)
            daily_floor.capture(db,*route[1:],spring+10,allowance=299.99)
            self.assertEqual((level(spring)["source"],level(spring)["floor"]),("platform",9700))
            daily_floor.capture(db,*route[1:],spring+15,allowance=200,reset=10000)
            self.assertEqual((level(spring+15)["verified"],level(spring+15)["floor"]),(True,9700))

    def test_card_close_schedules_one_targeted_history_read(self):
        items = [self.card("Shared",active_positions=1)]
        self.card_report("east",items)
        self.center.sync("east")
        self.assertEqual(self.center.state("east")["commands"],[])
        self.time+=1
        items[0]["active_positions"]=0
        for _ in range(3):
            self.card_report("east",items,full=False)
            self.center.sync("east")
        cmds = self.center.state("east")["commands"]
        self.assertEqual([(c["action"],c["account"],c["source"]) for c in cmds],[("history.read","Shared","card-close")])

    def test_selected_size_must_leave_one_tick_before_open(self):
        self.enable("east")
        self.start_ready("east")
        self.center.decide()
        self.center.sync("east")
        cmd = self.plugin("east","poll")["command"]
        obs = self.reading(cmd["account"])
        self.assertEqual(self.plugin("east","preflight",id=cmd["id"],observation=obs)["stop_loss"],10)
        checked = self.plugin("east","preflight",id=cmd["id"],observation=obs,quantity=44)
        self.assertTrue(checked["reselect"])
        self.center.sync("east")
        self.center.decide()
        state = self.center.state("east")
        self.assertTrue(state["strategy"]["enabled"])
        self.assertFalse(any(a["candidate"] for a in state["accounts"]))
        self.assertEqual(len(state["commands"]),1)
        self.assertEqual(self.center.get(cmd["id"])["intents"],{})

    @staticmethod
    def req(nid="east", name="Shared", action="account.read", params=None):
        return dict(node_id=nid, worker_id="browser", account=name, action=action, params=params or {})

    def enable(self, nid):
        self.center.account_config(dict(node_id=nid, worker_id="browser", account="Only-" + nid, in_pool=True))

    def test_route_isolation_and_metadata(self):
        self.center.account_config(dict(node_id="east", worker_id="browser", account="Shared", alias="East alias", note="desk"))
        self.center.submit("read-a", self.req("west"))
        for nid in self.nodes:
            self.center.sync(nid)
        self.assertIsNone(self.plugin("east", "poll")["command"])
        self.assertEqual(self.plugin("west", "poll")["command"]["id"], "read-a")
        self.plugin("west", "result", id="read-a", ok=True, result={"test_receipt":"west"})
        self.center.sync("west")
        self.assertEqual(self.center.get("read-a")["result"]["test_receipt"], "west")
        shared = {a["node_id"]: a for a in self.center.state()["accounts"] if a["name"] == "Shared"}
        self.assertEqual((shared["west"]["alias"], shared["east"]["alias"]), ("", "East alias"))
        self.assertNotIn("token", self.center.state()["nodes"][0])

    def test_updates_are_addressed_drain_inflight_and_survive_restart(self):
        target = "a" * 40
        req = {"revision":target}
        for invalid in ({"revision":"main"}, {**req, "command":"test"}):
            with self.assertRaises(Problem):
                self.center.deployment("east","up","create",invalid)
        self.center.submit("inflight", self.req())
        self.enable("east")
        self.start_ready("east")
        self.center.deployment("east","up","create",req)
        self.center.db.close()
        self.center = Center(self.root/"center", self.clock, self.transport)
        self.assertEqual(self.center.deployment("east","up","create",req)["state"],"queued")
        with self.assertRaises(Problem):
            self.center.deployment("east","another","create",req)
        with self.assertRaises(Problem):
            self.center.deployment("east","up","create",{"revision":"b"*40})
        with self.assertRaises(Problem):
            self.center.submit("blocked", self.req(name="Only-east"))
        self.center.decide()
        self.assertIn("软件更新",self.center.state("east")["strategy"]["message"])
        self.center.submit("allowed",self.req("west",name="Only-west"))
        east = {"instance_id":self.nodes["east"].instance_id,"actual":"b"*40}
        self.assertIsNone(self.center.agent("east","poll",east)["job"])
        self.assertIsNone(self.center.agent("west","poll",{**east,"instance_id":self.nodes["west"].instance_id})["job"])
        with self.assertRaises(Problem):
            self.center.agent("west","poll",east)
        self.center.sync("east")
        cmd = self.plugin("east","poll")["command"]
        self.plugin("east","result",id=cmd["id"],ok=True,result={})
        self.center.sync("east")
        for _ in range(2):
            self.assertEqual(self.center.agent("east","poll",east)["job"],{"id":"up",**req})
        with self.assertRaises(Problem):
            self.center.deployment("east","up","cancel",{})
        self.center.deployment("west","up","create",req)
        self.assertEqual(self.center.deployment("west","up","cancel",{})["state"],"cancelled")

    def test_update_confirmation_uses_fresh_actual_versions_from_each_browser(self):
        target = "d"*40
        bridge = self.nodes["east"]
        source = {"actual":"c"*40, "instance_id":bridge.instance_id}
        self.center.deployment("east","up","create",{"revision":target})
        self.center.agent("east","poll",source)
        report = {**source, "id":"up", "revision":target, "state":"installed", "expected":["second","browser"]}
        with self.assertRaises(Problem):
            self.center.agent("east","report",report)
        bridge.release = target
        report["actual"] = target
        self.center.agent("east","report",report)
        self.center.sync("east")
        self.assertEqual(self.center.state("east")["nodes"][0]["update"]["state"],"installed")
        self.assertEqual(self.plugin("east","poll")["update_release"],target)
        self.plugin("east","heartbeat",release=target)
        self.center.sync("east")
        self.assertEqual(self.center.state("east")["nodes"][0]["update"]["confirmed"],["browser"])
        self.time += 30
        self.plugin("east","heartbeat",worker_id="second",release=target)
        self.center.sync("east")
        job = self.center.deployment("east","up","get",{})
        self.assertEqual((job["state"],job["confirmed"]),("succeeded",["browser","second"]))
        self.assertEqual(self.center.agent("east","report",report)["state"],"succeeded")

    def test_update_agent_http_credentials_are_node_scoped(self):
        from deploy.node_agent import http
        admin = secrets.token_hex(24)
        api = make_server("127.0.0.1",0,self.center,admin)
        threading.Thread(target=api.serve_forever,daemon=True).start()
        self.addCleanup(api.server_close)
        self.addCleanup(api.shutdown)
        base = "http://127.0.0.1:"+str(api.server_port)+"/v1/"
        node = self.center.agent_secret("east")
        body = {"instance_id":self.nodes["east"].instance_id,"actual":"a"*40}
        for path,token,payload in (("state",node,None),("node-agent/west/poll",node,body),("node-agent/east/poll",admin,body)):
            with self.assertRaises(HTTPError) as ctx:
                http(base+path,token,payload)
            self.assertEqual(ctx.exception.code,401)
            ctx.exception.close()
        http(base+"nodes/east/updates/up",admin,{"revision":"b"*40},"PUT")
        self.assertEqual(http(base+"node-agent/east/poll",node,body)["job"]["id"],"up")

    def test_update_dispatch_cli_retries_and_reports_partial_success(self):
        import os
        import subprocess
        import sys
        admin = secrets.token_hex(24)
        api = make_server("127.0.0.1",0,self.center,admin)
        threading.Thread(target=api.serve_forever,daemon=True).start()
        self.addCleanup(api.server_close)
        self.addCleanup(api.shutdown)
        command = [sys.executable,"-B",str(Path(__file__).resolve().parents[1]/"deploy"/"dispatch_update.py"),
                   "--center",f"http://127.0.0.1:{api.server_port}","--revision","a"*40,"--request-id","cli","--node","east"]
        def run(args):
            return subprocess.run(args,capture_output=True,text=True,encoding="utf-8",timeout=10,
                                  env={**os.environ,"VEST_ADMIN_TOKEN":admin,"PYTHONIOENCODING":"utf-8"})
        failure = run(command+["--node","absent"])
        self.assertEqual(failure.returncode,1)
        self.assertIn("east queued",failure.stdout)
        self.assertIn("absent",failure.stderr)
        self.assertEqual(run(command+["--node","west"]).returncode,0)
        self.assertEqual(run(command+["--wait","1"]).returncode,2)
        for nid in ("east","west"):
            self.assertEqual(self.center.deployment(nid,"cli","get",{})["revision"],"a"*40)

    def test_crash_lost_ack_and_idempotent_result(self):
        self.center.submit("stable-key", self.req())
        self.lose_delivery = True
        self.center.sync("east")
        self.assertEqual(self.center.get("stable-key")["status"], "sending")
        self.center.db.close()
        self.center = Center(self.root / "center", self.clock, self.transport)
        self.nodes["east"].db.close()
        self.nodes["east"] = Bridge(self.root / "east", "east", self.clock)
        self.plugin("east", "heartbeat")
        self.center.sync("east")
        with concurrent.futures.ThreadPoolExecutor(4) as pool:
            claims = list(pool.map(lambda _: self.plugin("east", "poll")["command"], range(4)))
        self.assertEqual([c["id"] for c in claims if c], ["stable-key"])
        self.plugin("east", "result", id="stable-key", ok=True, result={"verified":1})
        self.plugin("east", "result", id="stable-key", ok=False, result={"verified":2})
        self.center.sync("east")
        self.assertEqual(self.center.submit("stable-key", self.req())["result"], {"verified":1})
        with self.assertRaises(Problem):
            self.center.submit("stable-key", self.req(name="Only-east"))

    def test_permissions_session_invalidation_and_timeout(self):
        self.center.submit("queued-read", self.req())
        self.center.sync("east")
        self.plugin("east", "heartbeat", mode="readonly", generation=2, session_id="session-2")
        with self.assertRaises(Problem):
            self.plugin("east", "poll")
        self.assertEqual(self.nodes["east"].get("queued-read")["status"], "cancelled")
        self.center.sync("east")
        with self.assertRaisesRegex(Problem, "只读|消失"):
            self.center.submit("no-write", self.req(action="order.open", params={"side":"buy","micro":1,"stop_buffer":1}))
        self.time += 26
        self.center.sync("east")
        state = self.center.state()
        east = next(n for n in state["nodes"] if n["id"] == "east")
        self.assertTrue(east["online"])
        self.assertFalse(any(w["online"] for w in state["workers"] if w["node_id"] == "east"))
        self.assertFalse(next(n for n in state["nodes"] if n["id"] == "west")["online"])

    def test_expired_queued_command_and_cancel_after_lost_delivery(self):
        self.center.submit("late", self.req())
        self.center.submit("cancel", self.req())
        self.lose_delivery = True
        self.center.sync("east")
        self.center.cancel("cancel")
        self.center.sync("east")
        self.assertEqual(self.center.get("cancel")["status"], "cancelled")
        self.time += 91
        self.assertIsNone(self.plugin("east", "poll")["command"])
        self.assertEqual(self.nodes["east"].get("late")["status"], "expired")

    def test_ambiguous_names_primary_and_changed_bridge_identity(self):
        self.report("east", inventory=[dict(name="Main", category="eval"), dict(name="Shared", category="eval"),
                                      dict(name="Shared", category="funded")])
        self.center.sync("east")
        with self.assertRaisesRegex(Problem, "不唯一"):
            self.center.submit("ambiguous", self.req())
        req = self.req(name="Main", action="order.open", params={"side":"sell","micro":1,"stop_buffer":1})
        with self.assertRaisesRegex(Problem, "主账户"):
            self.center.submit("main", req)
        self.center.submit("old-store", self.req("west"))
        self.nodes["west"].db.close()
        self.nodes["west"] = Bridge(self.root / "fresh-west", "west", self.clock)
        self.center.sync("west")
        self.assertIn("身份已改变", next(n["error"] for n in self.center.state()["nodes"] if n["id"] == "west"))
        with self.assertRaises(Problem):
            self.nodes["west"].get("old-store")

    def test_node_strategies_keep_separate_pools_config_and_restart(self):
        with self.assertRaisesRegex(Problem, "节点"):
            self.center.strategy("start", {})
        for nid, side in (("east","buy"), ("west","sell")):
            self.enable(nid)
            self.center.strategy("config", {"side":side}, nid)
            self.start_ready(nid)
        self.center.decide()
        original = self.center.state()["commands"]
        self.assertEqual({c["node_id"] for c in original}, {"east","west"})
        self.assertEqual({(c["node_id"],c["params"]["side"]) for c in original}, {("east","buy"),("west","sell")})
        self.assertTrue(all(c["account"] == "Only-" + c["node_id"] for c in original))
        self.center.db.close()
        self.center = Center(self.root / "center", self.clock, self.transport)
        self.center.decide()
        self.assertEqual(len(self.center.state()["commands"]), 2)
        self.center.sync("east")
        self.center.strategy("stop", {}, "east")
        self.center.sync("east")
        self.assertEqual(self.center.state("east")["commands"][0]["status"], "cancelled")
        self.assertEqual(self.center.state("west")["commands"][0]["status"], "pending")
        self.assertTrue(self.center.state("west")["strategy"]["enabled"])
        self.assertIsNone(self.center.state()["strategy"])

    def test_duplicate_trading_identity_and_independent_logins(self):
        for nid in self.nodes:
            self.center.account_config(dict(node_id=nid, worker_id="browser", account="Shared", in_pool=True))
        self.center.strategy("config", {"batch_size":2}, "east")
        self.start_ready("east")
        self.center.decide()
        self.assertEqual(self.center.state()["commands"], [])
        self.center.strategy("stop", {}, "east")
        p = {"side":"buy", "micro":1, "stop_buffer":2}
        self.center.submit("first", self.req(action="order.open", params=p))
        with self.assertRaisesRegex(Problem, "未完成"):
            self.center.submit("duplicate", self.req("west", action="order.open", params=p))
        self.center.account_config(dict(node_id="west", worker_id="browser", account="Shared", account_ref="independent-login"))
        self.assertEqual(self.center.submit("distinct", self.req("west", action="order.open", params=p))["status"], "pending")

    def test_return_to_readonly_keeps_historical_balances_and_times(self):
        self.plugin("east", "heartbeat", mode="readonly", generation=2, session_id="session-2")
        self.center.sync("east")
        a = next(a for a in self.center.state()["accounts"] if a["node_id"] == "east" and a["name"] == "Shared")
        self.assertTrue(a["present"])
        self.assertFalse(a["fresh"])
        self.assertEqual(a["snapshot"]["equity"], 1000)
        self.assertEqual(a["observed_at"], self.time)

    def test_late_receipt_and_invalid_proof(self):
        p = {"side":"buy","micro":1,"stop_buffer":20}
        self.center.submit("late-proof", self.req(action="order.open", params=p))
        self.center.sync("east")
        self.plugin("east", "poll")
        self.plugin("east", "intent", id="late-proof", stage="open", proof={"quantity":2})
        self.time += 121
        self.center.sync("east")
        self.assertEqual(self.center.get("late-proof")["status"], "unknown")
        self.plugin("east", "result", id="late-proof", ok=True, result={})
        self.assertEqual(self.nodes["east"].get("late-proof")["status"], "unknown")
        evidence = dict(name="Shared", phase="1/2", category="eval", snapshot=dict(equity=1000,balance=1000,unrealized_pnl=0,
            position_open=True, position_id="synthetic", symbol="NQ-PERP", side="buy", quantity=2, entry_price=20000,
            observed_at=self.time, native_sl_price=19995, stop_check={"status":"verified","target_risk":10}, take_profit_check={"status":"omitted"}))
        wrong = {**evidence,"snapshot":{**evidence["snapshot"],"native_sl_price":19994.75}}
        self.assertEqual(self.plugin("east","result",id="late-proof",ok=True,
                         result={"observation":wrong})["status"],"unknown")
        self.plugin("east", "result", id="late-proof", ok=True, result={"observation":evidence})
        self.center.sync("east")
        self.assertEqual(self.center.get("late-proof")["status"], "succeeded")
        self.assertEqual(self.center.history("unknown")["total"], 0)

    def test_lost_node_blocks_mutations_until_original_ledger_replies(self):
        req = self.req(action="order.open", params={"side":"buy","micro":1,"stop_buffer":1})
        self.center.submit("partition", req)
        self.lose_delivery = True
        self.center.sync("east")
        self.time += 211
        self.center.decide()
        self.assertEqual(self.center.get("partition")["status"], "unknown")
        self.center.sync("east")
        self.assertEqual(self.center.get("partition")["status"], "expired")
        self.assertIsNone(self.plugin("east", "poll")["command"])

    def test_uncertain_financial_intent_never_released_twice(self):
        # Simulate a stopped worker at the protocol boundary. No clicks or broker exist.
        self.enable("east")
        self.start_ready("east")
        self.center.decide()
        self.center.sync("east")
        cmd = self.plugin("east", "poll")["command"]
        intent = dict(id=cmd["id"], stage="open", proof={"synthetic":True})
        self.assertTrue(self.plugin("east", "intent", **intent)["authorize_click"])
        self.assertFalse(self.plugin("east", "intent", **intent)["authorize_click"])
        self.time += 121
        self.assertIsNone(self.plugin("east", "poll")["command"])
        self.center.sync("east")
        self.center.decide()
        self.assertFalse(self.center.state("east")["strategy"]["enabled"])
        self.assertEqual(self.center.get(cmd["id"])["status"], "unknown")
        with self.assertRaisesRegex(Problem, "待核验"):
            self.center.submit("again", self.req(name="Only-east", action="order.open", params=cmd["params"]))
        self.center.resolve(cmd["id"], {"executed":True,"note":"离线协议测试"})
        with self.assertRaisesRegex(Problem, "交易日"):
            self.center.submit("again", self.req(name="Only-east", action="order.open", params=cmd["params"]))

    def fill_exam_order(self):
        cmd = self.plugin("east", "poll")["command"]
        self.assertEqual(cmd["action"],"order.open")
        self.plugin("east", "intent", id=cmd["id"], stage="open", proof={"quantity":2})
        snap = dict(position_open=True, position_id="position-"+cmd["id"], symbol="NQ-PERP", side=cmd["params"]["side"],
                    quantity=2, entry_price=1000, balance=1000, equity=1000, unrealized_pnl=0, observed_at=self.time,
                    native_sl_price=995 if cmd["params"]["side"]=="buy" else 1005,
                    stop_check={"status":"verified","target_risk":10}, take_profit_check={"status":"omitted"})
        receipt = self.plugin("east", "result", id=cmd["id"], ok=True,
                              result={"observation":{"name":cmd["account"],"phase":cmd["phase"],"snapshot":snap}})
        self.assertEqual(receipt["status"],"succeeded")
        return cmd

    def finish_exit_list(self, cards, full=True):
        self.center.sync("east")
        check = self.plugin("east","poll")["command"]
        self.assertEqual(check["action"],"accounts.list")
        self.time += 1
        self.card_report("east",cards,full=full)
        rows = [{k:c[k] for k in ("name","phase","category")} for c in cards]
        self.plugin("east","result",id=check["id"],ok=True,
                    result=dict(source="accounts",full=full,count=len(rows),inventory=rows))
        self.center.sync("east")
        self.center.decide()

    def test_batch_waits_for_observed_exit_then_interval(self):
        self.enable("east")
        self.center.strategy("config", {"interval_seconds":2}, "east")
        self.start_ready("east")
        self.center.decide()
        self.center.sync("east")
        cmd = self.fill_exam_order()
        self.center.sync("east")
        self.enable("west")
        self.center.account_config(dict(node_id="east", worker_id="browser", account="Shared", in_pool=True))
        self.center.decide()
        self.assertEqual(self.center.state("east")["strategy"]["members"], [cmd["id"]])
        self.time += 1
        self.observe("east", "Only-east")
        self.center.sync("east")
        self.center.decide()
        self.assertEqual(self.center.state("east")["strategy"]["message"], "批间等待")
        self.center.decide()
        self.assertEqual(len(self.center.state()["commands"]), 1)
        self.time += 2
        self.center.decide()
        self.assertEqual(self.center.state()["commands"][0]["account"], "Shared")
        self.assertEqual(self.center.state("west")["commands"], [])

    def test_disappeared_batch_shares_one_full_list_and_resumes_after_cooldown(self):
        self.center.strategy("config",{"batch_size":2},"east")
        self.start_cards([self.card("One"),self.card("Two")])
        self.center.sync("east")
        fills = [self.fill_exam_order() for _ in range(2)]
        self.time += 1
        next_cards = [self.card("Three"),self.card("Four")]
        self.card_report("east",next_cards,full=False)
        self.center.sync("east")
        self.center.decide()
        self.center.db.close()
        self.center = Center(self.root/"center",self.clock,self.transport)
        self.center.decide()
        state = self.center.state("east")
        self.assertEqual(set(state["strategy"]["members"]),{c["id"] for c in fills})
        self.assertEqual([c["action"] for c in state["commands"]].count("accounts.list"),1)
        self.assertEqual(self.center.state("west")["commands"],[])
        self.finish_exit_list(next_cards)
        waiting = self.center.state("east")["strategy"]
        self.assertEqual((waiting["message"],waiting["members"],waiting["next_at"]),("批间等待",[],self.time+60))
        with self.center.db.read() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM book WHERE kind='position' AND closed=1").fetchone()[0],0)
        self.time += 59
        self.card_report("east",next_cards)
        self.center.sync("east")
        self.center.decide()
        self.assertEqual(self.center.state("east")["strategy"]["next_at"],waiting["next_at"])
        self.time += 1
        self.center.decide()
        advanced = self.center.state("east")["strategy"]
        self.assertEqual((advanced["run"],advanced["batch"]),(waiting["run"],2))
        self.assertEqual({self.center.get(i)["account"] for i in advanced["members"]},{"Three","Four"})

    def test_partial_list_and_renamed_open_position_do_not_finish_batch(self):
        self.center.strategy("config",{"batch_size":2},"east")
        self.start_cards([self.card("Gone"),self.card("Holding")])
        self.center.sync("east")
        for _ in range(2):
            self.fill_exam_order()
        self.time += 1
        renamed = self.card("Renamed",id="card-Holding",active_positions=1)
        self.card_report("east",[renamed])
        self.center.sync("east")
        self.center.decide()
        self.finish_exit_list([renamed],full=False)
        self.assertIn("核对本批",self.center.state("east")["strategy"]["message"])
        self.time += 31
        self.card_report("east",[renamed],full=False)
        self.center.sync("east")
        self.center.decide()
        self.finish_exit_list([renamed])
        self.assertEqual(self.center.state("east")["strategy"]["message"],"等待本批全部持仓确认结束")
        self.time += 1
        self.card_report("east",[{**renamed,"active_positions":0}],full=False)
        self.center.sync("east")
        self.center.decide()
        self.assertEqual(self.center.state("east")["strategy"]["message"],"批间等待")

    def test_name_reuse_needs_full_directory_confirmation(self):
        self.start_cards([self.card("Reused")])
        self.center.sync("east")
        self.fill_exam_order()
        self.time += 1
        replacement = self.card("Reused",id="different-card")
        self.card_report("east",[replacement])
        self.center.sync("east")
        self.center.decide()
        self.assertIn("核对本批",self.center.state("east")["strategy"]["message"])
        self.finish_exit_list([replacement])
        self.assertEqual(self.center.state("east")["strategy"]["message"],"批间等待")

    def test_account_reappearing_in_verification_keeps_its_batch_open(self):
        self.start_cards([self.card("Visible")])
        self.center.sync("east")
        opened = self.fill_exam_order()
        self.time += 1
        self.card_report("east",[],full=False)
        self.center.sync("east")
        self.center.decide()
        self.finish_exit_list([self.card("Visible",active_positions=1)])
        state = self.center.state("east")["strategy"]
        self.assertEqual((state["message"],state["members"]),("等待本批全部持仓确认结束",[opened["id"]]))
        self.time += 1
        self.card_report("east",[])
        self.center.sync("east")
        self.center.decide()
        self.finish_exit_list([])
        self.assertEqual(self.center.state("east")["strategy"]["message"],"批间等待")

    def test_overnight_windows_stage_win_rates_and_mirrors(self):
        def at(day, hour, minute=0):
            return datetime(2026, 11, day, hour, minute, tzinfo=ZONE).timestamp()
        def position(ref, stamp, pnl, phase=None):
            return dict(kind="position",ref=ref,symbol="NQ-PERP",closed_at=stamp,pnl=pnl,phase=phase)
        rows = [position("too-early", at(23,21,59), 100, "live"),
                position("win", at(23,22), 7.125, "1/2"), position("loss", at(24,0), -3, "1/2"),
                position("flat", at(24,1,59), 0, "2/2"), position("missing", at(24,1), None),
                position("at-end", at(24,2), 50, "live"), position("next-evening", at(24,22), 60, "live")]
        self.report("east", history=dict(name="Shared", items=rows))
        self.report("west", history=dict(name="Shared", items=[rows[1],position("west-only",at(23,23),10,"live")]))
        for node in self.nodes:
            self.center.sync(node)
        query = dict(from_date="2026-11-23", to_date="2026-11-23", start_time="22:00", end_time="02:00")
        result = self.center.analytics(query)
        by_node = {n["node_id"]:n for n in result["nodes"]}
        east = by_node["east"]
        self.assertEqual((east["wins"], east["losses"], east["flat"], east["unsettled"]), (1,1,1,1))
        self.assertEqual((east["win_rate"], east["realized_pnl"]), (1/3,4.125))
        self.assertEqual(result["summary"]["realized_pnl"], 14.125)
        self.assertEqual(by_node["west"]["realized_pnl"],17.125)
        stages = {s["phase"]:s for s in east["stages"]}
        self.assertEqual((stages["1/2"]["win_rate"], stages["2/2"]["win_rate"],stages["unknown"]["win_rate"]), (.5,0,None))
        self.assertEqual(self.center.analytics(dict(query,node_id="east",phase="unknown"))["total"],1)
        self.assertEqual(self.center.analytics(dict(query,account="Only-east"))["total"],0)
        self.assertEqual(self.center.analytics(dict(node_id="east",from_date="2026-11-24",to_date="2026-11-24"))["total"],5)
        with self.assertRaises(Problem):
            self.center.analytics(dict(start_time="25:00"))
        with self.assertRaises(Problem):
            self.center.analytics(dict(from_date="2026-02-30"))

    def test_open_evidence_is_enriched_by_platform_close_and_order_updates(self):
        snap = dict(position_open=True,position_id="p1",symbol="NQ-PERP",side="buy",quantity=2,entry_price=100,
                    equity=1040,balance=1000,unrealized_pnl=40,observed_at=self.time)
        self.report("east",observation=dict(name="Shared",phase="1/2",snapshot=snap))
        self.center.sync("east")
        self.assertIsNone(self.center.analytics({"node_id":"east"})["summary"]["realized_pnl"])
        self.time += 1
        self.observe("east","Shared")
        self.center.sync("east")
        pending = self.center.analytics({})["summary"]
        self.assertEqual((pending["unsettled"],pending["settled"]),(1,0))
        native = dict(kind="position",ref="p1",closed_at=self.time,pnl=-1.23)
        order = dict(kind="order",ref="o1",created_at=self.time-50,updated_at=self.time,status="Filled",size_text="2 / 2")
        self.report("east",history=dict(name="Shared",items=[native,order]))
        self.center.sync("east")
        seq = self.nodes["east"].status()["ledger_seq"]
        self.report("east",history=dict(name="Shared",items=[native,dict(order,status="Open",updated_at=self.time-30)]))
        self.assertEqual(self.nodes["east"].status()["ledger_seq"],seq)
        self.center.db.close()
        self.center = Center(self.root/"center",self.clock,self.transport)
        self.center.sync("east")
        book = self.center.analytics({"node_id":"east","phase":"1/2"})
        self.assertEqual((book["total"],book["summary"]["losses"],book["summary"]["unsettled"]),(1,1,0))
        self.assertEqual((book["items"][0]["pnl"],book["items"][0]["entry_price"]),(-1.23,100))
        orders = self.center.analytics({"section":"order"})["items"]
        self.assertEqual([(o["ref"],o["status"]) for o in orders],[("o1","Filled")])
        self.assertEqual(self.center.analytics({"section":"instruction"})["total"],0)

    def test_evaluation_chain_deduplicates_inherited_position_rows(self):
        original = dict(kind="position",ref="native-id",symbol="NQ-PERP",closed_at=self.time,pnl=5,phase="1/2")
        self.report("east",history=dict(name="Shared",items=[original]))
        self.report("east",history=dict(name="Only-east",items=[dict(original,source_account_id="first-eval")]))
        self.report("west",history=dict(name="Shared",items=[original]))
        for nid in self.nodes:
            self.center.sync(nid)
        self.assertEqual(self.center.analytics({})["summary"]["wins"],1)
        self.assertEqual(self.center.analytics({"node_id":"east"})["total"],1)
        self.assertEqual(self.center.analytics({"account":"Only-east"})["summary"]["realized_pnl"],5)
        self.assertEqual(self.center.analytics({"account":"Shared"})["summary"]["realized_pnl"],5)

    def test_verified_withdrawal_is_counted_once_and_unproved_receipt_excluded(self):
        def flat(balance):
            return dict(name="Shared",phase="live",category="funded",snapshot=dict(position_open=False,
                        balance=balance,equity=balance,unrealized_pnl=0,observed_at=self.time))
        self.report("east",observation=flat(1000))
        self.center.sync("east")
        def simulated_receipt(key,amount,before,after):
            req = self.req(action="profit.withdraw",params={"amount":amount})
            self.center.submit(key,req)
            self.center.sync("east")
            self.assertEqual(self.plugin("east","poll")["command"]["id"],key)
            self.plugin("east","intent",id=key,stage="withdraw",proof=dict(amount=amount,recipient="main",balance_before=before))
            self.time += 1
            result = dict(observation=flat(after),amount=amount,recipient="main",expected_received=amount*.8)
            self.plugin("east","result",id=key,ok=True,result=result)
            self.center.sync("east")
            return result
        receipt = simulated_receipt("paid",12.345678,1000,987.654322)
        self.plugin("east","result",id="paid",ok=True,result=receipt)
        simulated_receipt("unverified",.001,987.654322,987.654322)
        self.assertEqual(self.center.get("unverified")["status"],"unknown")
        self.center.resolve("unverified",dict(executed=True,note="缺少账户扣款证明"))
        report = self.center.analytics({"node_id":"east","section":"withdrawal"})
        self.assertEqual((report["total"], report["summary"]["total_withdrawn"]),(1,12.345678))
        self.assertAlmostEqual(report["items"][0]["expected_received"],12.345678*.8)
        self.assertEqual(report["nodes"][0]["stages"][2]["withdrawals"],1)
        # Model a pre-ledger center with the same original command receipts.
        with self.center.db.tx() as db:
            db.execute("DELETE FROM book")
            db.execute("DELETE FROM book_migrations")
        self.center.db.close()
        self.center = Center(self.root/"center",self.clock,self.transport)
        self.assertEqual(self.center.analytics({})["summary"]["total_withdrawn"],12.345678)

    def test_history_replication_retries_without_offlining_node_and_logs_transitions(self):
        rows = [dict(kind="order",ref="o"+str(i),created_at=self.time+i) for i in range(220)]
        for batch in (rows[:200],rows[200:]):
            self.report("east",history={"name":"Shared","items":batch})
        def interrupted(node,verb,path,data=None):
            if path.startswith("/v1/ledger?after=200"):
                raise Problem("模拟历史分页网络中断",502)
            return self.transport(node,verb,path,data)
        self.center.transport = interrupted
        self.center.sync("east")
        node = self.center.state("east")["nodes"][0]
        self.assertTrue(node["online"])
        self.assertIn("网络中断",node["history_error"])
        self.assertEqual(self.center.analytics({"section":"order"})["total"],200)
        log_count = self.center.logs("east")["total"]
        self.center.sync("east")
        self.assertEqual(self.center.logs("east")["total"],log_count)
        self.center.transport = self.transport
        self.center.sync("east")
        page = self.center.analytics({"section":"order","offset":200})
        self.assertEqual((page["total"],len(page["items"])),(220,20))
        self.assertEqual(self.center.state("east")["nodes"][0]["history_error"],"")
        self.assertFalse(any(e["event"]=="history" for e in self.center.logs("west")["items"]))
        self.assertEqual(len([e for e in self.center.logs("east")["items"] if e["event"]=="history"]),2)
        self.assertEqual(self.center.analytics({"section":"order","node_id":"west"})["total"],0)
        with self.assertRaises(Problem):
            self.report("west",history={"name":"missing","items":rows[:1]})

    def test_platform_payout_uses_completed_net_and_preserves_refunds(self):
        row = dict(kind="payout",ref="payout-1",status="completed",display_id="pa...01",gross_amount=50,
                   net_amount=40,created_at=self.time-100,executed_at=self.time-10,updated_at=self.time-10)
        processing = dict(row,ref="pending",status="processing",executed_at=None)
        unknown_net = dict(row,ref="hidden-amount",net_amount=None)
        for nid in self.nodes:
            self.report(nid,history={"name":"Shared","items":[row,processing,unknown_net]})
            self.center.sync(nid)
        report = self.center.analytics(dict(section="payout"))
        self.assertEqual((report["summary"]["total_paid"],report["summary"]["completed_payouts"]),(40,1))
        self.assertEqual(report["summary"]["total_withdrawn"],0)
        for n in report["nodes"]:
            self.assertEqual(n["stages"][2]["total_paid"],40)
        self.report("east",history={"name":"Shared","items":[dict(row,status="refunded",updated_at=self.time)]})
        self.report("east",history={"name":"Shared","items":[row]})
        self.center.sync("east")
        self.assertEqual(self.center.analytics(dict(section="payout"))["summary"]["total_paid"],0)
        self.assertEqual(self.center.analytics(dict(node_id="east",phase="1/2",section="payout"))["total"],0)
        self.assertEqual(self.center.analytics(dict(node_id="east",phase="live",section="payout"))["total"],3)

    def test_bridge_audit_survives_center_outage_and_bridge_restart(self):
        self.center.submit("offline-read",self.req())
        self.center.sync("east")
        self.time += 1
        self.plugin("east","poll")
        self.plugin("east","result",id="offline-read",ok=True,result={"fixture":True})
        self.report("east",observation={"name":"Shared","error":"页面正在加载"})
        self.observe("east","Shared")
        self.nodes["east"].db.close()
        self.nodes["east"] = Bridge(self.root/"east","east",self.clock)
        self.plugin("east","heartbeat")
        self.center.sync("east")
        events = self.center.logs("east")["items"]
        remote = [e for e in events if e["source"]=="bridge"]
        statuses = [e["message"] for e in remote if e["command_id"]=="offline-read"]
        self.assertTrue(any("running" in message for message in statuses))
        self.assertTrue(any("succeeded" in message for message in statuses))
        self.assertTrue(any(e["message"]=="账户读数恢复" and e["account"]=="Shared" for e in remote))
        self.assertTrue(any(e["message"]=="页面正在加载" for e in self.center.logs("east","warning")["items"]))
        self.assertFalse(any(e["command_id"]=="offline-read" for e in self.center.logs("west")["items"]))
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            list(pool.map(self.center.sync,["east","east"]))
        self.assertEqual(self.center.logs("east")["total"],len(events))

    def test_legacy_global_run_migrates_without_authorizing_extra_trades(self):
        for nid in self.nodes:
            self.enable(nid)
            self.start_ready(nid)
        self.center.decide()
        legacy = self.center.state("east")["strategy"]
        legacy.pop("node_id")
        legacy.pop("draining")
        legacy["config"]["batch_size"] = 2
        legacy["members"] += self.center.state("west")["strategy"]["members"]
        with self.center.db.tx() as db:
            db.execute("CREATE TABLE strategy(id INTEGER PRIMARY KEY,data TEXT NOT NULL)")
            db.execute("INSERT INTO strategy VALUES(1,?)",(json.dumps(legacy),))
            db.execute("DROP TABLE node_strategy")
        self.center.db.close()
        self.center = Center(self.root/"center",self.clock,self.transport)
        for nid in self.nodes:
            s = self.center.state(nid)["strategy"]
            self.assertTrue(s["enabled"] and s["draining"])
            self.assertEqual((s["config"]["batch_size"],len(s["members"])),(2,1))
            self.assertEqual(self.center.get(s["members"][0])["node_id"],nid)
            # In-flight legacy batch settled before the next observed flat snapshot.
            with self.center.db.tx() as db:
                db.execute("UPDATE commands SET status='succeeded',updated=? WHERE id=?",(self.time-1,s["members"][0]))
        self.center.decide()
        self.assertFalse(any(s["enabled"] or s["members"] for s in self.center.state()["strategies"]))
        self.center.decide()
        self.assertEqual(len(self.center.state()["commands"]),2)

    def test_http_boundary_and_real_transport(self):
        node_token, plugin_token, admin = (secrets.token_urlsafe(30) for _ in range(3))
        bridge = make_server("127.0.0.1", 0, self.nodes["east"], node_token, plugin_token)
        center = make_server("127.0.0.1", 0, self.center, admin)
        for server in (center, bridge):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        def call(server, verb, endpoint, token, body=None):
            url = "http://127.0.0.1:%d%s" % (server.server_address[1], endpoint)
            req = Request(url, method=verb, data=json.dumps(body).encode() if body is not None else None,
                          headers={"Authorization":"Bearer " + token, "Content-Type":"application/json"})
            with urlopen(req, timeout=3) as reply:
                return json.load(reply)
        for server, path, token in ((center,"/v1/state",node_token),(center,"/v1/analytics",node_token),
                                    (bridge,"/v1/status",plugin_token),(bridge,"/v1/ledger",plugin_token),(bridge,"/v1/logs",plugin_token),
                                    (bridge,"/v1/plugin/heartbeat",node_token)):
            with self.assertRaises(HTTPError) as error:
                call(server, "POST" if "plugin" in path else "GET", path, token, {})
            self.assertEqual(error.exception.code, 401)
        from fleet.center import remote
        self.center.transport = remote
        call(center, "PUT", "/v1/nodes/east", admin, {"url":"http://127.0.0.1:%d" % bridge.server_address[1],
                                                     "token":node_token,"label":"east"})
        self.center.sync("east")
        call(center, "PUT", "/v1/commands/http-read", admin, self.req())
        self.center.sync("east")
        got = call(bridge, "POST", "/v1/plugin/poll", plugin_token, self.plugin_meta)
        self.assertEqual(got["command"]["id"], "http-read")
        call(bridge, "POST", "/v1/plugin/result", plugin_token, {**self.plugin_meta,"id":"http-read","ok":True,
                                                               "result":{"message":"local fixture"}})
        self.center.sync("east")
        self.assertEqual(call(center, "GET", "/v1/commands/http-read", admin)["status"], "succeeded")
        self.assertTrue(all(a["node_id"]=="east" for a in call(center,"GET","/v1/nodes/east/accounts",admin)["accounts"]))
        self.assertEqual(call(center,"GET","/v1/commands?node_id=west",admin)["total"],0)
        self.assertEqual(call(center,"GET","/v1/state?node_id=east",admin)["strategy"]["node_id"],"east")
        self.assertTrue(call(center,"GET","/v1/nodes/east/logs",admin)["total"]>0)
        self.assertEqual(call(center,"POST","/v1/nodes/west/strategy/config",admin,{"batch_size":4})["config"]["batch_size"],4)
        self.assertEqual(call(center,"GET","/v1/analytics?node_id=east&section=order",admin)["total"],0)


if __name__ == "__main__":
    unittest.main()
