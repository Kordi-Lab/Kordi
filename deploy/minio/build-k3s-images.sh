#!/usr/bin/env bash
#
# Build the MinIO server and client images from source and import them into
# k3s containerd. Run on the k3s host itself, as a user with sudo, from a copy
# of this directory. The manifests use imagePullPolicy: Never, so import these
# images before applying minio.yaml or any Job that runs mc.
#
# Compiling MinIO is heavy for a small product host, so prefer building the
# images on another machine and importing the archives (see README.md). This
# script therefore:
#   - skips an image that k3s containerd already has under its pinned tag. Set
#     KORDI_MINIO_IMAGES_REBUILD=1 after changing a Dockerfile without
#     changing its release;
#   - refuses to build when the host is short of free disk or available memory
#     (KORDI_MINIO_BUILD_MIN_DISK_MIB, KORDI_MINIO_BUILD_MIN_MEMORY_MIB);
#   - removes its build layers and caches from buildah storage when it exits,
#     including after a failed build.

set -euo pipefail

MINIO_IMAGE=docker.io/library/kordi-minio:RELEASE.2024-12-18T13-15-44Z
MC_IMAGE=docker.io/library/kordi-minio-mc:RELEASE.2024-11-21T17-21-54Z

# The Go module cache, build cache, and intermediate layers of one build take
# a few GiB; the Go linker needs about 2 GiB of memory for the MinIO server.
min_disk_mib="${KORDI_MINIO_BUILD_MIN_DISK_MIB:-8192}"
min_memory_mib="${KORDI_MINIO_BUILD_MIN_MEMORY_MIB:-2048}"
rebuild="${KORDI_MINIO_IMAGES_REBUILD:-0}"

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ctr=(sudo k3s ctr --namespace k8s.io)

log() { echo "[minio-images] $*"; }
fail() {
  echo "[minio-images] $*" >&2
  exit 1
}

for command_name in buildah k3s; do
  if ! sudo sh -c "command -v ${command_name}" >/dev/null 2>&1; then
    fail "missing required command: ${command_name}"
  fi
done

imported() {
  "${ctr[@]}" images list --quiet | grep -qxF "$1"
}

pending=()
for image in "${MINIO_IMAGE}" "${MC_IMAGE}"; do
  if [[ "${rebuild}" != 1 ]] && imported "${image}"; then
    log "${image} is already imported; set KORDI_MINIO_IMAGES_REBUILD=1 to rebuild it"
  else
    pending+=("${image}")
  fi
done
if [[ ${#pending[@]} -eq 0 ]]; then
  exit 0
fi

# Free space, in MiB, on the file system that holds $1 (or its nearest
# existing ancestor).
free_mib() {
  local path="$1"
  while ! sudo test -e "${path}"; do
    path="$(dirname "${path}")"
  done
  sudo df -Pk "${path}" | awk 'NR == 2 { print int($4 / 1024) }'
}

storage="$(sudo buildah info --format '{{.store.GraphRoot}}' 2>/dev/null || true)"
storage="${storage:-/var/lib/containers/storage}"
for path in "${storage}" /tmp; do
  available="$(free_mib "${path}")"
  if ((available < min_disk_mib)); then
    fail "only ${available} MiB free for ${path}; building needs ${min_disk_mib} MiB." \
      "Free disk space, or build the images on another machine and import them (deploy/minio/README.md)."
  fi
done
available="$(awk '$1 == "MemAvailable:" { print int($2 / 1024) }' /proc/meminfo)"
if ((available < min_memory_mib)); then
  fail "only ${available} MiB of memory available; building needs ${min_memory_mib} MiB." \
    "Build the images on another machine and import them (deploy/minio/README.md)."
fi

work="$(sudo mktemp -d /tmp/kordi-minio-images.XXXXXXXX)"
cleanup() {
  sudo rm -rf -- "${work}"
  # containerd keeps its own copy of each imported image. Drop the buildah
  # copies, then every dangling layer, including the build stage with its Go
  # module and build caches. Pruning is best effort and never changes the
  # script's exit status.
  local image
  for image in "${pending[@]}"; do
    sudo buildah rmi "${image}" >/dev/null 2>&1 || true
  done
  sudo buildah rmi --prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

build_and_import() {
  local image="$1" dockerfile="$2" archive="${work}/$3.oci.tar"
  log "building ${image}"
  sudo buildah bud --layers -t "${image}" -f "${dir}/${dockerfile}" "${dir}"
  sudo buildah push "${image}" "oci-archive:${archive}:${image}"
  "${ctr[@]}" images import "${archive}" >/dev/null
  sudo rm -f -- "${archive}"
  if ! imported "${image}"; then
    fail "${image} is missing from k3s containerd after import"
  fi
  log "imported ${image}"
}

for image in "${pending[@]}"; do
  case "${image}" in
    "${MINIO_IMAGE}") build_and_import "${image}" Dockerfile.server minio ;;
    "${MC_IMAGE}") build_and_import "${image}" Dockerfile.client minio-mc ;;
  esac
done
