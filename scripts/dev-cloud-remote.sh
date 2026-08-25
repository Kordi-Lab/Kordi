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
preview_path="${KORDI_DEV_PREVIEW_PATH:-}"
local_signaling_port="${KORDI_DEV_LOCAL_SIGNALING_PORT:-}"
remote_signaling_port="${KORDI_DEV_REMOTE_SIGNALING_PORT:-}"
local_ice_tcp_port="${KORDI_DEV_LOCAL_ICE_TCP_PORT:-}"
remote_ice_tcp_port="${KORDI_DEV_REMOTE_ICE_TCP_PORT:-}"
media_tunnel="false"
tunnel_pid=""
desktop_pid=""

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [[ -n "$desktop_pid" ]]; then
    kill "$desktop_pid" 2>/dev/null || true
    wait "$desktop_pid" 2>/dev/null || true
  fi
  if [[ -n "$tunnel_pid" ]]; then
    kill "$tunnel_pid" 2>/dev/null || true
    wait "$tunnel_pid" 2>/dev/null || true
  fi
  exit "$exit_status"
}
trap cleanup EXIT INT TERM

if [[ -n "$local_signaling_port$remote_signaling_port$local_ice_tcp_port$remote_ice_tcp_port" ]]; then
  if [[ -z "$local_signaling_port" || -z "$remote_signaling_port" \
     || -z "$local_ice_tcp_port" || -z "$remote_ice_tcp_port" ]]; then
    echo "[kordi-remote-dev] Set all four signaling and ICE/TCP port variables together." >&2
    exit 1
  fi
  media_tunnel="true"
  if [[ "$local_ice_tcp_port" != "$remote_ice_tcp_port" ]]; then
    echo "[kordi-remote-dev] Local and remote ICE/TCP ports must match the advertised loopback candidate." >&2
    exit 1
  fi
fi

required_commands=(curl gcloud gh pnpm)
if [[ "$media_tunnel" == "true" ]]; then required_commands+=(nc); fi
for command in "${required_commands[@]}"; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "[kordi-remote-dev] Required command is unavailable: $command" >&2
    exit 1
  fi
done

if [[ -z "$gcp_project" || -z "$ssh_zone" || -z "$ssh_target" ]]; then
  echo "[kordi-remote-dev] Set KORDI_DEV_GCP_PROJECT, KORDI_DEV_SSH_ZONE, and KORDI_DEV_SSH_TARGET." >&2
  exit 1
fi

ports=("$local_api_port" "$remote_api_port" "$desktop_port")
if [[ "$media_tunnel" == "true" ]]; then
  ports+=("$local_signaling_port" "$remote_signaling_port" "$local_ice_tcp_port" "$remote_ice_tcp_port")
fi
for port in "${ports[@]}"; do
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

if [[ "$media_tunnel" == "true" ]]; then
  for port in "$local_signaling_port" "$local_ice_tcp_port"; do
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      echo "[kordi-remote-dev] Local media port $port is already serving a process." >&2
      exit 1
    fi
  done
fi

echo "[kordi-remote-dev] Opening an IAP tunnel to the approved isolated development host."
forward_args=(-L "127.0.0.1:${local_api_port}:127.0.0.1:${remote_api_port}")
if [[ "$media_tunnel" == "true" ]]; then
  forward_args+=(
    -L "127.0.0.1:${local_signaling_port}:127.0.0.1:${remote_signaling_port}"
    -L "127.0.0.1:${local_ice_tcp_port}:127.0.0.1:${remote_ice_tcp_port}"
  )
fi

open_tunnel() {
  gcloud compute ssh "$ssh_target" \
    --project "$gcp_project" \
    --zone "$ssh_zone" \
    --tunnel-through-iap \
    --quiet \
    -- \
    -N \
    "${forward_args[@]}" \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 &
  tunnel_pid=$!
}

open_tunnel

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

if [[ "$media_tunnel" == "true" ]]; then
  media_healthy="false"
  for _attempt in $(seq 1 45); do
    if nc -z 127.0.0.1 "$local_signaling_port" >/dev/null 2>&1 \
      && nc -z 127.0.0.1 "$local_ice_tcp_port" >/dev/null 2>&1; then
      media_healthy="true"
      break
    fi
    if ! kill -0 "$tunnel_pid" 2>/dev/null; then
      wait "$tunnel_pid" 2>/dev/null || true
      echo "[kordi-remote-dev] The IAP tunnel exited before call media became reachable." >&2
      exit 1
    fi
    sleep 1
  done
  if [[ "$media_healthy" != "true" ]]; then
    echo "[kordi-remote-dev] Call signaling or ICE/TCP did not become reachable." >&2
    exit 1
  fi
fi

if [[ -z "$preview_path" ]]; then
  capabilities="$(curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    "$api_base/v1/cloud/auth/capabilities")"
  if ! grep -q '"google"' <<<"$capabilities" || ! grep -q '"github"' <<<"$capabilities"; then
    echo "[kordi-remote-dev] The development API must advertise both Google and GitHub OAuth before launch." >&2
    exit 1
  fi
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

if [[ -n "$preview_path" ]]; then
  echo "[kordi-remote-dev] Verified the isolated API for a login-free fixture preview."
elif [[ "$media_tunnel" == "true" ]]; then
  echo "[kordi-remote-dev] Verified API, OAuth, signaling, and ICE/TCP."
else
  echo "[kordi-remote-dev] Verified Google and GitHub OAuth."
fi
echo "[kordi-remote-dev] Launching the isolated desktop profile."
pnpm dev:desktop:profile -- \
  --profile "$desktop_profile" \
  --title "$desktop_title" \
  --port "$desktop_port" &
desktop_pid=$!

while kill -0 "$desktop_pid" 2>/dev/null; do
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    wait "$tunnel_pid" 2>/dev/null || true
    echo "[kordi-remote-dev] The IAP tunnel exited; reconnecting."
    open_tunnel
  fi
  sleep 2
done

wait "$desktop_pid"
