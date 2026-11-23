"""Exercise the host update script against a temporary local Git repo and SQLite bridge."""
import contextlib
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from deploy.node_agent import Node, Releases, read_json, save


class NodeRecoveryTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        self.root = base/"node"
        self.root.mkdir()
        self.repo = base/"source"
        self.repo.mkdir()
        source = Path(__file__).resolve().parents[1]
        for folder in ("fleet","extension"):
            shutil.copytree(source/folder,self.repo/folder,ignore=shutil.ignore_patterns("__pycache__"))
        self.git("init","-qb","main")
        self.git("add","fleet","extension")
        self.git("commit","-qm","working managed bridge")
        self.good = self.git("rev-parse","HEAD")
        (self.repo/"fleet"/"__main__.py").write_text("raise SystemExit(27)\n",encoding="utf-8")
        self.git("commit","-qam","fixture fails to start")
        self.bad = self.git("rev-parse","HEAD")
        releases = Releases(self.root,str(self.repo))
        releases.stage(self.good)
        releases.extension(self.good)
        save(self.root/"active.json",{"revision":self.good,"origin":str(self.repo)})
        with socket.socket() as sock:
            sock.bind(("127.0.0.1",0))
            port = sock.getsockname()[1]
        env = {**os.environ,"VEST_NODE_ID":"fixture","VEST_NODE_TOKEN":secrets.token_hex(24),
               "VEST_PLUGIN_TOKEN":secrets.token_hex(24),"VEST_CENTER_URL":"http://127.0.0.1"}
        self.node = Node(self.root,base/"bridge.sqlite3",env,"127.0.0.1",port)
        self.addCleanup(self.node.stop)
        self.node.start(self.good)
        self.original = self.node.status()["instance_id"]

    def git(self,*args):
        return subprocess.check_output(["git","-c","user.name=Fixture","-c","user.email=fixture@localhost",
                                        "-c","commit.gpgsign=false","-c","core.autocrlf=false",*args],cwd=self.repo,text=True).strip()

    def test_broken_bridge_rolls_back_and_retries_only_the_receipt(self):
        def control(op,**data):
            return {"job":{"id":"broken","revision":self.bad}} if op=="poll" else {}
        with patch.object(self.node,"control",side_effect=control), self.assertLogs(level="ERROR"):
            self.node.step()
        self.assertEqual(self.node.status()["instance_id"],self.original)
        self.assertEqual(read_json(self.root/"active.json")["revision"],self.good)
        self.assertEqual(read_json(self.root/"extension"/"manifest.json")["version_name"],"git."+self.good)
        self.assertEqual(read_json(self.root/"transaction.json")["outcome"],"rolled_back")
        backup = self.root/"backups"/"broken.sqlite3"
        self.assertTrue(backup.is_file())
        with contextlib.closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute("SELECT instance_id FROM identity").fetchone()[0],self.original)
        with patch.object(self.node,"report",side_effect=OSError("lost ack")), self.assertRaises(OSError):
            self.node.step()
        with patch.object(self.node,"report") as receipt, patch.object(self.node.releases,"stage") as fetch:
            self.node.step()
            receipt.assert_called_once()
            fetch.assert_not_called()
        self.assertFalse(self.node.journal.exists())

    def test_interrupted_switch_restores_previous_files_and_no_git_when_idle(self):
        self.node.releases.stage(self.bad)
        self.node.gate("interrupted",True)
        self.node.releases.extension(self.bad)
        self.node.activate(self.bad)
        save(self.node.journal,{"id":"interrupted","revision":self.bad,"previous":self.good,
                                "instance_id":self.original,"phase":"switching"})
        self.node.stop()
        node = Node(self.root,self.node.db,self.node.env,self.node.bind,self.node.port)
        self.addCleanup(node.stop)
        with patch.object(node,"control",return_value={"job":None}), patch.object(node.releases,"stage") as fetch:
            node.step()
            node.step()
            self.assertFalse(node.journal.exists())
            fetch.assert_not_called()
        self.assertEqual(node.status()["instance_id"],self.original)
        self.assertEqual(read_json(self.root/"extension"/"fleet-release.json")["revision"],self.good)
        with contextlib.closing(sqlite3.connect(node.db)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM update_gate").fetchone()[0],0)

    def test_commit_outside_main_cannot_replace_installed_version(self):
        self.git("switch","-qc","unpublished")
        self.git("commit","-q","--allow-empty","-m","not on main")
        outside = self.git("rev-parse","HEAD")
        with self.assertRaisesRegex(RuntimeError,"main"):
            self.node.releases.stage(outside)
        self.assertEqual(self.node.status()["release"],self.good)
        self.assertFalse((self.root/"releases"/outside).exists())
