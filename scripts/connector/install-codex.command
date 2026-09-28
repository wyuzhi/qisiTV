#!/bin/bash
set -u
cd -- "$(dirname -- "$0")" || exit 1

install_mcp() {
  case "$(uname -s)" in
    Darwin) qisitv_install_dir="$HOME/Library/Application Support/qisiTV/MCP" ;;
    *) qisitv_install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/qisiTV/MCP" ;;
  esac
  mkdir -p "$qisitv_install_dir" || return 1
  chmod 700 "$qisitv_install_dir" || return 1
  qisitv_install_tmp="$(mktemp "$qisitv_install_dir/.qisitv-connect.XXXXXX")" || return 1
  if ! cp ./qisitv-connect "$qisitv_install_tmp" || ! chmod 700 "$qisitv_install_tmp" || ! mv -f "$qisitv_install_tmp" "$qisitv_install_dir/qisitv-connect"; then
    rm -f -- "$qisitv_install_tmp"
    return 1
  fi
  for qisitv_notice in README.txt LICENSE NOTICE THIRD_PARTY_NOTICES.md; do
    if [[ -f "$qisitv_notice" ]]; then cp "$qisitv_notice" "$qisitv_install_dir/" || return 1; fi
  done
  if [[ -d licenses ]]; then cp -R licenses "$qisitv_install_dir/" || return 1; fi
  "$qisitv_install_dir/qisitv-connect" install-codex || return 1
  printf '\nqisiTV MCP installed at: %s\n' "$qisitv_install_dir"
  printf 'You may delete the downloaded package. Reopen Codex and ask it to call qisitv_pair.\n'
  printf 'Codex starts the local service automatically. No separate terminal is needed.\n'
}

qisitv_install_status=0
install_mcp || qisitv_install_status=$?
if [[ "$qisitv_install_status" -ne 0 ]]; then
  printf '\nInstallation did not complete. Fix the error above and run this installer again.\n' >&2
fi
printf '\nPress Enter to close this installer.\n'
read -r _ || true
exit "$qisitv_install_status"
