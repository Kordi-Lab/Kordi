#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/deploy/dev/compose.yaml"
env_file="$repo_root/deploy/dev/.env"

for command_name in docker openssl curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[kordi-debug] Missing required command: $command_name" >&2
    exit 1
  fi
done

if ! docker info >/dev/null 2>&1; then
  echo "[kordi-debug] Docker is installed but its daemon is not available." >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  umask 077
  temp_env="$(mktemp "$repo_root/deploy/dev/.env.XXXXXX")"
  trap 'rm -f "$temp_env"' EXIT
  {
    printf 'KORDI_DEBUG_API_PORT=17081\n'
    printf 'KORDI_DEBUG_MINIO_PORT=19000\n'
    printf 'KORDI_DEBUG_MINIO_CONSOLE_PORT=19001\n'
    printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'MINIO_ROOT_USER=kordi-debug\n'
    printf 'MINIO_ROOT_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'KORDI_CLOUD_RUNNER_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'KORDI_CHAT_SYNC_CURSOR_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'KORDI_OAUTH_GITHUB_CLIENT_ID=\n'
    printf 'KORDI_OAUTH_GITHUB_CLIENT_SECRET=\n'
    printf 'KORDI_OAUTH_GOOGLE_CLIENT_ID=\n'
    printf 'KORDI_OAUTH_GOOGLE_CLIENT_SECRET=\n'
  } >"$temp_env"
  chmod 600 "$temp_env"
  mv "$temp_env" "$env_file"
  trap - EXIT
  echo "[kordi-debug] Generated local-only credentials in deploy/dev/.env"
fi

if grep -q '<generated-by-debug-helper>' "$env_file"; then
  echo "[kordi-debug] deploy/dev/.env contains placeholders. Remove it and run this command again." >&2
  exit 1
fi

if ! grep -q '^KORDI_CHAT_SYNC_CURSOR_SECRET=' "$env_file"; then
  umask 077
  printf 'KORDI_CHAT_SYNC_CURSOR_SECRET=%s\n' "$(openssl rand -hex 32)" >>"$env_file"
  chmod 600 "$env_file"
  echo "[kordi-debug] Added an isolated chat-sync secret to the existing deploy/dev/.env"
fi

# Compose gives the parent shell precedence over --env-file. Clear every
# server-side credential that this stack interpolates so a maintainer's
# production environment cannot silently override the isolated dev file.
unset POSTGRES_PASSWORD REDIS_PASSWORD
unset MINIO_ROOT_USER MINIO_ROOT_PASSWORD
unset KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY KORDI_CLOUD_RUNNER_TOKEN
unset KORDI_CHAT_SYNC_CURSOR_SECRET
unset KORDI_OAUTH_GITHUB_CLIENT_ID KORDI_OAUTH_GITHUB_CLIENT_SECRET
unset KORDI_OAUTH_GOOGLE_CLIENT_ID KORDI_OAUTH_GOOGLE_CLIENT_SECRET

docker compose --env-file "$env_file" -f "$compose_file" up --build --detach
bash "$repo_root/scripts/dev-cloud-smoke.sh"

api_port="${KORDI_DEBUG_API_PORT:-$(sed -n 's/^KORDI_DEBUG_API_PORT=//p' "$env_file" | tail -1)}"
api_port="${api_port:-17081}"
echo
echo "[kordi-debug] Start the desktop against this isolated backend:"
echo "VITE_KORDI_CLOUD_API_BASE=http://127.0.0.1:${api_port} pnpm dev"
