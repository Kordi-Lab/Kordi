#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <target-directory>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$1"
ALLOWLIST_FILE="$ROOT_DIR/public-beta-allowlist.txt"

if [[ ! -f "$ALLOWLIST_FILE" ]]; then
  echo "Missing allowlist file: $ALLOWLIST_FILE" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

mapfile -t ALLOWLIST < <(grep -v '^#' "$ALLOWLIST_FILE" | sed '/^$/d')

is_allowed() {
  local path="$1"
  local entry
  for entry in "${ALLOWLIST[@]}"; do
    if [[ "$entry" == */ ]]; then
      [[ "$path" == "$entry"* ]] && return 0
    else
      [[ "$path" == "$entry" ]] && return 0
    fi
  done
  return 1
}

cd "$ROOT_DIR"

while IFS= read -r -d '' path; do
  if is_allowed "$path"; then
    mkdir -p "$TARGET_DIR/$(dirname "$path")"
    cp -p "$path" "$TARGET_DIR/$path"
  fi
done < <(git ls-files -z)

node "$ROOT_DIR/scripts/brand-public-beta.mjs" "$TARGET_DIR"

PACKAGE_NAME="${PUBLIC_PACKAGE_NAME:-bridges}"
CLI_NAME="${PUBLIC_CLI_NAME:-$PACKAGE_NAME}"
VERSION="${PUBLIC_VERSION:-0.0.1-beta}"

cat <<EOF
Exported public beta snapshot to:
  $TARGET_DIR

Source selection:
  $ALLOWLIST_FILE

Branding:
  package: [1m$PACKAGE_NAME[0m
  version: [1m$VERSION[0m
  command: [1m$CLI_NAME[0m

Next steps:
  1. Review the exported tree
  2. Run validation in the exported repo
  3. Commit/push to the separate public repository
EOF
