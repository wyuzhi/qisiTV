#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="${1:?Usage: export-qisitv-website.sh /path/to/personal-site}"
[[ -f "$SITE_DIR/astro.config.mjs" && -d "$SITE_DIR/public" ]] || { echo "Expected the personal-site Astro project" >&2; exit 1; }
SITE_DIR="$(cd "$SITE_DIR" && pwd)"
(
  cd "$ROOT_DIR/web"
  VITE_QISITV_BROWSER_ONLY=1 QISITV_WEB_BASE=/qisitv/ bun run build
)
mkdir -p "$SITE_DIR/public/qisitv"
rsync -a --delete "$ROOT_DIR/web/dist/" "$SITE_DIR/public/qisitv/"
cp "$ROOT_DIR/LICENSE" "$ROOT_DIR/NOTICE" "$ROOT_DIR/THIRD_PARTY_NOTICES.md" "$SITE_DIR/public/qisitv/"
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
echo "Browser workspace exported to $SITE_DIR/public/qisitv"
