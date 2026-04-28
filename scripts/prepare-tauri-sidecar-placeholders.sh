#!/usr/bin/env bash
set -euo pipefail

# Tauri validates externalBin paths while compiling the desktop crate. Unit tests do
# not execute the sidecars, so CI/local checks can use tiny ignored placeholders
# instead of building release sidecars before every `cargo test`/`cargo clippy` run.

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
binaries_dir="$repo_root/app/desktop/src-tauri/binaries"
target_triple=${TAURI_ENV_TARGET_TRIPLE:-}

if [ -z "$target_triple" ]; then
  rustc_version=$(rustc -vV)
  target_triple=$(printf '%s\n' "$rustc_version" | awk '/^host: / { print $2 }')
fi

if [ -z "$target_triple" ]; then
  echo "Unable to detect Rust target triple." >&2
  exit 1
fi

mkdir -p "$binaries_dir"

for name in kordi bridges; do
  path="$binaries_dir/$name-$target_triple"
  if [ ! -f "$path" ]; then
    cat > "$path" <<'EOF'
#!/usr/bin/env sh
echo "This is a test-only Tauri sidecar placeholder." >&2
exit 0
EOF
    chmod +x "$path"
  fi
  echo "Prepared $path"
done
