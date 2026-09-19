#!/usr/bin/env bash
#
# dev-deploy-stack.sh — deploy one allocated development stack over the shared
# IAP transport.
#
# Usage:
#   scripts/dev-deploy-stack.sh deploy --stack <id> --sha <full-40-char-sha> [--dry-run]
#   scripts/dev-deploy-stack.sh smoke --stack <id> [--dry-run]
#   scripts/dev-deploy-stack.sh cleanup --stack <id> --confirm-stack <id> [--dry-run]
#
# The script reuses scripts/dev-cloud-up.sh, scripts/dev-cloud-smoke.sh, and
# scripts/with-deploy-lock.sh on the development host. It never reads gcloud
# defaults: project, zone, instance, stack root, compose project, and ports must
# be provided explicitly through the environment. See docs/dev-deployment.md.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock_helper="$repo_root/scripts/with-deploy-lock.sh"
lock_library="$repo_root/scripts/lib/deploy-lock.sh"
default_lock_timeout=1800

command_name=""
stack=""
sha=""
confirm_stack=""
dry_run="false"
lock_timeout="${KORDI_DEV_LOCK_TIMEOUT:-$default_lock_timeout}"

usage() {
  cat <<'EOF'
Usage:
  scripts/dev-deploy-stack.sh deploy --stack <id> --sha <full-40-char-sha> [--dry-run]
  scripts/dev-deploy-stack.sh smoke --stack <id> [--dry-run]
  scripts/dev-deploy-stack.sh cleanup --stack <id> --confirm-stack <id> [--dry-run]

Subcommands:
  deploy   Fetch the requested revision into the stack's own checkout and run
           scripts/dev-cloud-up.sh on the development host.
  smoke    Run scripts/dev-cloud-smoke.sh against the stack's own checkout.
  cleanup  Stop the stack's own Compose project. Requires --confirm-stack <id>
           and never removes volumes.

Required explicit environment (no inherited gcloud defaults):
  KORDI_DEV_GCP_PROJECT, KORDI_DEV_SSH_ZONE, KORDI_DEV_SSH_TARGET,
  KORDI_DEV_STACK_ROOT, KORDI_DEV_STACK_PROJECT, KORDI_DEV_API_PORT,
  KORDI_DEV_MINIO_PORT, KORDI_DEV_MINIO_CONSOLE_PORT.
  deploy also requires KORDI_DEV_REPOSITORY_URL.

Optional environment:
  KORDI_DEV_LOCK_TIMEOUT   Host-side lock timeout in seconds (default 1800).
  KORDI_DEV_ARTIFACT_OUT   File that receives sha256:<hex> after a deploy.
  KORDI_DEV_GCLOUD_BIN     gcloud executable (default gcloud).

--dry-run prints the exact remote script, lock invocation, and transport command
without executing anything. Every invocation takes the host-side lock
"stack-<id>" through scripts/with-deploy-lock.sh on the development host.
EOF
}

die() {
  printf '[dev-deploy] %s\n' "$*" >&2
  exit 1
}

usage_error() {
  printf '[dev-deploy] %s\n' "$*" >&2
  exit 2
}

shell_quote() {
  printf '%q' "$1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --dry-run)
      dry_run="true"
      shift
      ;;
    --stack)
      [ "$#" -ge 2 ] || usage_error "--stack requires a value"
      stack="$2"
      shift 2
      ;;
    --stack=*)
      stack="${1#--stack=}"
      shift
      ;;
    --sha)
      [ "$#" -ge 2 ] || usage_error "--sha requires a value"
      sha="$2"
      shift 2
      ;;
    --sha=*)
      sha="${1#--sha=}"
      shift
      ;;
    --confirm-stack)
      [ "$#" -ge 2 ] || usage_error "--confirm-stack requires a value"
      confirm_stack="$2"
      shift 2
      ;;
    --confirm-stack=*)
      confirm_stack="${1#--confirm-stack=}"
      shift
      ;;
    deploy|smoke|cleanup)
      [ -z "$command_name" ] || usage_error "unexpected argument: $1"
      command_name="$1"
      shift
      ;;
    *)
      usage_error "unknown argument: $1"
      ;;
  esac
