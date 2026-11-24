"""Linux half of the IP deployment. Called under the installer's exclusive lock."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen
from zipfile import ZipFile, ZIP_DEFLATED

STATE = Path("/var/lib/vest-fleet")
SRC = Path("/opt/vest-fleet/src")
BOOT = Path(__file__).resolve().parent
LOCAL_CENTER = "http://127.0.0.1:8780/v1/"
CENTER_IMAGE = "docker.io/library/python:3.12-slim"
PROXY_IMAGE = "docker.io/library/caddy:2-alpine"


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, text=True).stdout.strip()


def write(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as tmp:
        tmp.write(value)
    os.replace(tmp.name, path)


def credential(path):
    if not path.exists():
        write(path, secrets.token_urlsafe(32))
    return path.read_text().strip()


def validate_endpoint(ip, port):
    address = ipaddress.IPv4Address(ip)
    if address.is_loopback or address.is_multicast or address.is_unspecified or not 1 <= port <= 65535:
        raise ValueError("Specify a reachable unicast IPv4 address and TCP port 1..65535")


def ca():
    directory = STATE / "authority"
    if not directory.exists():
        with tempfile.TemporaryDirectory(dir=STATE) as temp:
            staged = Path(temp) / "ca"
            staged.mkdir()
            run("openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650",
                "-subj", "/CN=Vest Fleet deployment CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash",
                "-keyout", staged/"ca.key", "-out", staged/"ca.crt")
            staged.rename(directory)
    return directory


def leaf(directory, ip, authority):
    directory.mkdir(exist_ok=True)
    cert, key = directory/"server.crt", directory/"server.key"
    if cert.exists() and key.exists():
        if (subprocess.run(["openssl","x509","-in",cert,"-checkend",str(30*86400),"-noout"],
                           stdout=subprocess.DEVNULL).returncode == 0 and
                subprocess.run(["openssl","verify","-CAfile",authority/"ca.crt","-verify_ip",ip,cert],
                               stdout=subprocess.DEVNULL).returncode == 0):
            return False
    # Keep the stable private key when renewing so an interruption leaves a matching pair.
    with tempfile.TemporaryDirectory(dir=directory) as temp:
        tmp = Path(temp)
        if not key.exists():
            run("openssl","genpkey","-algorithm","EC","-pkeyopt","ec_paramgen_curve:P-256","-out",tmp/"key")
            os.replace(tmp/"key",key)
        run("openssl","req","-new","-key",key,"-subj",f"/CN={ip}","-out",tmp/"request")
        (tmp/"extensions").write_text(f"subjectAltName=IP:{ip}\nbasicConstraints=critical,CA:FALSE\n"
                                      "keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n"
                                      "authorityKeyIdentifier=keyid:always\nsubjectKeyIdentifier=hash\n")
        run("openssl","x509","-req","-in",tmp/"request","-CA",authority/"ca.crt","-CAkey",authority/"ca.key",
            "-set_serial","0x"+secrets.token_hex(16),"-days","397","-sha256","-extfile",tmp/"extensions","-out",tmp/"cert")
        os.replace(tmp/"cert",cert)
    return True


def unit(name, arguments):
    exe = shutil.which("podman")
    path = Path("/etc/systemd/system")/(name+".service")
    data = (f"[Unit]\nDescription={name}\nAfter=network-online.target\nWants=network-online.target\n"
            f"[Service]\nExecStart={exe} run --rm --replace --name {name} --network host {arguments}\n"
            f"ExecStop={exe} stop -t 15 {name}\nRestart=always\nRestartSec=4\nTimeoutStartSec=0\n"
            "[Install]\nWantedBy=multi-user.target\n")
    changed = not path.exists() or path.read_text() != data
    if changed:
        write(path, data)
    return changed


def ensure_images():
    for image in (CENTER_IMAGE,PROXY_IMAGE):
        exists = subprocess.run(["podman","image","exists",image])
        if exists.returncode == 1:
            print(f"Preparing {image}",flush=True)
            if subprocess.run(["podman","pull",image]).returncode:
                raise SystemExit(f"Cannot pull {image}. Import the matching Linux offline image bundle and rerun the installer.")
        elif exists.returncode:
            raise SystemExit(f"Cannot read the local Podman image store (exit {exists.returncode}): {image}")


def health(url, *options):
    result = subprocess.run(["curl","--noproxy","*","-fsS","--max-time","3",*options,url+"/healthz"],
                            capture_output=True,text=True)
    if result.returncode:
        return result.stderr.strip() or f"curl exit {result.returncode}"
    try:
        if json.loads(result.stdout).get("service") == "center":
            return ""
    except (ValueError,AttributeError):
        pass
    return "expected a center health response"


def install(ip, port, *, resume=False):
    validate_endpoint(ip,port)
    if port == 8780:
        raise ValueError("8780 is the center's internal loopback port")
    config = STATE/"center.json"
    endpoint = {"ip":ip,"port":port}
    if not config.exists():
        for number in (8780,port):
            with socket.socket() as check:
                check.bind(("0.0.0.0",number))
    if config.exists() and json.loads(config.read_text()) != endpoint:
        raise ValueError("Existing center address differs; retain its original IP and port")
    write(config,json.dumps(endpoint))
    ensure_images()
    authority = ca()
    root = STATE/"center-root.crt"
    shutil.copyfile(authority/"ca.crt",root)
    renewed = leaf(STATE/"center-tls",ip,authority)
    admin = credential(STATE/"admin.token")
    write(STATE/"center.env","VEST_ADMIN_TOKEN="+admin+"\nSSL_CERT_FILE=/trust/center-root.crt\n")
    (STATE/"data").mkdir(exist_ok=True)
    write(STATE/"Caddyfile",f"""{{
    admin off
    auto_https disable_redirects
    default_sni {ip}
}}
https://{ip}:{port} {{
    tls /tls/server.crt /tls/server.key
    reverse_proxy 127.0.0.1:8780
}}
""")
    sources = " ".join(f"-v {SRC/name}:/app/{name}:ro,z" for name in ("fleet","web","extension"))
    changed = unit("vest-fleet-center",
        f"--env-file {STATE}/center.env {sources} -v {STATE}/data:/data:Z "
        f"-v {root}:/trust/center-root.crt:ro,z -w /app {CENTER_IMAGE} "
        "python -B -m fleet center --db /data/center.sqlite3")
    proxy = unit("vest-fleet-center-https",
        f"-v {STATE}/Caddyfile:/etc/caddy/Caddyfile:ro,Z -v {STATE}/center-tls:/tls:ro,Z "
        f"{PROXY_IMAGE}")
    url = f"https://{ip}:{port}"
    tls_options = ["--cacert",root,"--connect-to",f"{ip}:{port}:127.0.0.1:{port}"]
    run("systemctl","daemon-reload")
    for name, restart in (("vest-fleet-center",changed),("vest-fleet-center-https",proxy or renewed)):
        active = subprocess.run(["systemctl","is-active","--quiet",name]).returncode == 0
        if active and resume and not restart:
            # An old Podman process may still be waiting for a registry request to time out.
            restart = bool(health("http://127.0.0.1:8780") if name == "vest-fleet-center" else health(url,*tls_options))
        run("systemctl","enable","--now",name)
        if restart and active:
            run("systemctl","restart",name)
    for _ in range(120):
        problem = health(url,*tls_options)
        if not problem:
            print(f"Center ready: {url}\nAdmin token: {STATE}/admin.token\nBrowser trust certificate: {root}")
            return
        time.sleep(1)
    backend = health("http://127.0.0.1:8780") or "OK"
    raise SystemExit(f"Center readiness failed. Local HTTP: {backend}. HTTPS via loopback: {problem}.\n"
                     "Inspect: journalctl -b -u vest-fleet-center -u vest-fleet-center-https -n 50 --no-pager")


def api(token, path, data=None):
    req = Request(LOCAL_CENTER+path, headers={"Authorization":"Bearer "+token,
                  "Content-Type":"application/json"}, data=None if data is None else json.dumps(data).encode(),
                  method="GET" if data is None else "PUT")
    with urlopen(req,timeout=8) as response:
        return json.load(response)


def enroll(node, ip, port):
    validate_endpoint(ip,port)
    if port == 8877 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}",node):
        raise ValueError("Invalid node ID or public port (8877 is reserved for the browser)")
    config = json.loads((STATE/"center.json").read_text())
    directory = STATE/"nodes"/node
    url = f"https://{ip}:{port}"
    token = (STATE/"admin.token").read_text().strip()
    rows = api(token,"state")["nodes"]
    prior = next((item for item in rows if item["id"] == node),None)
    if prior and (prior["url"] != url or not (directory/"node.token").is_file()):
        raise ValueError("Existing node ID belongs to another enrollment or address")
    if any(item["url"] == url and item["id"] != node for item in rows):
        raise ValueError("Bridge address is already registered")
    directory.mkdir(parents=True,exist_ok=True)
    node_token = credential(directory/"node.token")
    plugin_token = credential(directory/"plugin.token")
    leaf(directory,ip,ca())
    revision = run("git","-C",SRC,"rev-parse","HEAD")
    version = json.loads(run("git","-C",SRC,"show",revision+":extension/manifest.json"))["version"]
    setup = dict(node=node,ip=ip,port=port,version=version,center=f"https://{config['ip']}:{config['port']}",
                 revision=revision,node_token=node_token,plugin_token=plugin_token)
    archive = directory/(node+".zip")
    with tempfile.TemporaryDirectory(dir=directory) as temp:
        staged = Path(temp)/"node.zip"
        with ZipFile(staged,"w",ZIP_DEFLATED) as bundle:
            bundle.writestr("setup.json",json.dumps(setup))
            for path in (directory/"server.crt",directory/"server.key",STATE/"center-root.crt",
                         BOOT/"node.ps1",BOOT/"pair.js",BOOT/"node_agent.py",BOOT/"Install-VestNode.ps1"):
                bundle.write(path,path.name)
        if not prior:
            api(token,"nodes/"+node,{"label":node,"url":url,"token":node_token})
        os.replace(staged,archive)
    print(f"Node registered: {node} at {url}\nApplication: {version} ({revision})\nTransfer this private file over SSH: {archive}")


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action",required=True)
    sub.add_parser("resume")
    for name in ("install","node"):
        p = sub.add_parser(name)
        if name == "node":
            p.add_argument("node")
        p.add_argument("ip")
        p.add_argument("port",nargs="?",type=int,default=8443)
    args = parser.parse_args()
    if args.action == "resume":
        settings = json.loads((STATE/"center.json").read_text())
        install(settings["ip"],settings["port"],resume=True)
    elif args.action == "install":
        install(args.ip,args.port)
    else:
        enroll(args.node,args.ip,args.port)
