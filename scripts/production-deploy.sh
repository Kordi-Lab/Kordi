#!/usr/bin/env bash
#
# production-deploy.sh — protected production deployment wrapper.
#
# Acquires the shared host-wide deployment lock through
# scripts/with-deploy-lock.sh, validates the approved inputs with
# scripts/production-deploy-guard.mjs, deploys the exact revision through the
# existing operator scripts in an isolated per-deployment directory, verifies
# the immutable artifact digest plus rollout/health/smoke checks, and records
# the outcome before the lock is released.
#
# Usage:
#   scripts/production-deploy.sh \
#     --sha <40-hex> \
#     --artifact <sha256:<hex>|<reference>@sha256:<hex>> \
#     --backup <identifier> \
#     --rollback-plan <summary> \
#     --schema-compatibility <statement> \
#     --actor <login> \
#     --project <gcp-project> \
#     --zone <gcp-zone> \
#     --ssh-target <gcloud-ssh-target> \
#     [--workflow <url>] [--stack production-main] [--source-root <path>] \
#     [--public-origin https://kordi.ai] \
#     [--record-dir <path>] [--run-id <id>] [--lock-timeout <seconds>] \
#     [--dry-run]
#
# Environment identifiers are required explicitly and are never inherited from
# an ambient gcloud configuration. The source tree at --source-root must be
# checked out at exactly --sha; the wrapper verifies that before syncing.
# --dry-run validates inputs and prints the exact commands without acquiring
# the lock or touching the host.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="$script_dir/$(basename "${BASH_SOURCE[0]}")"
repo_root="$(cd "$script_dir/.." && pwd)"
guard_script="$script_dir/production-deploy-guard.mjs"
record_script="$script_dir/record-deployment.mjs"
lock_script="$script_dir/with-deploy-lock.sh"
original_arguments=("$@")

usage() {
  cat <<'EOF'
Usage:
  scripts/production-deploy.sh \
    --sha <40-hex> \
    --artifact <sha256:<hex>|<reference>@sha256:<hex>> \
    --backup <identifier> \
    --rollback-plan <summary> \
    --schema-compatibility <statement> \
    --actor <login> \
    --project <gcp-project> \
    --zone <gcp-zone> \
    --ssh-target <gcloud-ssh-target> \
    [--workflow <url>] [--stack production-main] [--source-root <path>] \
    [--public-origin https://kordi.ai] \
    [--record-dir <path>] [--run-id <id>] [--lock-timeout <seconds>] \
    [--dry-run]

Requires explicit environment identifiers; it never inherits an ambient
gcloud project or zone. The source tree at --source-root must be checked out
at exactly --sha. --dry-run prints the lock acquisition, revision check,
operator commands, verification, and record commands without executing host
commands.
EOF
}

sha=""
artifact=""
backup=""
rollback_plan=""
schema_compatibility=""
actor=""
workflow=""
confirm=""
stack="production-main"
source_root="$repo_root"
project=""
zone=""
ssh_target=""
public_origin="https://kordi.ai"
record_dir="$repo_root/deploy/deployment-records"
run_id=""
lock_timeout="${KORDI_PRODUCTION_DEPLOY_LOCK_TIMEOUT:-1800}"
dry_run="0"

while [ "$#" -gt 0 ]; do
  argument="$1"
  case "$argument" in
    --help|-h)
      usage
      exit 0
      ;;
    --dry-run)
      dry_run="1"
      shift
      ;;
    --sha=*) sha="${argument#--sha=}"; shift ;;
    --artifact=*) artifact="${argument#--artifact=}"; shift ;;
    --backup=*) backup="${argument#--backup=}"; shift ;;
    --rollback-plan=*) rollback_plan="${argument#--rollback-plan=}"; shift ;;
    --schema-compatibility=*) schema_compatibility="${argument#--schema-compatibility=}"; shift ;;
    --actor=*) actor="${argument#--actor=}"; shift ;;
    --workflow=*) workflow="${argument#--workflow=}"; shift ;;
    --confirm=*) confirm="${argument#--confirm=}"; shift ;;
    --stack=*) stack="${argument#--stack=}"; shift ;;
    --source-root=*) source_root="${argument#--source-root=}"; shift ;;
    --project=*) project="${argument#--project=}"; shift ;;
    --zone=*) zone="${argument#--zone=}"; shift ;;
    --ssh-target=*) ssh_target="${argument#--ssh-target=}"; shift ;;
    --public-origin=*) public_origin="${argument#--public-origin=}"; shift ;;
    --record-dir=*) record_dir="${argument#--record-dir=}"; shift ;;
    --run-id=*) run_id="${argument#--run-id=}"; shift ;;
    --lock-timeout=*) lock_timeout="${argument#--lock-timeout=}"; shift ;;
    --sha) sha="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --artifact) artifact="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --backup) backup="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --rollback-plan) rollback_plan="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --schema-compatibility) schema_compatibility="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --actor) actor="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --workflow) workflow="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --confirm) confirm="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --stack) stack="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --source-root) source_root="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --project) project="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --zone) zone="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --ssh-target) ssh_target="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --public-origin) public_origin="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --record-dir) record_dir="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --run-id) run_id="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --lock-timeout) lock_timeout="${2:-}"; shift; [ "$#" -gt 0 ] && shift || true ;;
    --)
      shift
      ;;
    -*)
      echo "[production-deploy] Unknown option: $argument" >&2
      usage >&2
      exit 2
      ;;
    *)
      echo "[production-deploy] Unexpected argument: $argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_value() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "[production-deploy] $name is required." >&2
    exit 2
  fi
}

