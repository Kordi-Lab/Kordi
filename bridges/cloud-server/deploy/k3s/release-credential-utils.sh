#!/usr/bin/env bash

# Normalize access keys loaded from line-oriented secret stores without ever
# emitting the key itself. MinIO treats a trailing newline as part of the user
# name, so both generated and previously stored credentials must pass here.
normalize_access_key_file() {
  local source_file="$1"
  local normalized_file="${source_file}.normalized"
  local normalized_length

  tr -d '\r\n' <"${source_file}" >"${normalized_file}"
  normalized_length="$(wc -c <"${normalized_file}" | tr -d '[:space:]')"
  if [[ ! "${normalized_length}" =~ ^[0-9]+$ ]] || (( normalized_length < 3 )); then
    echo "release access key is invalid" >&2
    rm -f "${normalized_file}"
    return 1
  fi
  chmod 600 "${normalized_file}"
  mv "${normalized_file}" "${source_file}"
}
