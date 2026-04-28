#!/usr/bin/env bash
set -euo pipefail

# Check whitespace errors in the provided diff range, or in the local branch and
# working tree when no explicit range is supplied.
#
# CI passes an explicit range so the check matches the exact PR/push payload.
# Locally, include committed branch changes plus staged and unstaged edits so
# `pnpm check:ci` still catches whitespace after a commit has already been made.

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

if [ "$#" -gt 0 ]; then
  git diff --check "$@"
  exit 0
fi

base_ref=${KORDI_HYGIENE_BASE:-origin/main}
if git rev-parse --verify --quiet "$base_ref" >/dev/null; then
  merge_base=$(git merge-base HEAD "$base_ref")
  git diff --check "$merge_base"...HEAD
else
  echo "Skipping committed-change whitespace check: $base_ref is not available." >&2
fi

git diff --check --cached
git diff --check
