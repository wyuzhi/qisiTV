#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
./qisitv-connect install-codex
printf '\nPress Enter to close.\n'
read -r _
