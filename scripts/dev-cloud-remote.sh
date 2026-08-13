#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
allowlist_file="${KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE:-$repo_root/deploy/dev/operator-github-allowlist.txt}"
gcp_project="${KORDI_DEV_GCP_PROJECT:-}"
ssh_zone="${KORDI_DEV_SSH_ZONE:-}"
ssh_target="${KORDI_DEV_SSH_TARGET:-}"
local_api_port="${KORDI_DEV_LOCAL_API_PORT:-17081}"
remote_api_port="${KORDI_DEV_REMOTE_API_PORT:-17081}"
desktop_port="${KORDI_DEV_DESKTOP_PORT:-1422}"
desktop_profile="${KORDI_DEV_DESKTOP_PROFILE:-dev-isolated}"
desktop_title="${KORDI_DEV_DESKTOP_TITLE:-Kordi Dev}"
tunnel_pid=""

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [[ -n "$tunnel_pid" ]]; then
    kill "$tunnel_pid" 2>/dev/null || true
    wait "$tunnel_pid" 2>/dev/null || true
  fi
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

for command in curl gcloud gh pnpm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[kordi-remote-dev] Required command is unavailable: $command" >&2
    exit 1
  fi
done

if [[ -z "$gcp_project" || -z "$ssh_zone" || -z "$ssh_target" ]]; then
  echo "[kordi-remote-dev] Set KORDI_DEV_GCP_PROJECT, KORDI_DEV_SSH_ZONE, and KORDI_DEV_SSH_TARGET." >&2
  exit 1
fi

for port in "$local_api_port" "$remote_api_port" "$desktop_port"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
    echo "[kordi-remote-dev] Invalid port: $port" >&2
    exit 1
  fi
done

if [[ ! -r "$allowlist_file" ]]; then
  echo "[kordi-remote-dev] Missing local operator allowlist: $allowlist_file" >&2
  exit 1
fi

github_login="$(gh api user --jq .login 2>/dev/null || true)"
if [[ -z "$github_login" ]]; then
  echo "[kordi-remote-dev] Sign in with GitHub CLI before launching a remote development preview." >&2
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
shopt -u nocasematch

if [[ "$allowed" != "true" ]]; then
  echo "[kordi-remote-dev] GitHub account @$github_login is not allowlisted for a Kordi preview." >&2
  exit 1
fi

api_base="http://127.0.0.1:${local_api_port}"
if curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "$api_base/health" >/dev/null 2>&1; then
  echo "[kordi-remote-dev] Local API port $local_api_port is already serving a process. Refusing an ambiguous tunnel target." >&2
  exit 1
fi

echo "[kordi-remote-dev] Opening an IAP tunnel to the approved isolated development host."
gcloud compute ssh "$ssh_target" \
  --project "$gcp_project" \
  --zone "$ssh_zone" \
  --tunnel-through-iap \
  --quiet \
  -- \
  -N \
  -L "127.0.0.1:${local_api_port}:127.0.0.1:${remote_api_port}" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 &
tunnel_pid=$!

healthy="false"
for _attempt in $(seq 1 45); do
  if response="$(curl --fail --silent --show-error --connect-timeout 1 --max-time 2 "$api_base/health" 2>/dev/null)" \
    && grep -q '"ok"[[:space:]]*:[[:space:]]*true' <<<"$response"; then
    healthy="true"
    break
  fi
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    wait "$tunnel_pid" 2>/dev/null || true
    echo "[kordi-remote-dev] The IAP tunnel exited before the development API became healthy." >&2
    exit 1
  fi
  sleep 1
done

if [[ "$healthy" != "true" ]]; then
  echo "[kordi-remote-dev] The development API did not become healthy through $api_base." >&2
  exit 1
fi

capabilities="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
  "$api_base/v1/cloud/auth/capabilities")"
if ! grep -q '"google"' <<<"$capabilities" || ! grep -q '"github"' <<<"$capabilities"; then
  echo "[kordi-remote-dev] The development API must advertise both Google and GitHub OAuth before launch." >&2
  exit 1
fi

# A desktop preview receives only the loopback API origin. Server credentials
# and product deployment settings must stay out of the client process.
unset DATABASE_URL REDIS_URL NATS_URL
unset S3_ACCESS_KEY S3_SECRET_KEY KORDI_RELEASE_S3_ACCESS_KEY KORDI_RELEASE_S3_SECRET_KEY
unset MINIO_ROOT_USER MINIO_ROOT_PASSWORD
unset KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY KORDI_CLOUD_RUNNER_TOKEN
unset KORDI_OAUTH_GOOGLE_CLIENT_ID KORDI_OAUTH_GOOGLE_CLIENT_SECRET
unset KORDI_OAUTH_GITHUB_CLIENT_ID KORDI_OAUTH_GITHUB_CLIENT_SECRET
unset KORDI_CLOUD_GCP_PROJECT KORDI_CLOUD_SSH_ZONE KORDI_CLOUD_SSH_TARGET

export VITE_KORDI_CLOUD_API_BASE="$api_base"
export VITE_KORDI_DEV_PROFILE="community"

echo "[kordi-remote-dev] Verified Google and GitHub OAuth; launching the isolated desktop profile."
pnpm dev:desktop:profile -- \
  --profile "$desktop_profile" \
  --title "$desktop_title" \
  --port "$desktop_port"
