#!/usr/bin/env bash
# Cargo runner for macOS desktop previews. It starts the debug binary from a
# minimal ad-hoc signed .app so macOS privacy prompts, such as Location
# Services, can identify the app. A bare binary never gets a location prompt.
set -uo pipefail

if [[ $# -eq 0 ]]; then
  echo "[kordi] Missing binary for the macOS dev app runner." >&2
  exit 2
fi

binary="$1"
shift

identifier="${KORDI_DEV_BUNDLE_IDENTIFIER:-}"
if [[ "$(uname -s)" != "Darwin" || -z "$identifier" || "$(basename "$binary")" != "kordi-desktop" ]]; then
  exec "$binary" "$@"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
info_template="$script_dir/../src-tauri/Info.plist"
name="${KORDI_DEV_BUNDLE_NAME:-Kordi}"
name="${name//\//-}"
bin_dir="$(cd "$(dirname "$binary")" && pwd)"
exe="$(basename "$binary")"
app="$bin_dir/dev-app-bundles/$identifier/$name.app"

build_bundle() {
  rm -rf "$bin_dir/dev-app-bundles/$identifier" || return 1
  mkdir -p "$app/Contents/MacOS" || return 1
  # Clone on APFS; signing then rewrites only this copy.
  cp -c "$bin_dir/$exe" "$app/Contents/MacOS/$exe" 2>/dev/null \
    || cp "$bin_dir/$exe" "$app/Contents/MacOS/$exe" || return 1
  # Sidecars are found next to the executable; resources stay in the target directory.
  local entry
  for entry in "$bin_dir"/*; do
    [[ -f "$entry" && "$entry" != "$bin_dir/$exe" ]] || continue
    [[ -x "$entry" || "$entry" == *.node ]] || continue
    ln -s "$entry" "$app/Contents/MacOS/$(basename "$entry")" || return 1
  done
  ln -s "$bin_dir" "$app/Contents/Resources" || return 1
  local plist="$app/Contents/Info.plist"
  cp "$info_template" "$plist" || return 1
  plutil -replace CFBundleIdentifier -string "$identifier" "$plist" || return 1
  plutil -replace CFBundleName -string "$name" "$plist" || return 1
  plutil -replace CFBundleDisplayName -string "$name" "$plist" || return 1
  plutil -replace CFBundleExecutable -string "$exe" "$plist" || return 1
  plutil -replace CFBundlePackageType -string APPL "$plist" || return 1
  plutil -replace NSHighResolutionCapable -bool YES "$plist" || return 1
  # The signature binds Info.plist; without it macOS treats the app as a bare binary.
  codesign --force --sign - --identifier "$identifier" "$app" >/dev/null 2>&1 || return 1
}

if build_bundle; then
  exec "$app/Contents/MacOS/$exe" "$@"
fi
echo "[kordi] Could not prepare the macOS dev app bundle; starting the bare binary. Location prompts will not appear." >&2
exec "$binary" "$@"
