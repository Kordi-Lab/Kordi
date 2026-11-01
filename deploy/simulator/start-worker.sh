#!/usr/bin/env bash
set -euo pipefail

# Both providers use the native CLI and the same validated deployment contract.
# KORDI_BIN may point to a locally built binary; no provider secrets enter argv.
exec "${KORDI_BIN:-kordi}" sim deploy "$@"
