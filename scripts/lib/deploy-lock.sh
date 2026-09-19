#!/usr/bin/env bash
#
# deploy-lock.sh — shared deployment lock helpers.
#
# Source this file, then:
#   kordi_deploy_lock <lock-name> <timeout-seconds>
#   kordi_deploy_unlock <lock-name>
#
# Lock names: stack-<id> for one stack, host-wide for shared host resources.
# Lock files live in ${KORDI_DEPLOY_LOCK_DIR:-/tmp/kordi-deploy-locks}.
#
# flock(1) is used when available. Hosts without flock (for example stock
# macOS) use a portable hardlink lock with the same interface. Both backends
# write owner metadata for diagnostics, release when the holder exits, and
# never break a live lock. Set KORDI_DEPLOY_LOCK_FORCE_PORTABLE=1 to exercise
# the portable backend on a host that has flock.

set -euo pipefail

KORDI_DEPLOY_LOCK_DIR="${KORDI_DEPLOY_LOCK_DIR:-/tmp/kordi-deploy-locks}"
KORDI_DEPLOY_LOCK_HELD="${KORDI_DEPLOY_LOCK_HELD:-}"

kordi_deploy_lock_name_valid() {
  case "${1:-}" in
    ''|*[!A-Za-z0-9._-]*|.*|-*) return 1 ;;
  esac
  return 0
}

_kordi_deploy_lock_path() {
  printf '%s/%s.lock' "$KORDI_DEPLOY_LOCK_DIR" "$1"
}

_kordi_deploy_owner_path() {
  printf '%s/%s.owner' "$KORDI_DEPLOY_LOCK_DIR" "$1"
}

_kordi_deploy_hostname() {
  hostname 2>/dev/null || uname -n 2>/dev/null || printf 'unknown'
}

