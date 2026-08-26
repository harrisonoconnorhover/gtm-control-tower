#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/gtm-control-tower-smoke.XXXXXX")"
project_name="gtm-control-tower-smoke-$$"

export CONTROL_TOWER_BIND=127.0.0.1
export CONTROL_TOWER_PORT=0
export CONTROL_TOWER_SQLITE_DIR="$runtime_root/sqlite"
export N8N_BIND=127.0.0.1
export N8N_PORT=0
export N8N_DATA_DIR="$runtime_root/n8n"

mkdir -p "$CONTROL_TOWER_SQLITE_DIR" "$N8N_DATA_DIR"
chmod 0755 "$runtime_root"
chmod 0777 "$CONTROL_TOWER_SQLITE_DIR" "$N8N_DATA_DIR"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [[ $status -ne 0 ]]; then
    docker compose -p "$project_name" logs --tail=200 >&2 || true
  fi
  docker compose -p "$project_name" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$runtime_root"
  exit "$status"
}
trap cleanup EXIT INT TERM

cd "$repo_root"
docker compose -p "$project_name" up -d --build

app_address="$(docker compose -p "$project_name" port app 3000)"
n8n_address="$(docker compose -p "$project_name" port n8n 5678)"
export CONTROL_TOWER_SMOKE_BASE_URL="http://$app_address"
export CONTROL_TOWER_SMOKE_N8N_URL="http://$n8n_address"

workspace_id="$(node scripts/fresh-install-smoke.mjs prepare)"
docker compose -p "$project_name" restart app >/dev/null
app_address="$(docker compose -p "$project_name" port app 3000)"
export CONTROL_TOWER_SMOKE_BASE_URL="http://$app_address"
node scripts/fresh-install-smoke.mjs verify "$workspace_id"

docker compose -p "$project_name" exec -T n8n env \
  | grep -qx 'N8N_CONCURRENCY_PRODUCTION_LIMIT=1'

echo "Fresh-install smoke test passed with isolated runtime state and no credentials."
