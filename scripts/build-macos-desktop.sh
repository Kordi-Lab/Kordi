#!/bin/bash
set -euo pipefail
export MACOSX_DEPLOYMENT_TARGET=13.0
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$repo_root/scripts/package-distribution.mjs" desktop --build "$@"
