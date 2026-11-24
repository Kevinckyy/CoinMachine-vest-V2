"""Upgrade an IP-deployed Linux center. The release package pins the default SHA."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time

if __package__:
    from . import provision
    from .release import git, select
else:
    import provision
    from release import git, select

SERVICE = "vest-fleet-center"
DEPLOYED_PATHS = ("/fleet/", "/web/", "/extension/manifest.json", "/extension/archive.js",
                  "/deploy/bootstrap/", "/deploy/node_agent.py", "/deploy/dispatch_update.py",
                  "/deploy/Install-VestNode.ps1")


def systemctl(*args):
    subprocess.run(["systemctl",*args,SERVICE],check=True)


def backup(source, dest):
    with closing(sqlite3.connect(source.resolve().as_uri()+"?mode=ro",uri=True)) as db, closing(sqlite3.connect(dest)) as out:
        db.backup(out)


def healthy(state, version):
    config = json.loads((state/"center.json").read_text())
    url = f"https://{config['ip']}:{config['port']}"
    options = ["--cacert",state/"center-root.crt","--connect-to",
               f"{config['ip']}:{config['port']}:127.0.0.1:{config['port']}"]
    token = (state/"admin.token").read_text().strip()
    error = ""
    for _ in range(25):
        error = provision.health(url,*options)
        if not error:
            try:
                actual = provision.api(token,"state")["plugin_version"]
                if actual == version:
                    return
                error = f"center reports {actual}, expected {version}"
            except (OSError,ValueError,KeyError) as exc:
                error = str(exc)
        time.sleep(1)
    raise RuntimeError("Center version/HTTPS check failed: "+error)


def restore(repo, state, journal, change):
    previous = change["previous"]
    print("Restoring previous center code:", previous,flush=True)
    systemctl("stop")
    git(repo,"checkout","--detach",previous)
    if change["running"]:
        systemctl("start")
        healthy(state,json.loads(git(repo,"show",previous+":extension/manifest.json"))["version"])
    journal.unlink()


def update(repo, state, descriptor, revision=None):
    journal = state/"center-update.json"
    if journal.is_file():
        restore(repo,state,journal,json.loads(journal.read_text()))
        print("Interrupted update recovered. Run the update again to apply the target.")
        return 2
    if git(repo,"status","--porcelain"):
        raise ValueError("The installed source checkout has local changes. Preserve them before updating.")
    previous = git(repo,"rev-parse","HEAD")
    target,version = select(repo,descriptor,revision)
    print(f"Target {version} ({target})",flush=True)
    if git(repo,"config","--type=bool","--default=false","--get","core.sparseCheckout") == "true":
        # Older center installs included only the extension manifest in the web server's mount.
        git(repo,"sparse-checkout","add",*DEPLOYED_PATHS)
    running = subprocess.run(["systemctl","is-active","--quiet",SERVICE]).returncode == 0
    if target == previous:
        if running:
            healthy(state,version)
        print("Already at the target revision." if running else "Target already installed; center is stopped.")
        return 0

    # Prefetch deployed trees before stopping the existing center, including the sparse install files.
    with tempfile.TemporaryDirectory(dir=state) as tmp:
        stage = Path(tmp)/"checkout"
        git(repo,"worktree","add","--detach","--no-checkout",str(stage),target)
        try:
            git(stage,"sparse-checkout","set","--no-cone",*DEPLOYED_PATHS)
            git(stage,"checkout","--detach",target)
            if json.loads((stage/"extension/manifest.json").read_text())["version"] != version:
                raise ValueError("Staged plugin version mismatch")
        finally:
            git(repo,"worktree","remove",str(stage))
    change = {"previous":previous,"target":target,"running":running}
    backups = state/"backups"
    backups.mkdir(exist_ok=True)
    provision.write(journal,json.dumps(change))
    try:
        systemctl("stop")
        source = state/"data/center.sqlite3"
        if source.is_file():
            fd,name = tempfile.mkstemp(dir=backups,prefix="center-"+previous[:12]+"-",suffix=".sqlite3")
            os.close(fd)
            backup(source,Path(name))
            print("SQLite backup:",name,flush=True)
        git(repo,"checkout","--detach",target)
        if running:
            systemctl("start")
            healthy(state,version)
        journal.unlink()
    except (Exception,KeyboardInterrupt):
        restore(repo,state,journal,change)
        raise
    print(f"Center {'verified' if running else 'updated while stopped'}: {version} ({target})")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision",help="published main commit; defaults to the release in this package")
    args = parser.parse_args()
    import fcntl
    if os.geteuid() != 0:
        parser.error("run with sudo")
    os.umask(0o077)
    with (provision.STATE/"bootstrap.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        return update(provision.SRC,provision.STATE,Path(__file__).with_name("release.json"),args.revision)


if __name__ == "__main__":
    sys.exit(main())
