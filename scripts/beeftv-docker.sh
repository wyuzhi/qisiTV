#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
COMPOSE=(docker compose -f docker-compose.local.yml)

case "${1:-start}" in
  start) "${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 180 ;;
  build) "${COMPOSE[@]}" build ;;
  stop) "${COMPOSE[@]}" stop ;;
  status) "${COMPOSE[@]}" ps ;;
  logs) "${COMPOSE[@]}" logs -f --tail=100 backend web ;;
  *) echo "Usage: $0 {start|build|stop|status|logs}" >&2; exit 2 ;;
esac
