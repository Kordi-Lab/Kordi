#!/usr/bin/env bash
# Transport delegates every production mutation and the shared lock to the host.
set -euo pipefail
if [ "${1:-}" = --help ] || [ "$#" -ne 3 ]; then
  echo 'Usage: production-deploy.sh <verified-bundle-directory> <tested-sha> <build-run-id>'
  echo 'Use the protected Deploy production workflow; it verifies development evidence and requires approval.'
  [ "${1:-}" = --help ] && exit 0
  exit 2
fi
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/deploy-backend-bundle.sh" production "$@"
