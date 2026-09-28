#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${1:-$repo_dir/dist/connector}"
mkdir -p "$output_dir"
output_dir="$(cd -- "$output_dir" && pwd)"
cd "$repo_dir/backend"

for target in darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  target_os="${target%/*}"
  target_arch="${target#*/}"
  extension=""
  if [[ "$target_os" == windows ]]; then extension=".exe"; fi
  file_name="qisitv-connect-${target_os}-${target_arch}${extension}"
  CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go build -trimpath -ldflags='-s -w' -o "$output_dir/$file_name" ./cmd/qisitv-connect
  printf '%s\n' "$output_dir/$file_name"
  package_dir="$(mktemp -d)"
  package_name="qisitv-connect-${target_os}-${target_arch}"
  mkdir "$package_dir/$package_name"
  cp "$output_dir/$file_name" "$package_dir/$package_name/qisitv-connect${extension}"
  cp "$repo_dir/scripts/connector/README.txt" "$package_dir/$package_name/README.txt"
  cp "$repo_dir/LICENSE" "$repo_dir/NOTICE" "$repo_dir/THIRD_PARTY_NOTICES.md" "$package_dir/$package_name/"
  mkdir "$package_dir/$package_name/licenses"
  cp "$(go env GOROOT)/LICENSE" "$package_dir/$package_name/licenses/Go-LICENSE"
  while IFS='|' read -r module_name module_dir; do
    [[ -n "$module_name" && "$module_name" != qisitv/backend ]] || continue
    module_label="${module_name//\//_}"
    for notice in "$module_dir"/LICENSE* "$module_dir"/COPYING* "$module_dir"/NOTICE*; do
      [[ -f "$notice" ]] || continue
      cp "$notice" "$package_dir/$package_name/licenses/${module_label}-$(basename "$notice")"
    done
  done < <(CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" go list -deps -f '{{if .Module}}{{.Module.Path}}|{{.Module.Dir}}{{end}}' ./cmd/qisitv-connect | sort -u)
  case "$target_os" in
    darwin)
      cp "$repo_dir/scripts/connector/start.command" "$repo_dir/scripts/connector/install-codex.command" "$package_dir/$package_name/"
      chmod +x "$package_dir/$package_name/"*.command
      (cd "$package_dir" && zip -q -r "$output_dir/$package_name.zip" "$package_name")
      ;;
    windows)
      cp "$repo_dir/scripts/connector/start.cmd" "$repo_dir/scripts/connector/install-codex.cmd" "$package_dir/$package_name/"
      (cd "$package_dir" && zip -q -r "$output_dir/$package_name.zip" "$package_name")
      ;;
    linux)
      cp "$repo_dir/scripts/connector/start.command" "$package_dir/$package_name/start.sh"
      cp "$repo_dir/scripts/connector/install-codex.command" "$package_dir/$package_name/install-codex.sh"
      chmod +x "$package_dir/$package_name/"*.sh
      tar -czf "$output_dir/$package_name.tar.gz" -C "$package_dir" "$package_name"
      ;;
  esac
  # Remove only the temporary packaging directory created in this loop.
  rm -r -- "$package_dir"
done
if command -v shasum >/dev/null 2>&1; then
  (cd "$output_dir" && shasum -a 256 qisitv-connect-* > SHA256SUMS)
else
  (cd "$output_dir" && sha256sum qisitv-connect-* > SHA256SUMS)
fi
