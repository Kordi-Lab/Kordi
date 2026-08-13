#!/usr/bin/env bash
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
maintenance_script="$repo_root/scripts/debug-artifact-maintenance.mjs"
child_pid=""

run_maintenance() {
  local phase="$1"
  if ! node "$maintenance_script" --auto --phase "$phase"; then
    echo "[kordi-cleanup] Artifact maintenance failed; continuing without deleting files." >&2
  fi
}

finish() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [[ -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  run_maintenance after
  exit "$exit_status"
}
trap finish EXIT INT TERM

if [[ $# -eq 0 ]]; then
  echo "[kordi-cleanup] Missing debug command." >&2
  exit 2
fi

run_maintenance before
"$@" &
child_pid=$!
wait "$child_pid"
