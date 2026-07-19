#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
allowlist_file="$repo_root/deploy/dev/operator-github-allowlist.txt"
api_base="${1:-${KORDI_OPERATOR_CLOUD_API_BASE:-}}"

if [[ "${KORDI_OPERATOR_DEBUG_ACKNOWLEDGED:-}" != "1" ]]; then
  echo "[kordi-operator] Set KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1 to confirm this run may access real hosted data." >&2
  exit 1
fi

if [[ -z "$api_base" ]]; then
  echo "[kordi-operator] Provide the approved remote API origin as the first argument or KORDI_OPERATOR_CLOUD_API_BASE." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[kordi-operator] GitHub CLI is required to verify the local operator account." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[kordi-operator] pnpm is required to launch Kordi Desktop." >&2
  exit 1
fi

github_login="$(gh api user --jq .login 2>/dev/null || true)"
if [[ -z "$github_login" ]]; then
  echo "[kordi-operator] Sign in with GitHub CLI before using operator debug mode: gh auth login" >&2
  exit 1
fi

allowed="false"
shopt -s nocasematch
while IFS= read -r line || [[ -n "$line" ]]; do
  candidate="${line%%#*}"
  candidate="${candidate#"${candidate%%[![:space:]]*}"}"
  candidate="${candidate%"${candidate##*[![:space:]]}"}"
  if [[ -n "$candidate" && "$candidate" == "$github_login" ]]; then
    allowed="true"
    break
  fi
done <"$allowlist_file"

if [[ "$allowed" != "true" ]]; then
  echo "[kordi-operator] GitHub account @$github_login is not allowlisted for operator debug mode." >&2
  exit 1
fi

export VITE_KORDI_CLOUD_API_BASE="$api_base"
export VITE_KORDI_DEV_PROFILE="operator"
export VITE_KORDI_PRODUCTION_DEBUG_ACK="1"

# A desktop operator session talks to the hosted API only. Do not pass server-side
# credentials through if the maintainer happens to have them in the parent shell.
unset DATABASE_URL REDIS_URL NATS_URL
unset S3_ACCESS_KEY S3_SECRET_KEY KORDI_RELEASE_S3_ACCESS_KEY KORDI_RELEASE_S3_SECRET_KEY
unset MINIO_ROOT_USER MINIO_ROOT_PASSWORD
unset KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY KORDI_CLOUD_RUNNER_TOKEN
unset KORDI_OAUTH_GOOGLE_CLIENT_ID KORDI_OAUTH_GOOGLE_CLIENT_SECRET
unset KORDI_OAUTH_GITHUB_CLIENT_ID KORDI_OAUTH_GITHUB_CLIENT_SECRET

echo "[kordi-operator] Verified allowlisted GitHub account @$github_login."
echo "[kordi-operator] Connecting the desktop to the approved remote API; database credentials remain server-side."
exec pnpm --dir "$repo_root/app/desktop" tauri:dev:cloud
