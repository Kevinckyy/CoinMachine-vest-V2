#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Run on the Linux center with sudo.' >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
src=/opt/vest-fleet/src
revision=$(git -C "$src" rev-parse HEAD)
if [[ -f $here/release.json ]]; then
  revision=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["revision"])' "$here/release.json")
fi
export VEST_ADMIN_TOKEN
VEST_ADMIN_TOKEN=$(cat /var/lib/vest-fleet/admin.token)
export VEST_CENTER_URL=http://127.0.0.1:8780
if [[ -f $here/dispatch_update.py ]]; then dispatch="$here/dispatch_update.py"; else dispatch="$here/../dispatch_update.py"; fi
exec python3 "$dispatch" --revision "$revision" --wait 180 "$@"
