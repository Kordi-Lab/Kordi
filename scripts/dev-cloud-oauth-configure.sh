#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/deploy/dev/compose.yaml"
env_file="$repo_root/deploy/dev/.env"
provider="${1:-}"

case "$provider" in
  github)
    provider_label="GitHub"
    client_id_key="KORDI_OAUTH_GITHUB_CLIENT_ID"
    client_secret_key="KORDI_OAUTH_GITHUB_CLIENT_SECRET"
    ;;
  google)
    provider_label="Google"
    client_id_key="KORDI_OAUTH_GOOGLE_CLIENT_ID"
    client_secret_key="KORDI_OAUTH_GOOGLE_CLIENT_SECRET"
    ;;
  *)
    echo "Usage: bash scripts/dev-cloud-oauth-configure.sh <github|google>" >&2
    exit 2
    ;;
esac

if [[ ! -f "$env_file" ]]; then
  echo "[kordi-debug] Missing deploy/dev/.env. Run pnpm debug:cloud:up first." >&2
  exit 1
fi

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "[kordi-debug] OAuth credentials must be entered in an interactive terminal." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "[kordi-debug] Docker is not available." >&2
  exit 1
fi

printf '%s Client ID: ' "$provider_label"
IFS= read -r client_id
printf '%s Client Secret (input hidden): ' "$provider_label"
IFS= read -rs client_secret
printf '\n'

temp_env=""
cleanup() {
  unset client_id client_secret
  if [[ -n "$temp_env" ]]; then
    rm -f "$temp_env"
  fi
}
trap cleanup EXIT

if [[ ! "$client_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[kordi-debug] Client ID is empty or contains unsupported characters." >&2
  exit 1
fi
if [[ ! "$client_secret" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "[kordi-debug] Client Secret is empty or contains unsupported characters." >&2
  exit 1
fi

umask 077
temp_env="$(mktemp "$repo_root/deploy/dev/.env.XXXXXX")"
found_client_id=0
found_client_secret=0

while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    "$client_id_key="*)
      printf '%s=%s\n' "$client_id_key" "$client_id"
      found_client_id=1
      ;;
    "$client_secret_key="*)
      printf '%s=%s\n' "$client_secret_key" "$client_secret"
      found_client_secret=1
      ;;
    *)
      printf '%s\n' "$line"
      ;;
  esac
done <"$env_file" >"$temp_env"

if [[ "$found_client_id" -eq 0 ]]; then
  printf '%s=%s\n' "$client_id_key" "$client_id" >>"$temp_env"
fi
if [[ "$found_client_secret" -eq 0 ]]; then
  printf '%s=%s\n' "$client_secret_key" "$client_secret" >>"$temp_env"
fi

chmod 600 "$temp_env"
mv "$temp_env" "$env_file"
temp_env=""
unset client_id client_secret

# Compose gives parent-shell variables precedence over --env-file. Clear the
# OAuth values so only the ignored, development-only env file is used.
unset KORDI_OAUTH_GITHUB_CLIENT_ID KORDI_OAUTH_GITHUB_CLIENT_SECRET
unset KORDI_OAUTH_GOOGLE_CLIENT_ID KORDI_OAUTH_GOOGLE_CLIENT_SECRET

docker compose --env-file "$env_file" -f "$compose_file" \
  up --detach --force-recreate --no-deps cloud-server cloud-agent-runner
bash "$repo_root/scripts/dev-cloud-smoke.sh"

echo "[kordi-debug] ${provider_label} OAuth configured for the isolated development stack."
