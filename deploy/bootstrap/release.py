"""Resolve, verify and display a center-issued Git release."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def git(repo, *args):
    return subprocess.check_output(["git","-C",str(repo),*args],text=True).strip()


def select(repo, descriptor, revision=None):
    bundle = os.environ.get("VEST_RELEASE_BUNDLE")
    main_ref = "refs/vest-fleet/bundle-main" if bundle else "refs/remotes/origin/main"
    git(repo,"fetch","--no-tags",bundle or "origin","+refs/heads/main:"+main_ref)
    pin = json.loads(descriptor.read_text()) if descriptor.is_file() else None
    target = revision or (pin["revision"] if pin else git(repo,"rev-parse",main_ref))
    if not re.fullmatch("[0-9a-f]{40}",target):
        raise ValueError("Expected a full lowercase Git SHA")
    git(repo,"merge-base","--is-ancestor",target,main_ref)
    version = json.loads(git(repo,"show",target+":extension/manifest.json"))["version"]
    if pin and target == pin["revision"] and version != pin["version"]:
        raise ValueError("Release descriptor does not match the published extension manifest")
    return target,version


if __name__ == "__main__":
    repo = Path(sys.argv[1])
    target,version = select(repo,Path(__file__).with_name("release.json"))
    if sys.argv[2] == "existing" and git(repo,"rev-parse","HEAD") != target:
        sys.exit(f"Already installed at another revision. Use update_center.py for {version} ({target}).")
    git(repo,"checkout","--detach",target)
    print(f"Selected Vest Fleet {version} ({target})")
