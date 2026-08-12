#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
chmod +x .githooks/pre-push
chmod +x scripts/prepare-tauri-sidecar-placeholders.sh
chmod +x scripts/check-hygiene.sh
chmod +x scripts/check-english-only-diff.sh

echo "Kordi git hooks installed."
echo "To skip hooks for an emergency commit/push, set KORDI_SKIP_HOOKS=1."