_kordi_deploy_owner_metadata() {
  local name="$1"
  printf 'lock=%s\n' "$name"
  printf 'host=%s\n' "$(_kordi_deploy_hostname)"
  printf 'user=%s\n' "$(id -un 2>/dev/null || printf '%s' "${USER:-unknown}")"
  printf 'pid=%s\n' "$$"
  printf 'acquired_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}

_kordi_deploy_backend() {
  if [ "${KORDI_DEPLOY_LOCK_FORCE_PORTABLE:-0}" = "1" ]; then
    printf 'portable'
    return 0
  fi
  if command -v flock >/dev/null 2>&1; then
    printf 'flock'
  else
    printf 'portable'
  fi
}

_kordi_deploy_write_owner() {
  local name="$1" owner temp
  owner="$(_kordi_deploy_owner_path "$name")"
  temp="$(mktemp "$KORDI_DEPLOY_LOCK_DIR/.$name.owner.XXXXXX")"
  _kordi_deploy_owner_metadata "$name" >"$temp"
  mv -f "$temp" "$owner"
}

_kordi_deploy_remove_owner_if_ours() {
  local name="$1" owner pid
  owner="$(_kordi_deploy_owner_path "$name")"
  [ -f "$owner" ] || return 0
  pid="$(sed -n 's/^pid=//p' "$owner" | head -n 1)"
  if [ "$pid" = "$$" ]; then
    rm -f "$owner"
  fi
}

_kordi_deploy_free_fd() {
  local fd
  for fd in 200 201 202 203 204 205 206 207; do
    if ! eval ": >&$fd" 2>/dev/null; then
      printf '%s' "$fd"
      return 0
    fi
  done
  return 1
}

_kordi_deploy_remember_fd() {
  KORDI_DEPLOY_LOCK_HELD="${KORDI_DEPLOY_LOCK_HELD} $1:$2"
}

_kordi_deploy_fd_for() {
  local name="$1" entry
  for entry in ${KORDI_DEPLOY_LOCK_HELD}; do
    if [ "${entry%%:*}" = "$name" ]; then
      printf '%s' "${entry##*:}"
      return 0
    fi
  done
  return 1
}

_kordi_deploy_forget_fd() {
  local name="$1" entry kept=""
  for entry in ${KORDI_DEPLOY_LOCK_HELD}; do
    if [ "${entry%%:*}" = "$name" ]; then
      continue
    fi
    kept="$kept $entry"
  done
  KORDI_DEPLOY_LOCK_HELD="$kept"
}

_kordi_deploy_timeout_message() {
  local name="$1" timeout="$2" owner lockfile
  owner="$(_kordi_deploy_owner_path "$name")"
  lockfile="$(_kordi_deploy_lock_path "$name")"
  {
    printf "[deploy-lock] Timed out after %ss waiting for lock '%s'.\n" "$timeout" "$name"
    if [ -f "$owner" ]; then
      printf '[deploy-lock] Current owner metadata (%s):\n' "$owner"
      sed 's/^/  /' "$owner"
    else
      printf '[deploy-lock] No owner metadata found at %s.\n' "$owner"
    fi
    printf '[deploy-lock] Wait for the owner to finish and retry, or coordinate with the owner above.\n'
    printf '[deploy-lock] Do not delete %s while its owner is alive.\n' "$lockfile"
  } >&2
}

_kordi_deploy_lock_flock() {
  local name="$1" timeout="$2" lockfile="$3" fd acquired=1
  fd="$(_kordi_deploy_free_fd)" || {
    printf "[deploy-lock] No free file descriptor available for lock '%s'.\n" "$name" >&2
    return 1
  }
  eval "exec ${fd}>\"\${lockfile}\""
  if [ "$timeout" -eq 0 ]; then
    if flock -n "$fd" 2>/dev/null; then acquired=0; fi
  else
    if flock -w "$timeout" "$fd" 2>/dev/null; then acquired=0; fi
  fi
  if [ "$acquired" -ne 0 ]; then
    eval "exec ${fd}>&-"
    _kordi_deploy_timeout_message "$name" "$timeout"
    return 1
  fi
  _kordi_deploy_remember_fd "$name" "$fd"
  _kordi_deploy_write_owner "$name"
  printf "[deploy-lock] Acquired '%s' (backend=flock, timeout=%ss).\n" "$name" "$timeout" >&2
  return 0
}

_kordi_deploy_owner_content_is_stale() {
  local content="$1" host pid
  host="$(printf '%s\n' "$content" | sed -n 's/^host=//p' | head -n 1)"
  pid="$(printf '%s\n' "$content" | sed -n 's/^pid=//p' | head -n 1)"
  if [ -z "$host" ] || [ -z "$pid" ]; then
    return 0
  fi
  [ "$host" = "$(_kordi_deploy_hostname)" ] || return 1
  case "$pid" in
    *[!0-9]*) return 1 ;;
  esac
  if ps -p "$pid" >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

_kordi_deploy_break_stale_lock() {
  local lockfile="$1" expected="$2" candidate="$1.stale.$$"
  rm -f "$candidate"
  mv "$lockfile" "$candidate" 2>/dev/null || return 1
  if [ "$(cat "$candidate" 2>/dev/null)" = "$expected" ]; then
    rm -f "$candidate"
    return 0
  fi
  ln "$candidate" "$lockfile" 2>/dev/null || true
  rm -f "$candidate"
  return 1
}

_kordi_deploy_lock_portable() {
  local name="$1" timeout="$2" lockfile="$3" temp content start now
  temp="$(mktemp "$KORDI_DEPLOY_LOCK_DIR/.$name.lock.XXXXXX")"
  _kordi_deploy_owner_metadata "$name" >"$temp"
  start="$(date +%s)"
  while :; do
    if ln "$temp" "$lockfile" 2>/dev/null; then
      rm -f "$temp"
      _kordi_deploy_write_owner "$name"
      printf "[deploy-lock] Acquired '%s' (backend=portable, timeout=%ss).\n" "$name" "$timeout" >&2
      return 0
    fi
    content="$(cat "$lockfile" 2>/dev/null || true)"
    if _kordi_deploy_owner_content_is_stale "$content"; then
      if _kordi_deploy_break_stale_lock "$lockfile" "$content"; then
        continue
      fi
    fi
    now="$(date +%s)"
    if [ "$timeout" -eq 0 ] || [ $((now - start)) -gt "$timeout" ]; then
      rm -f "$temp"
      _kordi_deploy_timeout_message "$name" "$timeout"
      return 1
    fi
    sleep 0.2
  done
}

kordi_deploy_lock() {
  local name="${1:-}" timeout="${2:-}"
  if ! kordi_deploy_lock_name_valid "$name"; then
    printf "[deploy-lock] Invalid lock name '%s'. Use 'stack-<id>' or 'host-wide'.\n" "$name" >&2
    return 2
  fi
  case "$timeout" in
    ''|*[!0-9]*)
      printf "[deploy-lock] Timeout must be a non-negative integer number of seconds (got '%s').\n" "$timeout" >&2
      return 2
      ;;
  esac
  mkdir -p "$KORDI_DEPLOY_LOCK_DIR"
  if [ "$(_kordi_deploy_backend)" = "flock" ]; then
    _kordi_deploy_lock_flock "$name" "$timeout" "$(_kordi_deploy_lock_path "$name")"
  else
    _kordi_deploy_lock_portable "$name" "$timeout" "$(_kordi_deploy_lock_path "$name")"
  fi
}

kordi_deploy_unlock() {
  local name="${1:-}" fd lockfile owner_pid
  if ! kordi_deploy_lock_name_valid "$name"; then
    printf "[deploy-lock] Invalid lock name '%s'.\n" "$name" >&2
    return 2
  fi
  if [ "$(_kordi_deploy_backend)" = "flock" ]; then
    if fd="$(_kordi_deploy_fd_for "$name")"; then
      flock -u "$fd" 2>/dev/null || true
      eval "exec ${fd}>&-"
      _kordi_deploy_forget_fd "$name"
      _kordi_deploy_remove_owner_if_ours "$name"
      printf "[deploy-lock] Released '%s'.\n" "$name" >&2
    fi
    return 0
  fi
  lockfile="$(_kordi_deploy_lock_path "$name")"
  if [ -f "$lockfile" ]; then
    owner_pid="$(sed -n 's/^pid=//p' "$lockfile" | head -n 1)"
    if [ "$owner_pid" = "$$" ]; then
      rm -f "$lockfile"
      _kordi_deploy_remove_owner_if_ours "$name"
      printf "[deploy-lock] Released '%s'.\n" "$name" >&2
      return 0
    fi
    printf "[deploy-lock] Refusing to release '%s': lock is owned by pid %s.\n" "$name" "${owner_pid:-unknown}" >&2
    return 1
  fi
  return 0
}
