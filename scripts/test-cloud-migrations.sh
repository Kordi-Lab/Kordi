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
    if docker exec "$container_id" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec "$container_id" pg_isready -h 127.0.0.1 -U postgres >/dev/null
  port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container_id")"
  [[ "$port" =~ ^[0-9]+$ ]]
  migration_create_database() { docker exec "$container_id" createdb -U postgres "$1"; }
  migration_database_url() { printf 'postgresql://postgres@127.0.0.1:%s/%s\n' "$port" "$1"; }
fi
tests=(
  signup_email_tests::upgrade_from_109_preserves_existing_accounts_without_certifying_email
  pin_stack_tests::upgrade_from_107_preserves_pins_and_rolling_writes
  projection_tests::upgrade_from_98_backfills_projection_and_system_agent_context_boundaries
  upgrade_from_91_retains_pin_actions_and_captures_rolling_writes
  upgrade_from_75_preserves_history_and_new_identity_guards
  upgrade_from_digest_76_preserves_existing_report_and_calendar
  upgrade_from_88_retains_old_and_new_upsert_compatibility
  multiple_live_executors_require_drain_without_losing_history
  title_tests::upgrade_from_75_preserves_shared_and_private_group_names
  title_tests::upgrade_from_89_repairs_only_proven_defaults_and_authenticated_titles
  email_verification_tests::upgrade_from_110_marks_only_provider_verified_primary_emails
  account_email_tests::upgrade_from_112_adds_account_email_codes
  connectors_tests::upgrade_from_113_adds_connectors_without_touching_accounts
  connectors_tests::upgrade_from_114_labels_existing_runs_as_background
  connectors_tests::upgrade_from_115_adds_provider_state_and_dedupes_events
  connectors_tests::upgrade_from_116_labels_existing_runs_as_shared
  document_share_tests::upgrade_from_121_adds_document_shares
  document_share_tests::upgrade_from_122_adds_document_contents
  document_share_tests::upgrade_from_123_adds_document_sources
  document_share_tests::upgrade_from_124_relaxes_block_ids
  document_share_tests::upgrade_from_125_adds_document_collab
  document_share_tests::upgrade_from_126_adds_document_agent_runs
  document_share_tests::upgrade_from_127_adds_desktop_preference
  document_share_tests::upgrade_from_128_adds_document_title
  common_ground_tests::upgrade_from_133_adds_common_ground
  common_ground_tests::upgrade_from_136_adds_matching_runs_and_room_themes
  common_ground_tests::upgrade_from_137_adds_room_invitations
  common_ground_tests::upgrade_from_138_adds_group_topics
  account_handle_tests::upgrade_from_139_adds_account_handles
  account_handle_tests::upgrade_from_140_adds_profile_fields
  common_ground_tests::upgrade_from_141_adds_profiles
  common_ground_tests::upgrade_from_142_adds_group_intros
  common_ground_tests::upgrade_from_143_adds_profile_design
  common_ground_tests::upgrade_from_144_adds_profile_icon
  common_ground_tests::upgrade_from_145_widens_profile_designs
  common_ground_daily_tests::upgrade_from_146_renames_daily_profiles
  common_ground_sources_tests::upgrade_from_146_adds_profile_sources
  agent_avatar_tests::upgrade_from_148_accepts_bird_avatar_style
  memory_tests::upgrade_from_149_adds_memory_categories
  memory_tests::upgrade_from_150_adds_memory_card_overrides
  proactive_tests::upgrade_from_153_adds_proactive_agents
  proactive_tests::upgrade_from_154_counts_evaluation_memory_searches
  common_ground_nearby_tests::upgrade_from_155_adds_common_ground_nearby
  personal_agent_tests::upgrade_from_156_adds_personal_agents
  personal_agent_tests::upgrade_from_157_indexes_personal_agent_reads
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
# Connector acceptance tests need a database; their fixture fails in CI when
# DATABASE_URL is missing, so they cannot pass by skipping.
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --lib connectors:: -- --test-threads=1
# Shared document tests follow the same rule.
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --lib document_shares:: -- --test-threads=1
# Common ground tests follow the same rule.
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --lib common_ground:: -- --test-threads=1
# Contact profile and removal tests (#1945) use the Common ground fixture.
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --lib auth::routes::contact_profile:: -- --test-threads=1
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --lib auth::routes::contact_removal:: -- --test-threads=1
# Agent avatar tests (docs/avatar-system.md) use the Common ground fixture.
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --lib avatars::agent_avatar_db_tests:: -- --test-threads=1
# Proactive agent tests (docs/development/proactive-agent.md) follow the same rule.
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --lib proactive:: -- --test-threads=1
# Personal agent tests (docs/development/personal-agent.md) follow the same rule.
DATABASE_URL="$(migration_database_url kordi_migration_test_runtime)" \
  cargo test -p kordi-cloud-server --lib personal_agent:: -- --test-threads=1
