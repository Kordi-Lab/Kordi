#!/bin/bash
set -euo pipefail

args=("$@")
output=""
exports_symbols=false

for ((index = 0; index < ${#args[@]}; index++)); do
  if [[ "${args[index]}" == "-o" && $((index + 1)) -lt ${#args[@]} ]]; then
    output="${args[index + 1]}"
  elif [[ "${args[index]}" == "-Wl,-exported_symbols_list" ]]; then
    exports_symbols=true
  fi
done

if [[ "$exports_symbols" == true && "$output" == */deps/*.dylib ]]; then
  for ((index = 0; index < ${#args[@]}; index++)); do
    if [[ "${args[index]}" == -mmacosx-version-min=* ]]; then
      args[index]="-mmacosx-version-min=11.0"
    fi
  done
fi

exec "${KORDI_REAL_LINKER:-/usr/bin/clang}" "${args[@]}"