require_value "--sha" "$sha"
require_value "--artifact" "$artifact"
require_value "--backup" "$backup"
require_value "--rollback-plan" "$rollback_plan"
require_value "--schema-compatibility" "$schema_compatibility"
require_value "--actor" "$actor"
require_value "--project" "$project"
require_value "--zone" "$zone"
require_value "--ssh-target" "$ssh_target"

case "$lock_timeout" in
  ''|*[!0-9]*)
    echo "[production-deploy] --lock-timeout must be a non-negative integer number of seconds." >&2
    exit 2
    ;;
esac

sha_short="${sha:0:12}"
if [ -z "$run_id" ]; then
  run_id="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
fi
case "$run_id" in
  *[!A-Za-z0-9._-]*)
    echo "[production-deploy] --run-id must contain only letters, digits, '.', '_', and '-'." >&2
    exit 2
    ;;
esac

deployment_id="${sha_short}-${run_id}"
image_tag="prod-${deployment_id}"
image_ref="docker.io/library/kordi-cloud-server:${image_tag}"

case "$artifact" in
  sha256:*) expected_digest="$artifact" ;;
  *@sha256:*) expected_digest="sha256:${artifact##*@sha256:}" ;;
  *) expected_digest="" ;;
esac

display_arg() {
  case "$1" in
    ''|*[!A-Za-z0-9_./:=@%,+-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

display_command() {
  local first="1"
  local argument
  for argument in "$@"; do
    if [ "$first" = "1" ]; then
      first="0"
    else
      printf ' '
    fi
    display_arg "$argument"
  done
  printf '\n'
}

dry_run_echo() {
  printf '+ '
  display_command "$@"
}

guard_arguments=(
  --sha "$sha"
  --artifact "$artifact"
  --backup "$backup"
  --rollback-plan "$rollback_plan"
  --schema-compatibility "$schema_compatibility"
  --actor "$actor"
  --stack "$stack"
  --environment production
)
if [ -n "$workflow" ]; then
  guard_arguments+=(--workflow "$workflow")
fi
if [ -n "$confirm" ]; then
  guard_arguments+=(--confirm "$confirm")
fi

if ! node "$guard_script" "${guard_arguments[@]}" >/dev/null; then
  echo "[production-deploy] Input validation failed; no deployment was attempted." >&2
  exit 1
fi

lock_command=(
  "$lock_script" host-wide --timeout "$lock_timeout" --
  env KORDI_PRODUCTION_DEPLOY_LOCKED=1
  "$script_path" "${original_arguments[@]}"
)

if [ "$dry_run" = "1" ]; then
  echo "[production-deploy] dry run: validating inputs only; no lock is acquired and no host command is executed."
  echo "[production-deploy] step 1: acquire the shared host-wide deployment lock"
  dry_run_echo "${lock_command[@]}"
elif [ "${KORDI_PRODUCTION_DEPLOY_LOCKED:-0}" != "1" ]; then
  exec "${lock_command[@]}"
fi

work_dir=""
plan_file=""
verification_file=""
recorded="0"
validated="0"

finalize() {
  local status=$?
  if [ "$status" -ne 0 ] && [ "$dry_run" != "1" ] && [ "$validated" = "1" ] && [ "$recorded" != "1" ]; then
    {
      printf 'deployment failed with status %s before verification completed\n' "$status"
    } >>"$verification_file" 2>/dev/null || true
    node "$record_script" \
      --environment production \
      --stack "$stack" \
      --sha "$sha" \
      --actor "$actor" \
      --artifact "$artifact" \
      --backup "$backup" \
      --verification "$verification_file" \
      --rollback "not exercised; deployment failed; follow the recorded rollback plan" \
      --out "$record_dir" >/dev/null 2>&1 || true
  fi
  if [ "$dry_run" != "1" ] && [ -d "$work_dir" ]; then
    rm -rf "$work_dir"
  fi
  exit "$status"
}

trap finalize EXIT

if [ "$dry_run" = "1" ]; then
  work_dir="${TMPDIR:-/tmp}/kordi-production-deploy-${deployment_id}"
  plan_file="$work_dir/production-deploy-plan.json"
  verification_file="$work_dir/verification.txt"
else
  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/kordi-production-deploy-${deployment_id}.XXXXXX")"
  plan_file="$work_dir/production-deploy-plan.json"
  verification_file="$work_dir/verification.txt"
  : >"$verification_file"
  validated="1"
fi

echo "[production-deploy] step 2: write the deterministic deployment plan"
plan_command=(node "$guard_script" "${guard_arguments[@]}" --out "$plan_file")
if [ "$dry_run" = "1" ]; then
  dry_run_echo "${plan_command[@]}"
else
  "${plan_command[@]}" >/dev/null
fi

echo "[production-deploy] step 3: verify the source tree is checked out at the approved revision"
source_revision_command=(git -C "$source_root" rev-parse HEAD)
if [ "$dry_run" = "1" ]; then
  dry_run_echo "${source_revision_command[@]}"
else
  source_revision="$("${source_revision_command[@]}" 2>/dev/null || true)"
  if [ "$source_revision" != "$sha" ]; then
    echo "[production-deploy] Source tree ${source_root} is at ${source_revision:-an unknown revision}, not the approved ${sha}; refusing to sync a different revision." >&2
    exit 1
  fi
fi

echo "[production-deploy] step 4: resolve the isolated deployment directory on the production host"
remote_home_command=(gcloud compute ssh "$ssh_target" --zone "$zone" --project "$project" --command "printf '%s' \"\$HOME\"")
if [ "$dry_run" = "1" ]; then
  dry_run_echo "${remote_home_command[@]}"
  remote_home="\$HOME"
else
  remote_home="$("${remote_home_command[@]}")"
  if [ -z "$remote_home" ]; then
    echo "[production-deploy] Could not resolve the remote home directory; refusing to inherit a mutable path." >&2
    exit 1
  fi
fi
remote_dir="${remote_home}/kordi-cloud-server-deploy/prod-${deployment_id}"

export KORDI_CLOUD_SSH_TARGET="$ssh_target"
export KORDI_CLOUD_SSH_ZONE="$zone"
export KORDI_CLOUD_GCP_PROJECT="$project"
export KORDI_CLOUD_REMOTE_DIR="$remote_dir"
export KORDI_CLOUD_IMAGE_TAG="$image_tag"

echo "[production-deploy] deployment id:   ${deployment_id}"
echo "[production-deploy] remote dir:      ${remote_dir} (isolated per deployment)"
echo "[production-deploy] image tag:       ${image_ref}"
echo "[production-deploy] expected digest: ${expected_digest:-unknown}"

if [ "$dry_run" != "1" ]; then
  printf 'schema-compatibility: %s\n' "$schema_compatibility" >>"$verification_file"
  printf 'rollback-plan: %s\n' "$rollback_plan" >>"$verification_file"
fi

echo "[production-deploy] step 5: verify the approved artifact is present in the host image store"
presence_command=(gcloud compute ssh "$ssh_target" --zone "$zone" --project "$project" --command
  "sudo k3s ctr images ls | awk -v digest='${expected_digest}' '\$3 == digest { found = 1 } END { if (found) print digest }'")
if [ "$dry_run" = "1" ]; then
  dry_run_echo "${presence_command[@]}"
else
  present_digest="$("${presence_command[@]}")"
  if [ "$present_digest" != "$expected_digest" ]; then
    echo "[production-deploy] Approved artifact ${expected_digest} is not present in the host image store; build and import it through the trusted build path before deploying." >&2
    exit 1
  fi
  printf 'artifact-present: %s\n' "$present_digest" >>"$verification_file"
fi

echo "[production-deploy] step 6: sync the exact revision and build on the production host"
sync_command=(bash "$source_root/bridges/cloud-server/deploy/sync-and-build.sh")
if [ "$dry_run" = "1" ]; then
  printf '+ KORDI_CLOUD_SSH_TARGET=%s KORDI_CLOUD_SSH_ZONE=%s KORDI_CLOUD_GCP_PROJECT=%s KORDI_CLOUD_REMOTE_DIR=%s ' \
    "$(display_arg "$ssh_target")" "$(display_arg "$zone")" "$(display_arg "$project")" "$(display_arg "$remote_dir")"
  display_command "${sync_command[@]}"
else
  "${sync_command[@]}"
fi

echo "[production-deploy] step 7: build, import, and apply the deployment through the operator script"
deploy_command=(bash "$source_root/bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh")
if [ "$dry_run" = "1" ]; then
  printf '+ KORDI_CLOUD_SSH_TARGET=%s KORDI_CLOUD_SSH_ZONE=%s KORDI_CLOUD_GCP_PROJECT=%s KORDI_CLOUD_REMOTE_DIR=%s KORDI_CLOUD_IMAGE_TAG=%s ' \
    "$(display_arg "$ssh_target")" "$(display_arg "$zone")" "$(display_arg "$project")" "$(display_arg "$remote_dir")" "$(display_arg "$image_tag")"
  display_command "${deploy_command[@]}"
else
  "${deploy_command[@]}"
fi

echo "[production-deploy] step 8: verify the deployed image matches the approved immutable digest"
digest_command=(gcloud compute ssh "$ssh_target" --zone "$zone" --project "$project" --command
  "sudo k3s ctr images ls | awk -v ref='${image_ref}' '\$1 == ref { print \$3 }' | head -n 1")
if [ "$dry_run" = "1" ]; then
  dry_run_echo "${digest_command[@]}"
else
  resolved_digest="$("${digest_command[@]}")"
  if [ -z "$resolved_digest" ]; then
    echo "[production-deploy] No image digest found for ${image_ref}; failing closed." >&2
    exit 1
  fi
  if [ "$resolved_digest" != "$expected_digest" ]; then
    echo "[production-deploy] Deployed digest ${resolved_digest} does not match the approved artifact ${expected_digest}; failing closed and following the recorded rollback plan." >&2
    exit 1
  fi
  printf 'artifact-digest: %s\n' "$resolved_digest" >>"$verification_file"
fi

echo "[production-deploy] step 9: verify the rollout"
rollout_command=(gcloud compute ssh "$ssh_target" --zone "$zone" --project "$project" --command
  "kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s")
if [ "$dry_run" = "1" ]; then
  dry_run_echo "${rollout_command[@]}"
else
  "${rollout_command[@]}"
  printf 'rollout: ok\n' >>"$verification_file"
fi

echo "[production-deploy] step 10: verify health through the cluster"
health_command=(gcloud compute ssh "$ssh_target" --zone "$zone" --project "$project" --command
  "curl --fail --silent --show-error --max-time 5 http://127.0.0.1:30081/health >/dev/null")
if [ "$dry_run" = "1" ]; then
  dry_run_echo "${health_command[@]}"
else
  "${health_command[@]}"
  printf 'health-cluster: ok\n' >>"$verification_file"
fi

echo "[production-deploy] step 11: verify the public origin smoke check"
smoke_command=(curl --fail --silent --show-error --max-time 20 "${public_origin%/}/health")
if [ "$dry_run" = "1" ]; then
  dry_run_echo "${smoke_command[@]}"
else
  "${smoke_command[@]}" >/dev/null
  printf 'health-origin: ok (%s)\n' "$public_origin" >>"$verification_file"
fi

echo "[production-deploy] step 12: record the deployment outcome"
record_command=(
  node "$record_script"
  --environment production
  --stack "$stack"
  --sha "$sha"
  --actor "$actor"
  --artifact "$expected_digest"
  --backup "$backup"
  --verification "$verification_file"
  --rollback "not exercised; rollback plan recorded in the deployment plan"
  --out "$record_dir"
)
if [ -n "$workflow" ]; then
  record_command+=(--workflow "$workflow")
fi
if [ "$dry_run" = "1" ]; then
  dry_run_echo mkdir -p "$record_dir"
  dry_run_echo "${record_command[@]}"
else
  mkdir -p "$record_dir"
  "${record_command[@]}"
  recorded="1"
fi

echo "[production-deploy] done. revision=${sha} artifact=${expected_digest} lock=host-wide"
