#!/usr/bin/env bash
# Run from the extracted offline bundle on the affected Linux center.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
cd "$(dirname "$0")"
[[ -r /var/lib/vest-fleet/center.json && -d /opt/vest-fleet/src/fleet ]] || {
  echo 'No previous center install found on this host.' >&2; exit 1;
}
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Supported offline bundles: Linux amd64 and arm64.' >&2; exit 1 ;;
esac
[[ $(cat platform) == "linux/$arch" ]] || { echo "This host requires the linux/$arch bundle." >&2; exit 1; }
sha256sum --check SHA256SUMS
command -v podman >/dev/null || { echo 'Podman is missing; run the initial Linux installer first.' >&2; exit 1; }
for image in python:3.12-slim caddy:2-alpine; do
  tag="docker.io/library/$image"
  if podman image exists "$tag" && [[ $(podman image inspect --format '{{.Architecture}}' "$tag") == "$arch" ]]; then
    echo "Using cached $tag"
    continue
  fi
  podman load --input "${image%%:*}.tar"
  [[ $(podman image inspect --format '{{.Architecture}}' "$tag") == "$arch" ]] || {
    echo "Imported archive did not provide $tag for $arch." >&2; exit 1;
  }
done
exec bash ./center.sh resume
