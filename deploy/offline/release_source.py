"""Publish the exact main ref from a local bundle to the center's HTTPS Git service."""
import base64
import json
import subprocess


def bundle_revision(bundle, pin):
    head = subprocess.check_output(["git", "bundle", "list-heads", bundle, "refs/heads/main"], text=True).split()
    if head != [pin["revision"], "refs/heads/main"]:
        raise ValueError("Git bundle and release descriptor differ")
    return head[0]


def publish(mirror, bundle, revision):
    if not mirror.exists():
        subprocess.run(["git", "init", "--bare", mirror], check=True)
    def git(*args):
        return subprocess.check_output(["git", "-C", mirror, *args], text=True).strip()
    git("symbolic-ref", "HEAD", "refs/heads/main")
    git("config", "uploadpack.allowFilter", "true")
    git("config", "uploadpack.allowReachableSHA1InWant", "true")
    git("-c", "fetch.unpackLimit=1", "fetch", "--no-tags", str(bundle), "refs/heads/main:refs/heads/main")
    if git("rev-parse", "refs/heads/main") != revision:
        raise ValueError("Offline source head mismatch")
    git("update-server-info")


def verify_https(state, revision):
    config = json.loads((state/"center.json").read_text())
    ip, port = config["ip"], config["port"]
    reader = (state/"offline-reader.token").read_text().strip()
    auth = base64.b64encode(("release:"+reader).encode()).decode()
    response = subprocess.run(["curl", "--noproxy", "*", "-fsS", "--max-time", "8",
                               "--cacert", state/"center-root.crt", "--connect-to", f"{ip}:{port}:127.0.0.1:{port}",
                               "--config", "-", f"https://{ip}:{port}/offline.git/info/refs"],
                              input=f'header = "Authorization: Basic {auth}"\n', text=True, capture_output=True, check=True)
    if revision+"\trefs/heads/main" not in response.stdout.splitlines():
        raise ValueError("HTTPS repository did not report the target revision")
