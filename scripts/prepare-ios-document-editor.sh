#!/usr/bin/env bash
set -euo pipefail

# Builds the iPhone document editor page (the Mac's Tiptap editor from
# app/desktop/src/ios-document-editor) into the app bundle's DocumentEditor
# folder. Runs from the Kordi target's Xcode build; needs `pnpm install`.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
resources="${1:?Pass the app resource directory}"
desktop="$repo_root/app/desktop"
output="$resources/DocumentEditor"

# Xcode runs build scripts with a short PATH; look where Node is usually installed.
for candidate in /opt/homebrew/bin /opt/homebrew/opt/node@22/bin /usr/local/bin /usr/local/opt/node@22/bin \
  "$HOME/.volta/bin" "$HOME/Library/pnpm" "$HOME/.local/share/pnpm"; do
  [ -d "$candidate" ] && PATH="$PATH:$candidate"
done
if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin; do PATH="$PATH:$candidate"; done
fi
export PATH

if ! command -v pnpm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "error: Node and pnpm are needed to build the document editor page." >&2
  exit 1
fi
if [ ! -d "$desktop/node_modules/vite" ]; then
  echo "error: Run pnpm install at the repository root to build the document editor page." >&2
  exit 1
fi

mkdir -p "$output"
pnpm --dir "$desktop" exec vite build --config vite.ios-editor.config.js --outDir "$output" --logLevel warn
cp "$desktop/src/ios-document-editor/index.html" "$output/index.html"

# The native app and its embedded editor share the complete offline notices.
node "$repo_root/scripts/licenses.mjs" check
node "$repo_root/scripts/licenses.mjs" stage "$resources/licenses"
