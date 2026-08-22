#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
export MACOSX_DEPLOYMENT_TARGET=12.0
export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="$repo_root/scripts/macos-proc-macro-linker.sh"

cd "$repo_root/app/desktop"
pnpm release:secret-guard
pnpm tauri:prepare-sidecars
exec pnpm exec tauri build "$@"
