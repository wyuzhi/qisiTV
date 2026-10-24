#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="${1:?Usage: export-qisitv-website.sh /path/to/personal-site}"
[[ -f "$SITE_DIR/astro.config.mjs" && -d "$SITE_DIR/public" ]] || { echo "Expected the personal-site Astro project" >&2; exit 1; }
SITE_DIR="$(cd "$SITE_DIR" && pwd)"
VERSION_VALUE="$(tr -d '\r\n' < "$ROOT_DIR/VERSION")"
ENGINE_FILENAME="qisiTV-Engine-${VERSION_VALUE#v}-darwin-arm64.dmg"
ENGINE_DMG="${QISITV_ENGINE_DMG:-$ROOT_DIR/dist/engine/$ENGINE_FILENAME}"
ENGINE_DOWNLOAD_MODE="${QISITV_ENGINE_DOWNLOAD_MODE:-github-release}"
case "$ENGINE_DOWNLOAD_MODE" in
  github-release|static) ;;
  *) echo "qisiTV website export: QISITV_ENGINE_DOWNLOAD_MODE must be github-release or static" >&2; exit 1 ;;
esac
# A web build must never advertise an installer that is missing, stale or corrupt.
python3 "$ROOT_DIR/scripts/verify-engine-installer.py" "$ROOT_DIR/VERSION" "$ENGINE_DMG"
ENGINE_DMG="$(cd "$(dirname "$ENGINE_DMG")" && pwd)/$(basename "$ENGINE_DMG")"
REQUIRE_DISTRIBUTION_SOURCES=0
if [[ "$ENGINE_DOWNLOAD_MODE" == github-release ]]; then
  REQUIRE_DISTRIBUTION_SOURCES=1
  # Verify the complete corresponding-source packet against the installed WASM
  # binary before the build advertises its versioned public release URL.
  python3 "$ROOT_DIR/scripts/package-wasm-sources.py" \
    --verify "$ROOT_DIR/dist/qisiTV-v${VERSION_VALUE#v}-ffmpeg-wasm-sources.tar.gz" \
    --binary-dir "$ROOT_DIR/web/node_modules/@ffmpeg/core/dist/esm"
fi
(
  cd "$ROOT_DIR/web"
  CANVAS_BUILD_VERSION="$VERSION_VALUE" VITE_QISITV_ENGINE=1 VITE_QISITV_BROWSER_ONLY=0 QISITV_FULL_MEDIA_RESOURCES=1 QISITV_WEB_BASE=/qisitv/ QISITV_REQUIRE_DISTRIBUTION_SOURCES="$REQUIRE_DISTRIBUTION_SOURCES" bun run build
)
mkdir -p "$SITE_DIR/public/qisitv"
rsync -a --delete --exclude downloads/ "$ROOT_DIR/web/dist/" "$SITE_DIR/public/qisitv/"
python3 "$ROOT_DIR/scripts/configure-engine-downloads.py" "$SITE_DIR" "$ROOT_DIR/VERSION" "$ENGINE_DOWNLOAD_MODE"
if [[ "$ENGINE_DOWNLOAD_MODE" == static ]]; then
  mkdir -p "$SITE_DIR/public/qisitv/downloads/engine"
  cp "$ENGINE_DMG" "$SITE_DIR/public/qisitv/downloads/engine/$ENGINE_FILENAME"
  cp "$ENGINE_DMG.sha256" "$SITE_DIR/public/qisitv/downloads/engine/$ENGINE_FILENAME.sha256"
  python3 "$ROOT_DIR/scripts/verify-engine-installer.py" "$ROOT_DIR/VERSION" "$SITE_DIR/public/qisitv/downloads/engine/$ENGINE_FILENAME"
fi
cp "$ROOT_DIR/LICENSE" "$ROOT_DIR/NOTICE" "$ROOT_DIR/THIRD_PARTY_NOTICES.md" "$SITE_DIR/public/qisitv/"
mkdir -p "$SITE_DIR/public/qisitv/licenses"
cp "$ROOT_DIR/licenses/BeefTV-Source-Available-1.0.txt" "$SITE_DIR/public/qisitv/licenses/"
cp "$ROOT_DIR/assets/readme/qisitv-workspace.png" "$SITE_DIR/public/assets/qisitv-workspace.png"
mkdir -p "$SITE_DIR/api/qisitv"
cp "$ROOT_DIR/deploy/website/api/qisitv/likeai.ts" "$SITE_DIR/api/qisitv/likeai.ts"
QISITV_SITE_EXPORT_TARGET="$SITE_DIR" QISITV_RELAY_SOURCE="$ROOT_DIR/deploy/website" bun -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const configPath = path.join(process.env.QISITV_SITE_EXPORT_TARGET, "vercel.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const fragment = JSON.parse(fs.readFileSync(path.join(process.env.QISITV_RELAY_SOURCE, "vercel.fragment.json"), "utf8"));
  config.rewrites = [...fragment.rewrites, ...(config.rewrites || []).filter(rule => !rule.source?.startsWith("/api/qisitv/likeai/"))];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
'
echo "Engine workspace exported to $SITE_DIR/public/qisitv; installer delivery: $ENGINE_DOWNLOAD_MODE (not deployed)"
