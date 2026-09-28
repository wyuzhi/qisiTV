#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
./qisitv-connect serve
printf '\nConnector stopped. Press Enter to close.\n'
read -r _
