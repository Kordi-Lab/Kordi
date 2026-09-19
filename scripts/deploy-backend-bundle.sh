#!/usr/bin/env bash
# Transport only: mutation, locking, validation, and records run on the target host.
set -euo pipefail
environment="${1:?Pass dev or production}"
bundle="${2:?Pass the verified bundle directory}"
sha="${3:?Pass the tested revision}"
run_id="${4:?Pass the build run ID}"
case "$environment" in dev|production) ;; *) exit 2 ;; esac
[[ "$sha" =~ ^[0-9a-f]{40}$ && "$run_id" =~ ^[1-9][0-9]*$ ]] || exit 2
for key in KORDI_BACKEND_PROJECT KORDI_BACKEND_ZONE KORDI_BACKEND_TARGET KORDI_BACKEND_STATE KORDI_BACKEND_LOCK_DIR; do
  [ -n "${!key:-}" ] || { echo "Missing environment secret: $key" >&2; exit 2; }
done
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundle="$(cd "$bundle" && pwd)"
python3 "$root/scripts/backend_artifact.py" verify --directory "$bundle" --sha "$sha" --run-id "$run_id"
ssh=(gcloud compute ssh "$KORDI_BACKEND_TARGET" --project "$KORDI_BACKEND_PROJECT" --zone "$KORDI_BACKEND_ZONE" --tunnel-through-iap --quiet)
scp=(gcloud compute scp --project "$KORDI_BACKEND_PROJECT" --zone "$KORDI_BACKEND_ZONE" --tunnel-through-iap --quiet)
raw_log="$(mktemp)"
key_file=""
if [ -n "${KORDI_BACKEND_SSH_KEY:-}" ]; then
  : "${KORDI_BACKEND_SSH_USER:?Missing dedicated SSH user}"
  key_file="$(mktemp)"
  chmod 600 "$key_file"
  printf '%s\n' "$KORDI_BACKEND_SSH_KEY" > "$key_file"
  ssh=(gcloud compute ssh "$KORDI_BACKEND_SSH_USER@$KORDI_BACKEND_TARGET" --project "$KORDI_BACKEND_PROJECT" --zone "$KORDI_BACKEND_ZONE" --tunnel-through-iap --quiet --plain --strict-host-key-checking=no
    --ssh-flag="-i $key_file" --ssh-flag='-o IdentitiesOnly=yes' --ssh-flag='-o StrictHostKeyChecking=accept-new')
  scp+=(--plain --strict-host-key-checking=no --scp-flag=-i --scp-flag="$key_file" --scp-flag=-oIdentitiesOnly=yes --scp-flag=-oStrictHostKeyChecking=accept-new)
  KORDI_BACKEND_TARGET="$KORDI_BACKEND_SSH_USER@$KORDI_BACKEND_TARGET"
fi
remote=""
cleanup() {
  local status=$?
  if [[ "$remote" =~ ^/tmp/kordi-backend\.[a-zA-Z0-9]+$ ]]; then
    "${ssh[@]}" --command "rm -rf -- '$remote'" >>"$raw_log" 2>&1 || true
  fi
  rm -f "$raw_log"
  if [ -n "$key_file" ]; then rm -f "$key_file"; fi
  if [ "$status" -ne 0 ]; then
    echo 'Backend deployment failed. Inspect the private host deployment records; raw infrastructure logs are not published.' >&2
  fi
  exit "$status"
}
trap 'cleanup' EXIT
remote="$("${ssh[@]}" --command 'umask 077; mktemp -d /tmp/kordi-backend.XXXXXXXX' 2>"$raw_log")"
[[ "$remote" =~ ^/tmp/kordi-backend\.[a-zA-Z0-9]+$ ]] || exit 1
"${scp[@]}" --recurse "$bundle" "$KORDI_BACKEND_TARGET:$remote/bundle" >>"$raw_log" 2>&1
files=("$root/scripts/backend_artifact.py" "$root/scripts/backend_deploy_common.py")
arguments=(python3 "$remote/backend_deploy_dev.py" --bundle "$remote/bundle" --sha "$sha" --run-id "$run_id" --state "$KORDI_BACKEND_STATE")
if [ "$environment" = dev ]; then
  : "${KORDI_BACKEND_API_PORT:?Missing development API port}"
  : "${KORDI_BACKEND_COMPOSE_PROJECT:?Missing development Compose project}"
  : "${KORDI_BACKEND_ENV_FILE:?Missing isolated development environment file}"
  files+=("$root/scripts/backend_deploy_dev.py" "$root/deploy/dev/compose.yaml")
  arguments+=(--api-port "$KORDI_BACKEND_API_PORT" --project "$KORDI_BACKEND_COMPOSE_PROJECT" --env-file "$KORDI_BACKEND_ENV_FILE" --compose "$remote/compose.yaml")
else
  : "${KORDI_BACKEND_BACKUP_ROOT:?Missing protected backup directory}"
  : "${KORDI_BACKEND_BACKUP_ID:?Missing verified backup identifier}"
  : "${KORDI_BACKEND_SCHEMA_COMPATIBILITY:?Missing schema compatibility declaration}"
  files+=("$root/scripts/backend_deploy_production.py" "$root/scripts/backend_backup.py" "$root/scripts/backend_backup_create.py")
  arguments=(python3 "$remote/backend_deploy_production.py" --bundle "$remote/bundle" --sha "$sha" --run-id "$run_id"
    --state "$KORDI_BACKEND_STATE" --backup-root "$KORDI_BACKEND_BACKUP_ROOT" --backup-id "$KORDI_BACKEND_BACKUP_ID"
    --schema-compatibility "$KORDI_BACKEND_SCHEMA_COMPATIBILITY")
fi
"${scp[@]}" "${files[@]}" "$KORDI_BACKEND_TARGET:$remote/" >>"$raw_log" 2>&1
arguments+=(--lock-dir "$KORDI_BACKEND_LOCK_DIR")
printf -v command '%q ' "${arguments[@]}"
status=0
"${ssh[@]}" --command "umask 077; $command" >>"$raw_log" 2>&1 || status=$?
# The result contains only public revision/digest identifiers and outcomes.
"${scp[@]}" "$KORDI_BACKEND_TARGET:$remote/bundle/deployment-result.json" "$bundle/deployment-result.json" >>"$raw_log" 2>&1 || true
exit "$status"
