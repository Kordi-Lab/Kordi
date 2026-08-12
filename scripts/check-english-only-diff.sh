#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

base_ref="${1:-${KORDI_ENGLISH_BASE:-origin/main}}"
if ! git rev-parse --verify "${base_ref}^{commit}" >/dev/null 2>&1; then
  echo "English-only check failed: base ref '$base_ref' is unavailable." >&2
  exit 1
fi

merge_base="$(git merge-base "$base_ref" HEAD)"
failed=0

check_file() {
  local path="$1"
  [[ -f "$path" ]] || return 0

  if rg -n --color=never '[\p{Han}]' -- "$path"; then
    echo "English-only check failed: Han characters found in $path." >&2
    failed=1
  fi
}

while IFS= read -r -d '' path; do
  [[ -n "$path" ]] || continue
  check_file "$path"
done < <(git diff --diff-filter=ACMR --name-only -z "$merge_base" --)

while IFS= read -r -d '' path; do
  [[ -n "$path" ]] || continue
  check_file "$path"
done < <(git diff --cached --diff-filter=ACMR --name-only -z --)

if git log --format='%B' "$merge_base..HEAD" | rg -n --color=never '[\p{Han}]'; then
  echo "English-only check failed: Han characters found in branch commit messages." >&2
  failed=1
fi

if (( failed != 0 )); then
  exit 1
fi

echo "English-only check passed for changes relative to $base_ref."
