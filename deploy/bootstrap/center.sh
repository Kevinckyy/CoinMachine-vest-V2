#!/usr/bin/env bash
set -euo pipefail
umask 077

# install CENTER_IPV4 [PORT] | node ID NODE_IPV4 [PORT]
usage() { echo "Usage: sudo bash $0 {install CENTER_IPV4 [PORT] | resume | node ID NODE_IPV4 [PORT]}" >&2; exit 2; }
case "${1:-}" in
  install) [[ $# == 2 || $# == 3 ]] || usage ;;
  resume) [[ $# == 1 ]] || usage ;;
  node|bundle) [[ $# == 3 || $# == 4 ]] || usage ;;
  *) usage ;;
esac
[[ $EUID == 0 ]] || { echo 'Run as root (sudo).' >&2; exit 1; }
state=/var/lib/vest-fleet
src=/opt/vest-fleet/src
here=$(cd "$(dirname "$0")" && pwd)
install -d -m 700 "$state"
exec 9>"$state/bootstrap.lock"
flock 9

open_port() {
  if systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port="$1/tcp"
    firewall-cmd --add-port="$1/tcp"
  elif command -v ufw >/dev/null && LC_ALL=C ufw status | grep -q '^Status: active'; then
    ufw allow "$1/tcp"
  fi
}
if [[ $1 == resume ]]; then
  [[ -f $state/center.json && -d $src/fleet && -d /opt/vest-fleet/bootstrap ]] || {
    echo 'No previous center setup found. Run install first.' >&2; exit 1;
  }
  # Use the recovery helper from the supplied bundle without pulling Git or changing the running revision.
  if [[ $here != /opt/vest-fleet/bootstrap ]]; then
    for file in provision.py center.sh; do install -m 600 "$here/$file" "/opt/vest-fleet/bootstrap/$file"; done
  fi
  python3 /opt/vest-fleet/bootstrap/provision.py resume
  open_port "$(python3 -c 'import json; print(json.load(open("/var/lib/vest-fleet/center.json"))["port"])')"
  exit 0
fi

if [[ $1 == node || $1 == bundle ]]; then
  if [[ $1 == bundle ]]; then
    python3 /opt/vest-fleet/bootstrap/provision.py node "${@:2}" >&2
    exec base64 -w0 "$state/nodes/$2/$2.zip"
  fi
  exec python3 /opt/vest-fleet/bootstrap/provision.py "$@"
fi
if command -v apt-get >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y git podman openssl python3 ca-certificates curl
elif command -v dnf >/dev/null; then
  dnf install -y git podman openssl python3 ca-certificates curl
else
  echo 'This installer supports systemd Linux with apt-get or dnf.' >&2; exit 1
fi
repo=${VEST_GIT_URL:-https://github.com/Kevinckyy/CoinMachine-vest-V2.git}
install -d /opt/vest-fleet
if [[ ! -d $src/.git ]]; then
  git clone --branch main --single-branch --filter=blob:none --no-checkout "$repo" "$src"
fi
git -C "$src" sparse-checkout set --no-cone '/fleet/' '/web/' '/extension/manifest.json' '/extension/archive.js' '/deploy/bootstrap/' '/deploy/node_agent.py' '/deploy/dispatch_update.py' '/deploy/Install-VestNode.ps1'
# Pin the application tree on first installation. Reruns retain the installed revision.
git -C "$src" checkout --detach HEAD
if [[ ! -f $here/provision.py ]]; then here="$src/deploy/bootstrap"; fi
if [[ -f $here/release.json ]]; then
  mode=new
  if [[ -f $state/center.json ]]; then mode=existing; fi
  python3 "$here/release.py" "$src" "$mode"
fi
install -d -m 700 /opt/vest-fleet/bootstrap
for file in center.sh provision.py node.ps1 pair.js release.py update_center.py update-nodes.sh Update-VestNode.ps1; do
  if [[ "$here/$file" != "/opt/vest-fleet/bootstrap/$file" ]]; then
    install -m 600 "$here/$file" "/opt/vest-fleet/bootstrap/$file"
  fi
done
if [[ -f $here/release.json && "$here" != /opt/vest-fleet/bootstrap ]]; then
  install -m 600 "$here/release.json" /opt/vest-fleet/bootstrap/release.json
fi
for file in node_agent.py dispatch_update.py Install-VestNode.ps1; do
  if [[ "$here" == /opt/vest-fleet/bootstrap && -f "$here/$file" ]]; then continue; fi
  source_file="$here/../$file"
  if [[ ! -f "$source_file" ]]; then source_file="$src/deploy/$file"; fi
  install -m 600 "$source_file" "/opt/vest-fleet/bootstrap/$file"
done
python3 /opt/vest-fleet/bootstrap/provision.py "$@"
open_port "${3:-8443}"
