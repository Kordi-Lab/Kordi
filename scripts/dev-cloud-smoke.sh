#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/deploy/dev/compose.yaml"
env_file="${KORDI_DEBUG_ENV_FILE:-$repo_root/deploy/dev/.env}"
project_name="${KORDI_DEBUG_PROJECT_NAME:-kordi-debug}"
compose=(docker compose --project-name "$project_name" --env-file "$env_file" -f "$compose_file")

if [[ ! -f "$env_file" ]]; then
  echo "[kordi-debug] Missing deploy/dev/.env. Run pnpm debug:cloud:up first." >&2
  exit 1
fi

api_port="${KORDI_DEBUG_API_PORT:-$(sed -n 's/^KORDI_DEBUG_API_PORT=//p' "$env_file" | tail -1)}"
api_port="${api_port:-17081}"

for service in postgres redis nats minio cloud-server cloud-agent-runner; do
  container_id="$("${compose[@]}" ps -q "$service")"
  if [[ -z "$container_id" ]] || [[ "$(docker inspect -f '{{.State.Running}}' "$container_id")" != "true" ]]; then
    echo "[kordi-debug] Service is not running: $service" >&2
    "${compose[@]}" ps >&2
    exit 1
  fi
done

health_url="http://127.0.0.1:${api_port}/health"
healthy="false"
for _attempt in $(seq 1 60); do
  if response="$(curl --fail --silent --show-error --max-time 2 "$health_url" 2>/dev/null)" \
    && grep -q '"ok"[[:space:]]*:[[:space:]]*true' <<<"$response"; then
    echo "[kordi-debug] Healthy isolated Cloud API: $health_url"
    healthy="true"
    break
  fi
  sleep 1
done

if [[ "$healthy" != "true" ]]; then
  echo "[kordi-debug] Cloud API did not become healthy: $health_url" >&2
  "${compose[@]}" logs --tail=120 cloud-server >&2
  exit 1
fi

for provider in GITHUB GOOGLE; do
  provider_command="$(printf '%s' "$provider" | tr '[:upper:]' '[:lower:]')"
  if grep -Eq "^KORDI_OAUTH_${provider}_CLIENT_ID=.+" "$env_file" \
    && grep -Eq "^KORDI_OAUTH_${provider}_CLIENT_SECRET=.+" "$env_file"; then
    echo "[kordi-debug] ${provider} OAuth: configured"
  else
    echo "[kordi-debug] ${provider} OAuth: not configured (run: pnpm debug:cloud:oauth -- ${provider_command})"
  fi
done

echo "[kordi-debug] Desktop: VITE_KORDI_CLOUD_API_BASE=${health_url%/health} VITE_KORDI_DEV_PROFILE=community pnpm dev:desktop:profile -- --profile dev-isolated --title \"Kordi Dev\" --port 1422"
