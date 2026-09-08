#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_directory="${1:?Pass the generated test-resource directory}"
task_directory="$(mktemp -d "${TMPDIR:-/tmp}/kordi-live-fixture.XXXXXX")"
trap 'rm -rf "$task_directory"' EXIT

# Compile for the host Mac even when invoked from an iOS Simulator build phase.
mac_sdk="$(xcrun --sdk macosx --show-sdk-path)"
xcrun --sdk macosx swiftc -sdk "$mac_sdk" -target "$(uname -m)-apple-macosx12.0" \
  "$repo_root/app/desktop/src-tauri/native/LivePhotos.swift" \
  "$repo_root/app/desktop/tests/livePhotoNativeCheck.swift" \
  -o "$task_directory/check"
"$task_directory/check" "$task_directory/assets"
mkdir -p "$output_directory"
cp "$task_directory/assets/live-photo.jpg" "$task_directory/assets/live-photo.mov" \
  "$task_directory/assets/live-photo.mp4" "$output_directory/"
