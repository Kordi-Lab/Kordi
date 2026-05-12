#!/usr/bin/env bash
#
# sync-and-build.sh — RUN LOCALLY (not on the VM).
#
# Rsyncs the repo to takotako and builds kordi-cloud-server with the VM's
# existing rust toolchain. Does NOT install the systemd unit, stop any
# existing service, or start anything new — that's `install.sh`.
#
# Usage:
#   bridges/cloud-server/deploy/sync-and-build.sh
#
# Optional env:
#   KORDI_CLOUD_SSH_TARGET   default: shu_yang@takotako
#   KORDI_CLOUD_SSH_ZONE     default: us-central1-c
#   KORDI_CLOUD_REMOTE_DIR   default: /home/shu_yang/kordi-cloud-server-deploy

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:-shu_yang@takotako}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:-us-central1-c}"
REMOTE_DIR="${KORDI_CLOUD_REMOTE_DIR:-/home/shu_yang/kordi-cloud-server-deploy}"

echo "[deploy] repo root:    ${REPO_ROOT}"
echo "[deploy] ssh target:   ${SSH_TARGET} (zone ${SSH_ZONE})"
echo "[deploy] remote dir:   ${REMOTE_DIR}"

# gcloud's compute-ssh wraps an rsync helper; we use it so the SSH key
# negotiation and project/zone flags stay consistent with the user's gcloud
# config.
export CLOUDSDK_COMPUTE_ZONE="${SSH_ZONE}"

echo "[deploy] ensuring remote dir exists"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
	--command "mkdir -p ${REMOTE_DIR}"

echo "[deploy] rsync source tree (excluding heavy build/cache dirs)"
gcloud compute scp --zone "${SSH_ZONE}" --recurse \
	--compress \
	"${REPO_ROOT}/Cargo.toml" \
	"${REPO_ROOT}/Cargo.lock" \
	"${SSH_TARGET}:${REMOTE_DIR}/"

# Each workspace member that the cloud-server's Cargo.toml inherits via
# `*.workspace = true` deps has to exist for cargo to resolve, even though
# only `bridges/cloud-server` itself is built. We ship them all to keep the
# workspace consistent — the build only touches bridges/cloud-server.
gcloud compute scp --zone "${SSH_ZONE}" --recurse \
	--compress \
	"${REPO_ROOT}/bridges" \
	"${REPO_ROOT}/agent" \
	"${REPO_ROOT}/app" \
	"${REPO_ROOT}/shared" \
	"${SSH_TARGET}:${REMOTE_DIR}/"

echo "[deploy] running 'cargo build --release -p kordi-cloud-server' on the VM"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
	--command "set -e; cd ${REMOTE_DIR}; \$HOME/.cargo/bin/cargo build --release -p kordi-cloud-server"

echo "[deploy] verifying binary"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
	--command "ls -la ${REMOTE_DIR}/target/release/kordi-cloud-server && file ${REMOTE_DIR}/target/release/kordi-cloud-server"

echo "[deploy] done. Next step: bridges/cloud-server/deploy/install.sh"
