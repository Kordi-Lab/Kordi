#!/usr/bin/env bash

# Sourced only when the caller explicitly supplies the pinned native toolchain.
# Every cluster is fresh, user-owned, and reachable only through its private socket.
migration_pg_owned() {
  [[ "${migration_cluster:-}" =~ ^/tmp/kordi-migration-check\.[A-Za-z0-9]{6}$ ]] || return 1
  [[ -d "$migration_cluster" && -O "$migration_cluster" && ! -L "$migration_cluster" ]] || return 1
  [[ -f "$migration_cluster/owner" && -O "$migration_cluster/owner" && ! -L "$migration_cluster/owner" ]] || return 1
  local owner
  IFS= read -r owner < "$migration_cluster/owner"
  [[ "$owner" == "$$" ]] || return 1
  [[ ! -L "$migration_cluster/data" && ! -L "$migration_cluster/socket" ]] || return 1
  [[ ! -L "$migration_cluster/data/postmaster.pid" ]]
}

migration_pg_start() {
  [[ "${KORDI_MIGRATION_PG_BIN:-}" = /* && -d "$KORDI_MIGRATION_PG_BIN" ]] || return 1
  local tool
  for tool in postgres initdb pg_ctl createdb; do
    [[ -x "$KORDI_MIGRATION_PG_BIN/$tool" ]] || return 1
  done
  [[ "$("$KORDI_MIGRATION_PG_BIN/postgres" --version)" == 'postgres (PostgreSQL) 16.14' ]] || return 1
  umask 077
  migration_cluster="$(mktemp -d /tmp/kordi-migration-check.XXXXXX)"
  chmod 700 "$migration_cluster"
  printf '%s\n' "$$" > "$migration_cluster/owner"
  mkdir -m 700 "$migration_cluster/socket"
  "$KORDI_MIGRATION_PG_BIN/initdb" -D "$migration_cluster/data" -U postgres \
    --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 \
    > "$migration_cluster/init.log" 2>&1
  "$KORDI_MIGRATION_PG_BIN/pg_ctl" -D "$migration_cluster/data" \
    -l "$migration_cluster/server.log" \
    -o "-c listen_addresses='' -c unix_socket_directories='$migration_cluster/socket' -c unix_socket_permissions=0700" \
    -w -t 30 start > "$migration_cluster/start.log" 2>&1
}

migration_pg_stop() {
  [[ -n "${migration_cluster:-}" ]] || return 0
  if ! migration_pg_owned; then
    printf '%s\n' 'Refusing cleanup: migration cluster ownership could not be verified.' >&2
    return 1
  fi
  if [[ -f "$migration_cluster/data/postmaster.pid" ]]; then
    if ! "$KORDI_MIGRATION_PG_BIN/pg_ctl" -D "$migration_cluster/data" -m fast -w -t 30 stop \
      > "$migration_cluster/stop.log" 2>&1; then
      printf '%s\n' 'Migration cluster did not stop; private diagnostics and data were retained.' >&2
      return 1
    fi
  fi
  migration_pg_owned || return 1
  rm -rf -- "$migration_cluster"
  migration_cluster=
}

migration_create_database() {
  [[ "$1" =~ ^kordi_migration_test_[A-Za-z0-9_]+$ ]] || return 1
  "$KORDI_MIGRATION_PG_BIN/createdb" -h "$migration_cluster/socket" -p 5432 \
    -U postgres --maintenance-db=postgres "$1"
}

migration_database_url() {
  [[ "$1" =~ ^kordi_migration_test_[A-Za-z0-9_]+$ ]] || return 1
  printf 'postgresql://postgres@localhost:5432/%s?host=%s/socket\n' "$1" "$migration_cluster"
}
