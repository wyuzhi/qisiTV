#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${QISITV_APP_PATH:-/Applications/qisiTV.app}"
OUTPUT_DIR="${QISITV_INSTALLER_DIR:-$ROOT_DIR/dist/installers}"
VERSION="$(tr -d '[:space:]' < "$ROOT_DIR/VERSION")"

[[ "$(uname -s)" == Darwin ]] || { echo "macOS is required" >&2; exit 1; }
[[ -x "$APP/Contents/MacOS/qisiTV" ]] || { echo "Build/install qisiTV.app first" >&2; exit 1; }
codesign --verify --deep --strict "$APP"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[[ "$APP_VERSION" == "${VERSION#v}" ]] || { echo "App version does not match VERSION" >&2; exit 1; }
ARCH="$(lipo -archs "$APP/Contents/MacOS/qisiTV")"
case "$ARCH" in
  arm64) PLATFORM=darwin-arm64 ;;
  x86_64) PLATFORM=darwin-amd64 ;;
  *) echo "Unsupported app architecture: $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
NAME="qisiTV-$VERSION-$PLATFORM"
FINAL="$OUTPUT_DIR/$NAME.dmg"
[[ ! -e "$FINAL" ]] || { echo "Installer already exists: $FINAL" >&2; exit 1; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/qisitv-dmg.XXXXXX")"
MOUNT="$WORK/volume"
cleanup() {
  if mount | grep -Fq " on $MOUNT "; then hdiutil detach "$MOUNT" -quiet || return; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

SIZE_KIB="$(du -sk "$APP" | awk '{print $1}')"
hdiutil create -quiet -size "$((SIZE_KIB / 1024 + 96))m" -fs HFS+ -volname "qisiTV $VERSION" "$WORK/staging.dmg"
mkdir "$MOUNT"
hdiutil attach -quiet -nobrowse -mountpoint "$MOUNT" "$WORK/staging.dmg"
ditto "$APP" "$MOUNT/qisiTV.app"
ln -s /Applications "$MOUNT/Applications"
cp "$ROOT_DIR/docs/macos-installation.txt" "$MOUNT/安装说明.txt"
codesign --verify --deep --strict "$MOUNT/qisiTV.app"
hdiutil detach -quiet "$MOUNT"
hdiutil convert -quiet "$WORK/staging.dmg" -format UDZO -imagekey zlib-level=9 -o "$FINAL"
hdiutil verify "$FINAL"
cp "$ROOT_DIR/docs/macos-installation.txt" "$OUTPUT_DIR/安装说明.txt"
(cd "$OUTPUT_DIR" && shasum -a 256 "$NAME.dmg" > "$NAME.dmg.sha256")
echo "Installer: $FINAL"
