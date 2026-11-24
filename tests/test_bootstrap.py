import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from deploy.bootstrap import provision
from deploy.node_agent import Releases
from fleet.center import Center
from fleet.http import make_server


class CenterStartupTest(unittest.TestCase):
    def test_offline_cache_needs_no_pull(self):
        with patch.object(subprocess,"run",return_value=subprocess.CompletedProcess([],0)) as calls:
            provision.ensure_images()
        self.assertEqual([c.args[0] for c in calls.call_args_list],[
            ["podman","image","exists",image] for image in (provision.CENTER_IMAGE,provision.PROXY_IMAGE)])

    def test_registry_failure_identifies_image_before_starting_services(self):
        with patch.object(subprocess,"run",side_effect=[subprocess.CompletedProcess([],0),
                          subprocess.CompletedProcess([],1),subprocess.CompletedProcess([],125)]) as calls:
            with self.assertRaisesRegex(SystemExit,"Cannot pull docker.io/library/caddy:2-alpine"):
                provision.ensure_images()
        self.assertEqual(calls.call_args.args[0],["podman","pull",provision.PROXY_IMAGE])

    def test_probes_preserve_tls_error_and_reject_wrong_service(self):
        with patch.object(subprocess,"run",side_effect=[
                subprocess.CompletedProcess([],60,"","curl: (60) certificate error"),
                subprocess.CompletedProcess([],0,'{"service":"bridge"}',""),
                subprocess.CompletedProcess([],0,'{"service":"center"}',"")]):
            self.assertIn("certificate error",provision.health("https://192.0.2.1"))
            self.assertTrue(provision.health("http://127.0.0.1:8780"))
            self.assertEqual(provision.health("http://127.0.0.1:8780"),"")


@unittest.skipUnless(shutil.which("openssl"), "deployment PKI needs openssl")
class EnrollmentTest(unittest.TestCase):
    def test_two_nodes_tls_enrollment_and_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            conf = state/"openssl.cnf"
            conf.write_text("[req]\ndistinguished_name=dn\n[dn]\n")
            previous = os.environ.get("OPENSSL_CONF")
            os.environ["OPENSSL_CONF"] = str(conf)
            if previous is None:
                self.addCleanup(os.environ.pop,"OPENSSL_CONF",None)
            else:
                self.addCleanup(os.environ.__setitem__,"OPENSSL_CONF",previous)
            tools = state/"bootstrap"
            tools.mkdir()
            for filename in ("pair.js","node.ps1","Install-VestNode.ps1","node_agent.py"):
                (tools/filename).touch()
            subprocess.run(["git","init","-q",state],check=True)
            (state/"extension").mkdir()
            (state/"extension/manifest.json").write_text('{"version":"1.11.4"}')
            subprocess.run(["git","-C",state,"add","extension/manifest.json"],check=True)
            subprocess.run(["git","-C",state,"-c","user.name=test","-c","user.email=test@example.com",
                            "commit","-qm","revision"],check=True)
            center = Center(str(state/"center.db"))
            admin = secrets.token_urlsafe(32)
            server = make_server("127.0.0.1",0,center,admin)
            thread = threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            try:
                with patch.multiple(provision,STATE=state,SRC=state,BOOT=tools,
                                    LOCAL_CENTER=f"http://127.0.0.1:{server.server_port}/v1/"):
                    (state/"admin.token").write_text(admin)
                    (state/"center.json").write_text('{"ip":"192.0.2.1","port":8443}')
                    shutil.copyfile(provision.ca()/"ca.crt",state/"center-root.crt")
                    provision.enroll("east","192.0.2.2",9443)
                    provision.enroll("west","192.0.2.3",9443)
                    packages = [state/"nodes"/node/(node+".zip") for node in ("east","west")]
                    with ZipFile(packages[0]) as east, ZipFile(packages[1]) as west:
                        setup = json.loads(east.read("setup.json"))
                        self.assertEqual(setup["version"],"1.11.4")
                        self.assertNotEqual(setup["node_token"],json.loads(west.read("setup.json"))["node_token"])
                        self.assertNotEqual(east.read("server.key"),west.read("server.key"))
                        self.assertEqual(east.read("center-root.crt"),west.read("center-root.crt"))
                        for entry in east.namelist():
                            self.assertNotIn(admin.encode(),east.read(entry))
                            self.assertNotIn((state/"authority/ca.key").read_bytes(),east.read(entry))
                    provision.enroll("east","192.0.2.2",9443)
                    with ZipFile(packages[0]) as east:
                        self.assertEqual(json.loads(east.read("setup.json")),setup)
                    node_cert = state/"nodes/east/server.crt"
                    verify = ["openssl","verify","-x509_strict","-purpose","sslserver","-CAfile",state/"center-root.crt","-verify_ip"]
                    subprocess.run([*verify,"192.0.2.2",node_cert],check=True,capture_output=True)
                    self.assertNotEqual(subprocess.run([*verify,"192.0.2.3",node_cert],capture_output=True).returncode,0)
                    self.assertFalse(center.state("east")["strategy"]["enabled"])
                    with self.assertRaises(ValueError):
                        provision.enroll("east","192.0.2.4",9443)
            finally:
                server.shutdown()
                thread.join()
                server.server_close()
                center.db.close()


class SparseReleaseTest(unittest.TestCase):
    def test_unrelated_blob_is_not_fetched(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            repo=root/"source"
            subprocess.run(["git","init","-q","-b","main",repo],check=True)
            def git(*args):
                return subprocess.check_output(["git","-C",repo,*args],text=True).strip()
            git("config","uploadpack.allowFilter","true")
            for directory in ("fleet","extension"):
                (repo/directory).mkdir()
            (repo/"fleet/updates.py").touch()
            (repo/"extension/bg.js").write_text("void 0;")
            (repo/"extension/manifest.json").write_text('{"manifest_version":3,"background":{"service_worker":"bg.js"}}')
            (repo/"unrelated").write_text(secrets.token_hex(64))
            git("add",".")
            git("-c","user.name=test","-c","user.email=test@example.com","commit","-qm","release")
            state=root/"state"
            state.mkdir()
            releases=Releases(state,repo.resolve().as_uri())
            installed=releases.stage(git("rev-parse","HEAD"))
            self.assertTrue((installed/"extension/bg.js").is_file())
            objects=subprocess.check_output(["git","--git-dir",releases.cache,"rev-list","--objects",
                                             "--missing=print","refs/remotes/vest/main"],text=True)
            self.assertIn("?"+git("rev-parse","HEAD:unrelated"),objects.splitlines())
