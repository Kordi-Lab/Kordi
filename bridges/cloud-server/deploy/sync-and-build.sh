#!/usr/bin/env bash
#
# sync-and-build.sh — RUN LOCALLY (not on the VM).
#
# Rsyncs the repo to an operator-provided Cloud host and builds
# kordi-cloud-server with that host's existing rust toolchain. Does NOT install
# the systemd unit, stop any existing service, or start anything new — that's
# `install.sh`.
#
# Usage:
#   bridges/cloud-server/deploy/sync-and-build.sh
#
# Required env:
#   KORDI_CLOUD_SSH_TARGET   required operator-provided gcloud SSH target
#   KORDI_CLOUD_SSH_ZONE     required operator-provided gcloud zone
#   KORDI_CLOUD_GCP_PROJECT  required operator-provided GCP project
#
# Optional env:
#   KORDI_CLOUD_REMOTE_DIR   default: ~/kordi-cloud-server-deploy

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET to the operator-provided gcloud SSH target}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE to the operator-provided gcloud zone}"
SSH_PROJECT="${KORDI_CLOUD_GCP_PROJECT:?Set KORDI_CLOUD_GCP_PROJECT to the operator-provided GCP project}"
REMOTE_DIR="${KORDI_CLOUD_REMOTE_DIR:-\$HOME/kordi-cloud-server-deploy}"
GCLOUD_SSH=(gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --project "${SSH_PROJECT}")

echo "[deploy] repo root:    ${REPO_ROOT}"
echo "[deploy] ssh target:   ${SSH_TARGET} (project ${SSH_PROJECT}, zone ${SSH_ZONE})"
echo "[deploy] remote dir:   ${REMOTE_DIR}"

# gcloud's compute-ssh wraps an rsync helper; we use it so the SSH key
# negotiation and project/zone flags stay consistent with the user's gcloud
# config.
export CLOUDSDK_COMPUTE_ZONE="${SSH_ZONE}"

echo "[deploy] ensuring remote dir exists and rsync is available"
"${GCLOUD_SSH[@]}" \
	--command "set -e; mkdir -p ${REMOTE_DIR}; if ! command -v rsync >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y rsync; fi"

echo "[deploy] deriving rsync SSH transport from gcloud"
# `gcloud compute ssh --dry-run` prints the exact ssh command for the VM,
# including the active key, host alias, known-hosts file, and external IP.
# Drop `-t`: rsync is non-interactive and a forced TTY can corrupt protocol IO.
GCLOUD_SSH_DRY_RUN="$("${GCLOUD_SSH[@]}" --dry-run | sed 's/ -t / /')"
RSYNC_REMOTE="$(awk '{ print $NF }' <<<"${GCLOUD_SSH_DRY_RUN}")"
RSYNC_RSH="$(awk '{$NF=""; sub(/[[:space:]]+$/, ""); print}' <<<"${GCLOUD_SSH_DRY_RUN}")"

# Each workspace member that the cloud-server's Cargo.toml inherits via
# `*.workspace = true` deps has to exist for cargo to resolve, even though
# only `bridges/cloud-server` itself is built. Sync in-place with --delete so
# removed source files disappear from the VM, but exclude target/ so Cargo's
# remote build cache survives iterative deploys.
echo "[deploy] rsync source tree in-place (preserving remote target/)"
rsync -az --delete --human-readable --stats \
	--rsh="${RSYNC_RSH}" \
	--exclude='target/' \
	--exclude='.git/' \
	--exclude='node_modules/' \
	--exclude='dist/' \
	--exclude='build/' \
	--exclude='.next/' \
	--exclude='.multi-instance-data/' \
	--exclude='.multi-instance-logs/' \
	--exclude='.multi-instance-runtime/' \
	"${REPO_ROOT}/Cargo.toml" \
	"${REPO_ROOT}/Cargo.lock" \
	"${REPO_ROOT}/bridges" \
	"${REPO_ROOT}/agent" \
	"${REPO_ROOT}/app" \
	"${REPO_ROOT}/shared" \
	"${RSYNC_REMOTE}:${REMOTE_DIR}/"

echo "[deploy] running 'cargo build --release -p kordi-cloud-server' on the VM"
"${GCLOUD_SSH[@]}" \
	--command "set -e; cd ${REMOTE_DIR}; \$HOME/.cargo/bin/cargo build --release -p kordi-cloud-server"

echo "[deploy] verifying binary"
"${GCLOUD_SSH[@]}" \
	--command "ls -la ${REMOTE_DIR}/target/release/kordi-cloud-server && file ${REMOTE_DIR}/target/release/kordi-cloud-server"

echo "[deploy] done. Next step: bridges/cloud-server/deploy/install.sh"
