#!/usr/bin/env bash
#
# Build the MinIO server and client images from source and import them into
# k3s containerd. Run on the k3s host itself, as a user with sudo, from a copy
# of this directory. The manifests use imagePullPolicy: Never, so import these
# images before applying minio.yaml or any Job that runs mc.
#
# Idempotent. buildah reuses cached layers, so a rerun without changes only
# re-imports the existing images.

set -euo pipefail

MINIO_IMAGE=docker.io/library/kordi-minio:RELEASE.2024-12-18T13-15-44Z
MC_IMAGE=docker.io/library/kordi-minio-mc:RELEASE.2024-11-21T17-21-54Z

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ctr=(sudo k3s ctr --namespace k8s.io)

for command_name in buildah k3s; do
  if ! sudo sh -c "command -v ${command_name}" >/dev/null 2>&1; then
    echo "[minio-images] missing required command: ${command_name}" >&2
    exit 1
  fi
done

work="$(sudo mktemp -d /tmp/kordi-minio-images.XXXXXXXX)"
cleanup() { sudo rm -rf -- "${work}"; }
trap cleanup EXIT

build_and_import() {
  local image="$1" dockerfile="$2" archive="${work}/$3.oci.tar"
  echo "[minio-images] building ${image}"
  sudo buildah bud --layers -t "${image}" -f "${dir}/${dockerfile}" "${dir}"
  sudo buildah push "${image}" "oci-archive:${archive}:${image}"
  "${ctr[@]}" images import "${archive}" >/dev/null
  if ! "${ctr[@]}" images list --quiet | grep -qxF "${image}"; then
    echo "[minio-images] ${image} is missing from k3s containerd after import" >&2
    exit 1
  fi
  echo "[minio-images] imported ${image}"
}

build_and_import "${MINIO_IMAGE}" Dockerfile.server minio
build_and_import "${MC_IMAGE}" Dockerfile.client minio-mc
