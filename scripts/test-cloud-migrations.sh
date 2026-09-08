#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Synthetic data only. Never reuse DATABASE_URL or an existing database.
unset DATABASE_URL KORDI_MIGRATION_TEST_DATABASE_URL
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGOPTIONS
container_id=
if [[ -n "${KORDI_MIGRATION_PG_BIN:-}" ]]; then
  source scripts/lib/native-migration-postgres.sh
fi
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "${KORDI_MIGRATION_PG_BIN:-}" ]]; then
    migration_pg_stop || result=1
  elif [[ -n "$container_id" && "$(docker inspect --format '{{index .Config.Labels "kordi.task"}}' "$container_id" 2>/dev/null || true)" == synthetic-migration-check ]]; then
    docker rm -f "$container_id" >/dev/null
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
if [[ -n "${KORDI_MIGRATION_PG_BIN:-}" ]]; then
  migration_pg_start
else
  container_id="$(docker run --rm -d --label kordi.task=synthetic-migration-check \
    -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:16.14-alpine)"
  [[ "$container_id" =~ ^[a-f0-9]{64}$ ]]
  for attempt in {1..30}; do
    if docker exec "$container_id" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec "$container_id" pg_isready -U postgres >/dev/null
  port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container_id")"
  [[ "$port" =~ ^[0-9]+$ ]]
  migration_create_database() { docker exec "$container_id" createdb -U postgres "$1"; }
  migration_database_url() { printf 'postgresql://postgres@127.0.0.1:%s/%s\n' "$port" "$1"; }
fi
tests=(
  upgrade_from_75_preserves_history_and_new_identity_guards
  upgrade_from_digest_76_preserves_existing_report_and_calendar
  upgrade_from_88_retains_old_and_new_upsert_compatibility
  multiple_live_executors_require_drain_without_losing_history
  title_tests::upgrade_from_75_preserves_shared_and_private_group_names
  title_tests::upgrade_from_89_repairs_only_proven_defaults_and_authenticated_titles
)
index=0
for test_name in "${tests[@]}"; do
  index=$((index+1))
  database="kordi_migration_test_${index}"
  migration_create_database "$database"
  KORDI_MIGRATION_TEST_DATABASE_URL="$(migration_database_url "$database")" \
    cargo test -p kordi-cloud-server --lib "pg::pool::upgrade_tests::${test_name}" -- --ignored --exact
done
migration_create_database kordi_migration_test_runtime
# These existing suites perform global retention/quarantine operations on their
# shared fixture. Serialize them so one test cannot sweep another test's rows.
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e --test chat_sync_e2e -- --test-threads=1
