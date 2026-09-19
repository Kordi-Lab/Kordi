#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

base="${KORDI_CI_BASE:-${KORDI_HYGIENE_BASE:-}}"
head="${KORDI_CI_HEAD:-HEAD}"
comparison=
if [ -n "$base" ]; then
  comparison="${base}...${head}"
fi

plan=()
if [ -n "$comparison" ]; then
  plan+=("node scripts/repository-privacy-guard.mjs --comparison $comparison")
  plan+=("bash scripts/check-hygiene.sh $comparison")
  plan+=("node scripts/check-maintainability-ratchet.mjs $comparison")
  plan+=("node scripts/check-eslint-suppressions-ratchet.mjs $comparison")
else
  plan+=("node scripts/repository-privacy-guard.mjs")
  plan+=("bash scripts/check-hygiene.sh")
  plan+=("node scripts/check-maintainability-ratchet.mjs")
  plan+=("node scripts/check-eslint-suppressions-ratchet.mjs")
fi
plan+=("pnpm test:scripts")
plan+=("pnpm test:ci-scripts")

if [ "${1:-}" = "--print-plan" ]; then
  printf '%s\n' "${plan[@]}"
  exit 0
fi

if [ "$#" -gt 0 ]; then
  echo "run-hygiene: unknown argument: $1" >&2
  exit 1
fi

if [ -n "$comparison" ]; then
  echo "• privacy (${comparison})"
  node scripts/repository-privacy-guard.mjs --comparison "$comparison"
  echo "• whitespace (${comparison})"
  bash scripts/check-hygiene.sh "$comparison"
  echo "• maintainability (${comparison})"
  node scripts/check-maintainability-ratchet.mjs "$comparison"
  echo "• eslint suppressions (${comparison})"
  node scripts/check-eslint-suppressions-ratchet.mjs "$comparison"
else
  echo "• privacy"
  node scripts/repository-privacy-guard.mjs
  echo "• whitespace"
  bash scripts/check-hygiene.sh
  echo "• maintainability"
  node scripts/check-maintainability-ratchet.mjs
  echo "• eslint suppressions"
  node scripts/check-eslint-suppressions-ratchet.mjs
fi
echo "• script tests"
pnpm test:scripts
echo "• CI script tests"
pnpm test:ci-scripts
