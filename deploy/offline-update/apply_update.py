"""Apply an application update under the same lock used by both Linux installers."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE/"bootstrap"))
import provision
import release_source
import update_center
from release import git
from node_agent import ID, checked


def apply(nodes, request_id, wait):
    state, repo = provision.STATE, provision.SRC
    bundle, descriptor = HERE/"release.bundle", HERE/"release.json"
    pin = json.loads(descriptor.read_text())
    target = release_source.bundle_revision(bundle, pin)
    os.environ.update(VEST_RELEASE_BUNDLE=str(bundle), GIT_ALLOW_PROTOCOL="file", GIT_TERMINAL_PROMPT="0")
    with (state/"bootstrap.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (state/"center-update.json").exists():
            return update_center.update(repo, state, descriptor)
        git(repo, "bundle", "verify", str(bundle))
        # Fill missing blobs even if an older installation used a partial clone.
        git(repo, "bundle", "unbundle", str(bundle))
        previous = git(repo, "rev-parse", "HEAD")
        git(repo, "merge-base", "--is-ancestor", previous, target)
        mirror = state/"offline-git"
        offline = (state/"offline.json").is_file()
        if offline != mirror.is_dir() or offline and not (state/"offline-reader.token").is_file():
            raise ValueError("Incomplete center HTTPS source configuration")
        if offline:
            old_source = git(mirror, "rev-parse", "--verify", "refs/heads/main")
            git(repo, "merge-base", "--is-ancestor", old_source, target)
        running = subprocess.run(["systemctl", "is-active", "--quiet", update_center.SERVICE]).returncode == 0
        if nodes and not running:
            raise ValueError("Start the center before dispatching node updates")
        rc = update_center.update(repo, state, descriptor)
        if rc:
            return rc
        if offline:
            release_source.publish(mirror, bundle, target)
            if running:
                release_source.verify_https(state, target)
            print("Center HTTPS release source published:", target, flush=True)
        else:
            print("Legacy installation: center updated from the local bundle. Nodes use their configured Git source.", flush=True)
        if not nodes:
            return 0
        args = [sys.executable, "-B", str(HERE/"bootstrap/dispatch_update.py"), "--revision", target,
                "--wait", str(wait), "--request-id", request_id or "offline-"+target]
        for node in dict.fromkeys(nodes):
            args.extend(["--node", node])
        env = dict(os.environ, VEST_ADMIN_TOKEN=(state/"admin.token").read_text().strip(),
                   VEST_CENTER_URL="http://127.0.0.1:8780", no_proxy="127.0.0.1", NO_PROXY="127.0.0.1")
        return subprocess.run(args, env=env).returncode


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--node", action="append", default=[], help="repeat for each node to update")
    cli.add_argument("--request-id", help="override the stable per-release request ID")
    cli.add_argument("--wait", type=int, default=180, help="seconds to await plugin confirmation; 0 submits only")
    args = cli.parse_args()
    if args.wait < 0:
        cli.error("--wait must be nonnegative")
    for key in args.node + ([args.request_id] if args.request_id is not None else []):
        checked(ID, key)
    sys.exit(apply(args.node, args.request_id, args.wait))
