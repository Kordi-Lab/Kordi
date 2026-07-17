#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/deploy/dev/compose.yaml"
env_file="$repo_root/deploy/dev/.env"

if [[ ! -f "$env_file" ]]; then
  echo "[kordi-debug] Missing deploy/dev/.env. Run pnpm debug:cloud:up first." >&2
  exit 1
fi

api_port="${KORDI_DEBUG_API_PORT:-$(sed -n 's/^KORDI_DEBUG_API_PORT=//p' "$env_file" | tail -1)}"
api_port="${api_port:-17081}"

for service in postgres redis nats minio cloud-server; do
  container_id="$(docker compose --env-file "$env_file" -f "$compose_file" ps -q "$service")"
  if [[ -z "$container_id" ]] || [[ "$(docker inspect -f '{{.State.Running}}' "$container_id")" != "true" ]]; then
    echo "[kordi-debug] Service is not running: $service" >&2
    docker compose --env-file "$env_file" -f "$compose_file" ps >&2
    exit 1
  fi
done

health_url="http://127.0.0.1:${api_port}/health"
for _attempt in $(seq 1 60); do
  if response="$(curl --fail --silent --show-error --max-time 2 "$health_url" 2>/dev/null)" \
    && grep -q '"ok"[[:space:]]*:[[:space:]]*true' <<<"$response"; then
    echo "[kordi-debug] Healthy isolated Cloud API: $health_url"
    exit 0
  fi
  sleep 1
done

echo "[kordi-debug] Cloud API did not become healthy: $health_url" >&2
docker compose --env-file "$env_file" -f "$compose_file" logs --tail=120 cloud-server >&2
exit 1