done

[ -n "$command_name" ] || usage_error "missing subcommand (deploy, smoke, or cleanup)"

if [ -z "$stack" ]; then
  usage_error "missing --stack <id>"
fi
if [ "${#stack}" -lt 2 ] || [ "${#stack}" -gt 32 ]; then
  usage_error "stack id must be 2-32 characters"
fi
if [[ ! "$stack" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  usage_error "stack id must use lowercase letters, digits, and dashes"
fi
case "$stack" in
  *--*) usage_error "stack id must not contain consecutive dashes" ;;
esac

if [ "$command_name" = "deploy" ]; then
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    usage_error "--sha must be a full 40-character lowercase hexadecimal commit SHA"
  fi
fi

if [ "$command_name" = "cleanup" ]; then
  if [ -z "$confirm_stack" ]; then
    usage_error "cleanup requires --confirm-stack <id> as explicit destructive-action authorization"
  fi
  if [ "$confirm_stack" != "$stack" ]; then
    usage_error "--confirm-stack must equal --stack; refusing to clean another stack"
  fi
fi

if [[ ! "$lock_timeout" =~ ^[0-9]+$ ]]; then
  usage_error "KORDI_DEV_LOCK_TIMEOUT must be a non-negative integer number of seconds"
fi

require_env() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    die "required explicit identifier $name is not set; this script never inherits a gcloud default"
  fi
}

require_env KORDI_DEV_GCP_PROJECT
require_env KORDI_DEV_SSH_ZONE
require_env KORDI_DEV_SSH_TARGET
require_env KORDI_DEV_STACK_ROOT
require_env KORDI_DEV_STACK_PROJECT
require_env KORDI_DEV_API_PORT
require_env KORDI_DEV_MINIO_PORT
require_env KORDI_DEV_MINIO_CONSOLE_PORT
if [ "$command_name" = "deploy" ]; then
  require_env KORDI_DEV_REPOSITORY_URL
fi

