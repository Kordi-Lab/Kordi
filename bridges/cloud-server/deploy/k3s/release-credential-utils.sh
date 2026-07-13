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

# Return a stable state while preserving transport and Kubernetes failures.
# `kubectl --ignore-not-found` makes an absent secret a successful empty read;
# a failed gcloud/SSH/kubectl command must never rotate production credentials.
remote_secret_state() {
  local namespace="$1"
  local secret_name="$2"
  local remote_name

  if ! remote_name="$(
    remote "kubectl -n ${namespace} get secret ${secret_name} --ignore-not-found -o name"
  )"; then
    echo "unable to query release reader secret" >&2
    return 1
  fi

  case "${remote_name}" in
    "secret/${secret_name}") printf '%s\n' present ;;
    '') printf '%s\n' absent ;;
    *)
      echo "release reader secret query returned an unexpected result" >&2
      return 1
      ;;
  esac
}
