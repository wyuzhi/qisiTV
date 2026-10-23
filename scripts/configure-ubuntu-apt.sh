#!/usr/bin/env bash
set -euo pipefail

# The runner's Azure mirror has stalled media-package downloads. Keep Ubuntu's
# signed repositories and package versions, using the primary archive instead.
apt_root="${1:-/etc/apt}"
for source in "$apt_root/sources.list" "$apt_root"/sources.list.d/*.sources "$apt_root"/sources.list.d/*.list "$apt_root"/apt-mirrors*.txt; do
  [[ -f "$source" ]] || continue
  # Hosted runners use mirror+file URIs, whose Azure priority lives in .txt.
  sudo sed -i 's|https\{0,1\}://azure\.archive\.ubuntu\.com/|https://archive.ubuntu.com/|g' "$source"
done
printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' \
  | sudo tee "$apt_root/apt.conf.d/80beeftv-network" >/dev/null
