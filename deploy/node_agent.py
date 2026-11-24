"""Host supervisor for Vest nodes. The center chooses each exact Git revision."""
import argparse
import contextlib
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
from logging.handlers import RotatingFileHandler
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

HTTPS_REPO = "https://github.com/Kevinckyy/CoinMachine-vest-V2.git"
SSH_REPO = "git@github.com:Kevinckyy/CoinMachine-vest-V2.git"
SHA = re.compile("[0-9a-f]{40}")
ID = re.compile("[A-Za-z0-9][A-Za-z0-9_.-]{0,79}")
HIDDEN = getattr(subprocess,"CREATE_NO_WINDOW",0)


def checked(pattern, value):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError("Invalid deployment identifier or commit")
    return value


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def sync_dir(path):
    if os.name == "posix":
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def save(path, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as fp:
        tmp = Path(fp.name)
        try:
            json.dump(value, fp)
            fp.flush()
            os.fsync(fp.fileno())
        except BaseException:
            fp.close()
            tmp.unlink(missing_ok=True)
            raise
    try:
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        tmp.unlink(missing_ok=True)


@contextlib.contextmanager
def ownership(root):
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (root/"agent.lock").open("a+b") as fp:
        if os.name == "nt":
            import msvcrt
            if fp.tell() == 0:
                fp.write(b"0")
                fp.flush()
            fp.seek(0)
            msvcrt.locking(fp.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


class Releases:
    def __init__(self, root, origin):
        self.root, self.origin = root, origin
        self.cache = root/"objects.git"
        self.releases = root/"releases"
        self.releases.mkdir(exist_ok=True)

    def git(self, *args):
        env = {**os.environ,"GIT_TERMINAL_PROMPT":"0","GCM_INTERACTIVE":"never"}
        env.setdefault("GIT_SSH_COMMAND","ssh -o BatchMode=yes -o StrictHostKeyChecking=yes")
        subprocess.run(["git","--git-dir",str(self.cache),*args],env=env,check=True,timeout=150,
                       stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,creationflags=HIDDEN)

    def stage(self, rev):
        checked(SHA,rev)
        dest = self.releases/rev
        if not self.cache.exists():
            subprocess.run(["git","init","--bare","--quiet",str(self.cache)],check=True,timeout=20,creationflags=HIDDEN)
        try:
            # A named promisor remote lets git archive lazily fetch blobs for fleet/ and extension/.
            self.git("config","remote.vest.url",self.origin)
            self.git("config","remote.vest.promisor","true")
            self.git("config","remote.vest.partialclonefilter","blob:none")
            self.git("fetch","--filter=blob:none","--no-tags","vest","+refs/heads/main:refs/remotes/vest/main")
        except subprocess.SubprocessError as err:
            raise RuntimeError("无法从指定仓库读取 main，请检查网络和节点的 Git 读取权限") from err
        try:
            self.git("merge-base","--is-ancestor",rev,"refs/remotes/vest/main")
        except subprocess.SubprocessError as err:
            raise RuntimeError("指定提交不属于仓库 main 的已发布历史") from err
        if dest.is_dir():
            return dest
        with tempfile.TemporaryDirectory(dir=self.releases) as temp:
            temp = Path(temp)
            tree = temp/"tree"
            tree.mkdir()
            archive = temp/"release.tar"
            # Archiving the commit with a pathspec still prefetches unrelated blobs on some Git versions.
            for directory in ("fleet","extension"):
                self.git("archive","--format=tar","--output",str(archive),"--prefix="+directory+"/",rev+":"+directory)
                with tarfile.open(archive,"r:") as tar:
                    for item in tar:
                        parts = PurePosixPath(item.name).parts
                        if (not parts or parts[0] != directory or
                                any(not re.fullmatch(r"[\w.-]+",p) or p in (".","..") for p in parts)):
                            raise ValueError("Invalid release path")
                        path = tree.joinpath(*parts)
                        if item.isdir():
                            path.mkdir(exist_ok=True,parents=True)
                        elif item.isfile() and 0 <= item.size <= 32_000_000:
                            path.parent.mkdir(exist_ok=True,parents=True)
                            with tar.extractfile(item) as src, path.open("xb") as dst:
                                shutil.copyfileobj(src,dst)
                        else:
                            raise ValueError("Unsupported release entry")
            manifest = tree/"extension"/"manifest.json"
            data = read_json(manifest)
            if not (tree/"fleet"/"updates.py").is_file() or not data or data.get("manifest_version") != 3:
                raise ValueError("Commit does not support managed node updates")
            scripts = [data.get("background",{}).get("service_worker","")]
            scripts.extend(s for block in data.get("content_scripts",[]) for s in block.get("js",[]))
            if any(not isinstance(s,str) or not re.fullmatch(r"[\w./-]+\.js",s) or
                   ".." in s.split("/") or s.startswith("/") or not (manifest.parent/s).is_file() for s in scripts):
                raise ValueError("Release is missing a declared extension script")
            data["version_name"] = "git."+rev
            save(manifest,data)
            marker = manifest.with_name("fleet-release.json")
            save(marker,{"revision":rev})
            manifest.chmod(0o644)
            marker.chmod(0o644)
            os.replace(tree,dest)
            sync_dir(self.releases)
        return dest

    def extension(self, rev):
        # Keep the browser's literal unpacked path stable. The marker is published with the manifest.
        tree = self.releases/checked(SHA,rev)/"extension"
        dest = self.root/"extension"
        with tempfile.TemporaryDirectory(dir=self.root) as temp:
            incoming, previous = Path(temp)/"new", Path(temp)/"old"
            shutil.copytree(tree,incoming)
            if dest.exists():
                os.replace(dest,previous)
            try:
                os.replace(incoming,dest)
                sync_dir(self.root)
            except BaseException:
                if previous.exists() and not dest.exists():
                    os.replace(previous,dest)
                raise


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args):
        return None


def http(url, token, data=None, method=None):
    req = Request(url, data=json.dumps(data).encode() if data is not None else None,
                  headers={"Content-Type":"application/json","Authorization":"Bearer "+token},method=method)
    with build_opener(NoRedirect).open(req,timeout=6) as res:
        return json.loads(res.read(8_000_001))


def center_origin(value):
    url = urlsplit(value)
    if (not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("","/") or
            not (url.scheme == "https" or url.scheme == "http" and url.hostname in ("127.0.0.1","localhost","::1"))):
        raise ValueError("Expected HTTPS center origin or loopback HTTP")
    return value.rstrip("/")


def load_env(file):
    env = dict(os.environ)
    if file:
        for line in Path(file).read_text(encoding="utf-8-sig").splitlines():
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            key, sep, value = line.partition("=")
            if not sep or not re.fullmatch(r"[A-Z][A-Z0-9_]*",key.strip()):
                raise ValueError("Expected KEY=value in node environment file")
            env[key.strip()] = value.strip()
    for key in ("VEST_NODE_ID","VEST_NODE_TOKEN","VEST_PLUGIN_TOKEN","VEST_CENTER_URL"):
        if not env.get(key):
            raise ValueError("Missing "+key)
    checked(ID,env["VEST_NODE_ID"])
    env["VEST_CENTER_URL"] = center_origin(env["VEST_CENTER_URL"])
    return env


class Node:
    def __init__(self, root, database, env, bind, port):
        self.root, self.db, self.env = root,database,env
        self.bind, self.port = bind,port
        config = read_json(root/"active.json")
        if not config:
            raise ValueError("Run init for this node state directory first")
        self.releases = Releases(root,config["origin"])
        self.current = checked(SHA,config["revision"])
        self.journal = root/"transaction.json"
        self.child = None
        self.instance = None
        self.center = env["VEST_CENTER_URL"].rstrip("/")+"/v1/node-agent/"+env["VEST_NODE_ID"]+"/"

    def control(self, op, **data):
        return http(self.center+op,self.env["VEST_NODE_TOKEN"],{"instance_id":self.instance,"actual":self.current,**data})

    def status(self):
        return http(f"http://127.0.0.1:{self.port}/v1/status",self.env["VEST_NODE_TOKEN"])

    def start(self, rev):
        launch_id = uuid.uuid4().hex
        env = {**self.env,"VEST_FLEET_RELEASE":rev,"VEST_FLEET_LAUNCH_ID":launch_id,"PYTHONNOUSERSITE":"1",
               "PYTHONIOENCODING":"utf-8"}
        env.pop("PYTHONPATH",None)
        python = Path(sys.executable)
        if python.name.lower() == "pythonw.exe":
            python = python.with_name("python.exe")
        self.child = subprocess.Popen([str(python),"-B","-m","fleet","bridge","--parent-pipe","--host",self.bind,
                                       "--port",str(self.port),"--db",str(self.db)],
                                      cwd=self.releases.releases/checked(SHA,rev),env=env,stdin=subprocess.PIPE,creationflags=HIDDEN)
        deadline = time.monotonic()+25
        while self.child.poll() is None and time.monotonic() < deadline:
            try:
                status = self.status()
            except (OSError,ValueError):
                time.sleep(.2)
                continue
            if (status.get("launch_id") == launch_id and status["node_id"] == self.env["VEST_NODE_ID"] and status.get("release") == rev
                    and (not self.instance or self.instance == status["instance_id"])):
                self.instance = status["instance_id"]
                return
            time.sleep(.2)
        self.stop()
        raise RuntimeError("Managed bridge did not pass its identity and release health check")

    def stop(self):
        if self.child is not None:
            self.child.stdin.close()
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.child.terminate()
                self.child.wait(timeout=10)
            self.child = None

    def gate(self, job, hold):
        with contextlib.closing(sqlite3.connect(self.db,timeout=10)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if hold:
                db.execute("INSERT OR IGNORE INTO update_gate VALUES(1,?)",(job,))
                if db.execute("SELECT owner FROM update_gate").fetchone()[0] != job:
                    raise RuntimeError("Another update owns the bridge maintenance gate")
            else:
                db.execute("DELETE FROM update_gate WHERE owner=?",(job,))
            return db.execute("SELECT COUNT(*) FROM commands WHERE status IN ('queued','running')").fetchone()[0]

    def backup(self, key):
        folder = self.root/"backups"
        folder.mkdir(exist_ok=True,mode=0o700)
        with contextlib.closing(sqlite3.connect(self.db)) as src, contextlib.closing(sqlite3.connect(folder/(checked(ID,key)+".sqlite3"))) as dst:
            src.backup(dst)

    def activate(self, rev):
        save(self.root/"active.json",{"revision":rev,"origin":self.releases.origin})
        self.current = rev

    def report(self, job, state, detail):
        return self.control("report",id=job["id"],revision=job["revision"],state=state,
                            expected=job.get("expected",[]),detail=detail[:500])

    def progress(self, job, state, detail):
        try:
            self.report(job,state,detail)
        except (OSError,ValueError):
            logging.warning("Progress receipt deferred for %s",job["id"])

    def done(self, job, state, detail):
        job.update(phase="done",outcome=state,detail=detail[:500])
        save(self.journal,job)
        self.gate(job["id"],False)

    def rollback(self, job):
        prior = job["previous"]
        try:
            self.stop()
            self.releases.extension(prior)
            self.start(prior)
            self.activate(prior)
        except (OSError, ValueError, RuntimeError, sqlite3.Error, subprocess.SubprocessError):
            self.progress(job,"applying","回滚尚未完成，节点将重试。请检查节点服务日志及原数据库。")
            raise
        self.done(job,"rolled_back","已恢复上一版本 · "+job.get("error","更新进程中断"))

    def apply(self, job):
        key, target = job["id"], job["revision"]
        try:
            self.progress(job,"preparing","正在准备指定 Git 提交")
            self.releases.stage(target)
            deadline = time.monotonic()+225
            while self.gate(key,True):
                self.status()  # The bridge owns command expiry and financial receipts.
                if time.monotonic() >= deadline:
                    raise RuntimeError("Timed out draining browser commands")
                time.sleep(1)
            now = time.time()
            job["expected"] = [w["worker_id"] for w in self.status()["workers"] if now-w["last_seen"] < 25]
            job["phase"] = "switching"
            save(self.journal,job)
            self.progress(job,"applying","已排空在途指令，正在切换节点桥和插件")
            if target != self.current:
                self.stop()
                self.backup(key)
                self.start(target)
            self.releases.extension(target)
            self.activate(target)
            self.done(job,"installed","节点桥健康检查通过，插件已发布到固定目录")
        except (OSError, ValueError, RuntimeError, KeyError, sqlite3.Error, tarfile.TarError, subprocess.SubprocessError) as err:
            # Only locally compiled diagnostics go back to the center. Subprocess arguments can contain local paths.
            message = type(err).__name__ + (" · "+str(err)[:300] if isinstance(err,(ValueError,RuntimeError)) else "")
            logging.exception("Update %s failed",key)
            if job["phase"] == "switching":
                job["error"] = message
                save(self.journal,job)
                self.rollback(job)
            elif job["phase"] != "done":
                self.done(job,"failed",message)

    def step(self):
        job = read_json(self.journal)
        if job and not self.instance:
            self.instance = job.get("instance_id")
        if job and job["phase"] == "switching":
            # A crash anywhere around activation rolls code back against the original, live ledger.
            self.rollback(job)
        if self.child is None or self.child.poll() is not None:
            self.stop()
            self.start(self.current)
        if job and job["phase"] == "done":
            self.gate(job["id"],False)
            self.report(job,job["outcome"],job["detail"])
            self.journal.unlink()
            sync_dir(self.root)
            return
        if not job:
            incoming = self.control("poll").get("job")
            if not incoming:
                return
            job = {"id":checked(ID,incoming["id"]),"revision":checked(SHA,incoming["revision"]),
                   "previous":self.current,"instance_id":self.instance,"phase":"preparing"}
            save(self.journal,job)
        self.apply(job)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="op",required=True)
    init = sub.add_parser("init",help="bootstrap one locally authorized revision")
    init.add_argument("--revision",required=True)
    init.add_argument("--ssh",action="store_true",help="read GitHub using this host's deploy key")
    run = sub.add_parser("run",help="run the bridge and receive addressed update jobs from the center")
    run.add_argument("--db",required=True,type=Path)
    run.add_argument("--env-file",type=Path)
    run.add_argument("--log-file",type=Path,help="rotate the host agent log at 1 MiB")
    run.add_argument("--host",choices=["127.0.0.1","0.0.0.0"],default="127.0.0.1")
    run.add_argument("--port",type=int,default=8877)
    for p in (init,run):
        p.add_argument("--state",required=True,type=Path)
    args = parser.parse_args()
    logfile = getattr(args,"log_file",None)
    handlers = [RotatingFileHandler(logfile,maxBytes=1048576,backupCount=3,encoding="utf-8")] if logfile else None
    logging.basicConfig(level=logging.INFO,format="%(asctime)s %(levelname)s %(message)s",handlers=handlers)
    root = args.state.resolve()
    with ownership(root):
        if args.op == "init":
            rev = checked(SHA,args.revision)
            active = read_json(root/"active.json")
            if active:
                if active["revision"] != rev:
                    parser.error("Existing installation: send a node update from the center")
                return
            store = Releases(root,SSH_REPO if args.ssh else HTTPS_REPO)
            store.stage(rev)
            store.extension(rev)
            save(root/"active.json",{"revision":rev,"origin":store.origin})
            return
        node = Node(root,args.db.resolve(),load_env(args.env_file),args.host,args.port)
        def shutdown(*_):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM,shutdown)
        try:
            while True:
                try:
                    node.step()
                except (OSError,ValueError,RuntimeError,KeyError,sqlite3.Error,subprocess.SubprocessError) as err:
                    logging.warning("Node update service: %s",err)
                time.sleep(3)
        except KeyboardInterrupt:
            pass
        finally:
            node.stop()


if __name__ == "__main__":
    main()