if [[ ! "$KORDI_DEV_GCP_PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  die "KORDI_DEV_GCP_PROJECT must be an explicit Google Cloud project id"
fi
if [[ ! "$KORDI_DEV_SSH_ZONE" =~ ^[a-z][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
  die "KORDI_DEV_SSH_ZONE must be an explicit zone name"
fi
if [[ ! "$KORDI_DEV_SSH_TARGET" =~ ^[a-z][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
  die "KORDI_DEV_SSH_TARGET must be an explicit instance name"
fi
case "$KORDI_DEV_STACK_ROOT" in
  /*) ;;
  *) die "KORDI_DEV_STACK_ROOT must be an absolute path" ;;
esac
case "$KORDI_DEV_STACK_ROOT" in
  *[[:space:]]*) die "KORDI_DEV_STACK_ROOT must not contain whitespace" ;;
esac
case "/$KORDI_DEV_STACK_ROOT/" in
  */../*) die "KORDI_DEV_STACK_ROOT must not contain '..' segments" ;;
esac
KORDI_DEV_STACK_ROOT="${KORDI_DEV_STACK_ROOT%/}"
if [ -z "$KORDI_DEV_STACK_ROOT" ]; then
  die "KORDI_DEV_STACK_ROOT must not be the filesystem root"
fi
if [ "$command_name" = "deploy" ]; then
  case "$KORDI_DEV_REPOSITORY_URL" in
    https://*) ;;
    *) die "KORDI_DEV_REPOSITORY_URL must be an https repository URL" ;;
  esac
  case "$KORDI_DEV_REPOSITORY_URL" in
    *[[:space:]]*) die "KORDI_DEV_REPOSITORY_URL must not contain whitespace" ;;
  esac
fi

if [ "$KORDI_DEV_STACK_PROJECT" != "kordi-$stack" ]; then
  die "KORDI_DEV_STACK_PROJECT must be 'kordi-$stack'; refusing to target another stack's Compose project"
fi

validate_port() {
  local name="$1"
  local value="${!name:-}"
  if [[ ! "$value" =~ ^[0-9]{1,5}$ ]] || [ "$value" -lt 1024 ] || [ "$value" -gt 65535 ]; then
    die "$name must be an explicit port between 1024 and 65535"
  fi
}
validate_port KORDI_DEV_API_PORT
validate_port KORDI_DEV_MINIO_PORT
validate_port KORDI_DEV_MINIO_CONSOLE_PORT
if [ "$KORDI_DEV_API_PORT" = "$KORDI_DEV_MINIO_PORT" ] \
  || [ "$KORDI_DEV_API_PORT" = "$KORDI_DEV_MINIO_CONSOLE_PORT" ] \
  || [ "$KORDI_DEV_MINIO_PORT" = "$KORDI_DEV_MINIO_CONSOLE_PORT" ]; then
  die "the three stack ports must be distinct"
fi

stack_dir="$KORDI_DEV_STACK_ROOT/$stack"
tooling_dir="$KORDI_DEV_STACK_ROOT/.kordi-deploy-tooling"

build_deploy_inner_script() {
  local q_stack_dir q_stack_root q_repository q_sha q_project q_api q_minio q_console
  q_stack_dir="$(shell_quote "$stack_dir")"
  q_stack_root="$(shell_quote "$KORDI_DEV_STACK_ROOT")"
  q_repository="$(shell_quote "$KORDI_DEV_REPOSITORY_URL")"
  q_sha="$(shell_quote "$sha")"
  q_project="$(shell_quote "$KORDI_DEV_STACK_PROJECT")"
  q_api="$(shell_quote "$KORDI_DEV_API_PORT")"
  q_minio="$(shell_quote "$KORDI_DEV_MINIO_PORT")"
  q_console="$(shell_quote "$KORDI_DEV_MINIO_CONSOLE_PORT")"
  {
    printf '%s\n' 'set -euo pipefail'
    printf 'stack_dir=%s\n' "$q_stack_dir"
    printf '%s\n' \
      'if [ -L "$stack_dir" ]; then' \
      '  echo "[dev-deploy] Refusing: the stack path is a symlink." >&2' \
      '  exit 1' \
      'fi' \
      'if [ -e "$stack_dir" ] && [ ! -d "$stack_dir/.git" ]; then' \
      '  echo "[dev-deploy] Refusing: the stack path exists and is not a git checkout." >&2' \
      '  exit 1' \
      'fi' \
      'if [ ! -d "$stack_dir/.git" ]; then' \
      "  mkdir -p $q_stack_root" \
      "  git clone --filter=blob:none --no-checkout $q_repository \"\$stack_dir\"" \
      'fi'
    printf '%s\n' \
      'remote_url="$(git -C "$stack_dir" remote get-url origin 2>/dev/null || true)"' \
      "if [ \"\$remote_url\" != $q_repository ]; then" \
      '  echo "[dev-deploy] Refusing: the stack checkout belongs to a different repository." >&2' \
      '  exit 1' \
      'fi' \
      'if [ -n "$(git -C "$stack_dir" status --porcelain)" ]; then' \
      '  echo "[dev-deploy] Refusing: the stack checkout has local changes." >&2' \
      '  exit 1' \
      'fi'
    printf 'git -C "$stack_dir" fetch --no-tags origin %s\n' "$q_sha"
    printf 'git -C "$stack_dir" checkout --detach %s\n' "$q_sha"
    printf '%s\n' \
      'cd "$stack_dir"' \
      "export KORDI_DEBUG_PROJECT_NAME=$q_project" \
      'export KORDI_DEBUG_ENV_FILE="$stack_dir/deploy/dev/.env"' \
      "export KORDI_DEBUG_API_PORT=$q_api" \
      "export KORDI_DEBUG_MINIO_PORT=$q_minio" \
      "export KORDI_DEBUG_MINIO_CONSOLE_PORT=$q_console" \
      'bash scripts/dev-cloud-up.sh'
    printf '%s\n' \
      "compose=(docker compose --project-name $q_project --env-file \"\$stack_dir/deploy/dev/.env\" -f \"\$stack_dir/deploy/dev/compose.yaml\")" \
      'image_id="$("${compose[@]}" images -q cloud-server | head -n 1)"' \
      'if [ -z "$image_id" ]; then' \
      '  echo "[dev-deploy] Unable to resolve the deployed cloud-server image." >&2' \
      '  exit 1' \
      'fi' \
      "image_digest=\"\$(docker image inspect --format '{{.Id}}' \"\$image_id\")\"" \
      "printf 'KORDI_DEV_ARTIFACT_DIGEST=%s\\n' \"\$image_digest\""
  }
}

build_smoke_inner_script() {
  local q_stack_dir q_project q_api q_minio q_console
  q_stack_dir="$(shell_quote "$stack_dir")"
  q_project="$(shell_quote "$KORDI_DEV_STACK_PROJECT")"
  q_api="$(shell_quote "$KORDI_DEV_API_PORT")"
  q_minio="$(shell_quote "$KORDI_DEV_MINIO_PORT")"
  q_console="$(shell_quote "$KORDI_DEV_MINIO_CONSOLE_PORT")"
  {
    printf '%s\n' 'set -euo pipefail'
    printf 'stack_dir=%s\n' "$q_stack_dir"
    printf '%s\n' \
      'if [ ! -d "$stack_dir/.git" ]; then' \
      '  echo "[dev-deploy] Refusing: the stack checkout is missing; deploy before smoking." >&2' \
      '  exit 1' \
      'fi' \
      'cd "$stack_dir"' \
      "export KORDI_DEBUG_PROJECT_NAME=$q_project" \
      'export KORDI_DEBUG_ENV_FILE="$stack_dir/deploy/dev/.env"' \
      "export KORDI_DEBUG_API_PORT=$q_api" \
      "export KORDI_DEBUG_MINIO_PORT=$q_minio" \
      "export KORDI_DEBUG_MINIO_CONSOLE_PORT=$q_console" \
      'bash scripts/dev-cloud-smoke.sh'
  }
}

build_cleanup_inner_script() {
  local q_stack_dir q_project
  q_stack_dir="$(shell_quote "$stack_dir")"
  q_project="$(shell_quote "$KORDI_DEV_STACK_PROJECT")"
  {
    printf '%s\n' 'set -euo pipefail'
    printf 'stack_dir=%s\n' "$q_stack_dir"
    printf '%s\n' \
      'if [ ! -d "$stack_dir" ]; then' \
      '  echo "[dev-deploy] The stack workdir is absent; nothing to clean."' \
      '  exit 0' \
      'fi' \
      'env_file="$stack_dir/deploy/dev/.env"' \
      'if [ ! -f "$env_file" ]; then' \
      '  env_file="$stack_dir/deploy/dev/.env.example"' \
      'fi'
    printf 'docker compose --project-name %s --env-file "$env_file" -f "$stack_dir/deploy/dev/compose.yaml" down --remove-orphans\n' "$q_project"
  }
}

build_bootstrap_script() {
  local inner_script="$1"
  local q_tooling q_lock q_timeout
  q_tooling="$(shell_quote "$tooling_dir")"
  q_lock="$(shell_quote "stack-$stack")"
  q_timeout="$(shell_quote "$lock_timeout")"
  {
    printf '%s\n' 'set -euo pipefail' 'umask 077'
    printf 'tooling_dir=%s\n' "$q_tooling"
    printf '%s\n' \
      'mkdir -p "$tooling_dir/scripts/lib"' \
      'write_tooling_file() {' \
      '  target="$1"' \
      '  temp="$(mktemp)"' \
      '  cat > "$temp"' \
      '  if cmp -s "$temp" "$target" 2>/dev/null; then' \
      '    rm -f "$temp"' \
      '  else' \
      '    mv -f "$temp" "$target"' \
      '  fi' \
      '  chmod 700 "$target"' \
      '}'
    printf 'write_tooling_file "$tooling_dir/scripts/with-deploy-lock.sh" <<%s\n' "'KORDI_LOCK_WRAPPER_EOF'"
    cat "$lock_helper"
    printf '%s\n' 'KORDI_LOCK_WRAPPER_EOF'
    printf 'write_tooling_file "$tooling_dir/scripts/lib/deploy-lock.sh" <<%s\n' "'KORDI_LOCK_LIBRARY_EOF'"
    cat "$lock_library"
    printf '%s\n' 'KORDI_LOCK_LIBRARY_EOF'
    printf '%s\n' 'inner_script="$(mktemp)"'
    printf 'cat > "$inner_script" <<%s\n' "'KORDI_INNER_SCRIPT_EOF'"
    printf '%s\n' "$inner_script"
    printf '%s\n' 'KORDI_INNER_SCRIPT_EOF'
    printf 'bash "$tooling_dir/scripts/with-deploy-lock.sh" %s --timeout %s -- bash "$inner_script"\n' "$q_lock" "$q_timeout"
    printf '%s\n' 'rm -f "$inner_script"'
  }
}

run_remote() {
  local inner_script="$1"
  local bootstrap payload remote_command status raw_log digest
  local -a transport display_transport

  if [ "$dry_run" = "true" ]; then
    display_transport=(
      "${KORDI_DEV_GCLOUD_BIN:-gcloud}" compute ssh "$KORDI_DEV_SSH_TARGET"
      --project "$KORDI_DEV_GCP_PROJECT"
      --zone "$KORDI_DEV_SSH_ZONE"
      --tunnel-through-iap
      --quiet
      --ssh-flag="-o BatchMode=yes"
      --ssh-flag="-o StrictHostKeyChecking=accept-new"
      --command "printf %s <base64-payload> | base64 --decode | bash"
    )
    printf '[dev-deploy] dry run: no command was executed.\n'
    printf '[dev-deploy] host-side lock invocation: bash "$tooling_dir/scripts/with-deploy-lock.sh" %s --timeout %s -- bash "<inner-script>"\n' "$(shell_quote "stack-$stack")" "$(shell_quote "$lock_timeout")"
    printf '[dev-deploy] transport command:\n'
    printf '%q ' "${display_transport[@]}"
    printf '\n'
    printf '[dev-deploy] remote script for stack %s:\n' "$stack"
    printf '%s\n' "$inner_script"
    return 0
  fi

  if [ ! -r "$lock_helper" ]; then
    die "missing shared lock helper: $lock_helper"
  fi
  if [ ! -r "$lock_library" ]; then
    die "missing shared lock library: $lock_library"
  fi

  bootstrap="$(build_bootstrap_script "$inner_script")"
  payload="$(printf '%s' "$bootstrap" | base64 | tr -d '\n')"
  remote_command="printf %s $payload | base64 --decode | bash"
  transport=(
    "${KORDI_DEV_GCLOUD_BIN:-gcloud}" compute ssh "$KORDI_DEV_SSH_TARGET"
    --project "$KORDI_DEV_GCP_PROJECT"
    --zone "$KORDI_DEV_SSH_ZONE"
    --tunnel-through-iap
    --quiet
    --ssh-flag="-o BatchMode=yes"
    --ssh-flag="-o StrictHostKeyChecking=accept-new"
    --command "$remote_command"
  )

  raw_log="$(mktemp)"
  set +e
  "${transport[@]}" 2>&1 | tee "$raw_log"
  status="${PIPESTATUS[0]}"
  set -e
  if [ "$status" -ne 0 ]; then
    rm -f "$raw_log"
    return "$status"
  fi

  if [ "$command_name" = "deploy" ]; then
    digest="$(sed -n 's/^KORDI_DEV_ARTIFACT_DIGEST=//p' "$raw_log" | tail -n 1)"
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      rm -f "$raw_log"
      die "the deploy did not report a valid artifact digest"
    fi
    if [ -n "${KORDI_DEV_ARTIFACT_OUT:-}" ]; then
      printf '%s\n' "$digest" > "$KORDI_DEV_ARTIFACT_OUT"
    fi
    printf '[dev-deploy] deployed artifact digest: %s\n' "$digest"
  fi
  rm -f "$raw_log"
}

case "$command_name" in
  deploy)
    run_remote "$(build_deploy_inner_script)"
    ;;
  smoke)
    run_remote "$(build_smoke_inner_script)"
    ;;
  cleanup)
    run_remote "$(build_cleanup_inner_script)"
    ;;
esac
