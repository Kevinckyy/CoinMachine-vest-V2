import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from deploy.bootstrap import update_center as updater


class CenterUpdateTest(unittest.TestCase):
    def test_pinned_upgrade_and_failed_start_preserve_ledger(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            source=root/"remote"
            checkout=root/"src"
            subprocess.run(["git","init","-q","-b","main",source],check=True)
            (source/"extension").mkdir()
            def release(version):
                (source/"extension/manifest.json").write_text(json.dumps({"version":version}))
                updater.git(source,"add",".")
                updater.git(source,"-c","user.name=Fixture","-c","user.email=test@example.com","commit","-qm",version)
                return updater.git(source,"rev-parse","HEAD")
            old=release("1.8.0")
            (source/"extension/archive.js").write_text("/* shared with the center UI */")
            target=release("1.11.4")
            subprocess.run(["git","clone","-q",str(source),checkout],check=True)
            updater.git(checkout,"sparse-checkout","set","--no-cone","/extension/manifest.json")
            updater.git(checkout,"checkout","--detach",old)
            pin=root/"release.json"
            pin.write_text(json.dumps({"version":"1.11.4","revision":target}))
            (root/"data").mkdir()
            database=root/"data/center.sqlite3"
            def sql(statement):
                db=sqlite3.connect(database)
                try:
                    rows=db.execute(statement).fetchall()
                    db.commit()
                    return rows
                finally:
                    db.close()
            sql("create table ledger (id integer primary key)")
            sql("insert into ledger values (1)")
            real_run=subprocess.run
            def service_status(cmd,**kwargs):
                if cmd[0]=="systemctl":
                    return subprocess.CompletedProcess(cmd,0)
                return real_run(cmd,**kwargs)
            def fail_target(state,version):
                if version=="1.11.4":
                    sql("insert into ledger values (2)")
                    raise RuntimeError("failed start")
            with patch.object(subprocess,"run",side_effect=service_status):
                with patch.object(updater,"healthy",side_effect=fail_target):
                    with self.assertRaisesRegex(RuntimeError,"failed start"):
                        updater.update(checkout,root,pin)
                self.assertEqual(updater.git(checkout,"rev-parse","HEAD"),old)
                self.assertEqual(sql("select id from ledger order by id"),[(1,),(2,)])
                self.assertFalse((root/"center-update.json").exists())
                backup,=list((root/"backups").glob("*.sqlite3"))
                db=sqlite3.connect(backup)
                self.assertEqual(db.execute("select id from ledger").fetchall(),[(1,)])
                db.close()
                with patch.object(updater,"healthy") as check:
                    self.assertEqual(updater.update(checkout,root,pin),0)
                    self.assertEqual(updater.git(checkout,"rev-parse","HEAD"),target)
                    self.assertTrue((checkout/"extension/archive.js").is_file())
                    self.assertEqual(updater.update(checkout,root,pin),0)
                    self.assertEqual(check.call_args.args,(root,"1.11.4"))
                pin.write_text(json.dumps({"version":"1.8.0","revision":target}))
                with self.assertRaisesRegex(ValueError,"descriptor"):
                    updater.update(checkout,root,pin)
