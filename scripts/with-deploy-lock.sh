#!/usr/bin/env bash
#
# with-deploy-lock.sh — run a command while holding a shared deployment lock.
#
# Usage:
#   scripts/with-deploy-lock.sh <lock-name> [--timeout <seconds>] -- <command...>
#
# Lock names: stack-<id> for one stack, host-wide for shared host resources.
# The default timeout is 600 seconds and can be overridden with --timeout or
# KORDI_DEPLOY_LOCK_TIMEOUT. The lock is released on exit or signal, and the
# wrapped command's exit code is propagated.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-lock.sh
source "$script_dir/lib/deploy-lock.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/with-deploy-lock.sh <lock-name> [--timeout <seconds>] -- <command...>

Runs <command...> while holding the shared deployment lock <lock-name>.
Lock names: stack-<id> for one stack, host-wide for shared host resources.
The default timeout is 600 seconds; override with --timeout or
KORDI_DEPLOY_LOCK_TIMEOUT. The wrapped command's exit code is propagated.
EOF
}

lock_name=""
timeout="${KORDI_DEPLOY_LOCK_TIMEOUT:-600}"
command_arguments=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --timeout)
      if [ "$#" -lt 2 ]; then
        echo "[deploy-lock] --timeout requires a value." >&2
        exit 2
      fi
      timeout="$2"
      shift 2
      ;;
    --timeout=*)
      timeout="${1#--timeout=}"
      shift
      ;;
    --)
      shift
      command_arguments=("$@")
      break
      ;;
    -*)
      echo "[deploy-lock] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ -n "$lock_name" ]; then
        echo "[deploy-lock] Unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      lock_name="$1"
      shift
      ;;
  esac
done

if [ -z "$lock_name" ]; then
  echo "[deploy-lock] Missing lock name." >&2
  usage >&2
  exit 2
fi

if [ "${#command_arguments[@]}" -eq 0 ]; then
  echo "[deploy-lock] Missing '-- <command...>'." >&2
  usage >&2
  exit 2
fi

kordi_deploy_lock "$lock_name" "$timeout"

cleanup() {
  local status=$?
  kordi_deploy_unlock "$lock_name" >/dev/null 2>&1 || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

"${command_arguments[@]}"
