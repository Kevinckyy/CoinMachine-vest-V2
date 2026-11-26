#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
state=/var/lib/vest-fleet
if [[ $EUID != 0 ]]; then echo 'Run with sudo bash update.sh [--node NODE_ID ...]' >&2; exit 1; fi
if [[ ! -f $state/center.json || ! -d /opt/vest-fleet/src/.git ]]; then echo 'Existing Vest Fleet Linux center required.' >&2; exit 1; fi
umask 077
sha256sum --quiet -c SHA256SUMS
export PYTHONDONTWRITEBYTECODE=1
# Offline-installed centers include their own Python. Legacy centers use the host interpreter.
for python in /opt/vest-fleet/offline-tools/*/python/bin/python3; do
  if [[ -x $python ]]; then exec "$python" -B apply_update.py "$@"; fi
done
exec python3 -B apply_update.py "$@"
