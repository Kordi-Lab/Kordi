#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "${1:-}" != "--yes" ]]; then
  echo "This permanently deletes the local Kordi debug database, objects, event data, and generated credentials." >&2
  echo "Run: pnpm debug:cloud:reset -- --yes" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/deploy/dev/compose.yaml"
env_file="$repo_root/deploy/dev/.env"

if [[ -f "$env_file" ]]; then
  docker compose --env-file "$env_file" -f "$compose_file" down --volumes --remove-orphans
  rm -f "$env_file"
else
  docker compose \
    --env-file "$repo_root/deploy/dev/.env.example" \
    -f "$compose_file" \
    down --volumes --remove-orphans
fi

echo "[kordi-debug] Local debug data and credentials were removed. Production was not contacted."
