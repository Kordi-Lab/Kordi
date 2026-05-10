#!/usr/bin/env bash
#
# deploy-cloud-server.sh — RUN LOCALLY.
#
# After the binary is built on takotako (via cargo build --release on the
# synced source), this script:
#   1. Pulls the built binary back to the laptop.
#   2. Builds a slim runtime Docker image around it (linux/amd64).
#   3. Saves the image as a tar.
#   4. Ships the tar to the VM.
#   5. Imports it into k3s's containerd.
#   6. Applies the cluster Deployment + Service manifests.
#   7. Waits for rollout, hits /health from inside the cluster.
#
# Idempotent: re-running with a new binary triggers a rolling restart of
# the Deployment via image-tag rotation.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CRATE_DIR="${REPO_ROOT}/bridges/cloud-server"
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:-shu_yang@takotako}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:-us-central1-c}"
REMOTE_DEPLOY="${KORDI_CLOUD_REMOTE_DIR:-/home/shu_yang/kordi-cloud-server-deploy}"
IMAGE_TAG="${KORDI_CLOUD_IMAGE_TAG:-dev-$(date +%Y%m%d-%H%M%S)}"
IMAGE="kordi-cloud-server:${IMAGE_TAG}"
LOCAL_BIN="${CRATE_DIR}/target/release-linux-amd64/kordi-cloud-server"
LOCAL_TAR="/tmp/kordi-cloud-server-${IMAGE_TAG}.tar.gz"
REMOTE_TAR="/tmp/kordi-cloud-server-${IMAGE_TAG}.tar.gz"

echo "[deploy] image tag:    ${IMAGE_TAG}"

echo "[deploy] pulling binary back from VM"
mkdir -p "${CRATE_DIR}/target/release-linux-amd64"
gcloud compute scp --zone "${SSH_ZONE}" \
    "${SSH_TARGET}:${REMOTE_DEPLOY}/target/release/kordi-cloud-server" \
    "${LOCAL_BIN}"

echo "[deploy] building runtime image (linux/amd64) locally"
docker build \
    --platform linux/amd64 \
    -t "${IMAGE}" \
    -f "${CRATE_DIR}/Dockerfile.runtime" \
    "${CRATE_DIR}"

echo "[deploy] saving image tar"
docker save "${IMAGE}" | gzip > "${LOCAL_TAR}"
ls -lh "${LOCAL_TAR}"

echo "[deploy] shipping tar to VM"
gcloud compute scp --zone "${SSH_ZONE}" "${LOCAL_TAR}" "${SSH_TARGET}:${REMOTE_TAR}"

echo "[deploy] importing to k3s containerd"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
    --command "set -e; gunzip -c ${REMOTE_TAR} | sudo k3s ctr images import -; sudo k3s ctr images ls | grep kordi-cloud-server | head -3"

echo "[deploy] applying cluster manifests with image=${IMAGE}"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
    --command "cd ${REMOTE_DEPLOY}/bridges/cloud-server/deploy/k3s/manifests && \
        sed 's|image: kordi-cloud-server:dev|image: docker.io/library/${IMAGE}|' cloud-server-deployment.yaml | kubectl apply -f -"

echo "[deploy] waiting for rollout"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
    --command "kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s"

echo "[deploy] verifying /health"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
    --command "kubectl -n kordi-cloud get pods,svc -l app.kubernetes.io/name=kordi-cloud-server -o wide; \
               kubectl -n kordi-cloud run -i --rm health-check --image=curlimages/curl:8.10.1 --restart=Never -- \
                 -sS http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081/health"

echo "[deploy] cleaning up tar files"
rm -f "${LOCAL_TAR}"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
    --command "rm -f ${REMOTE_TAR}"

echo "[deploy] done. image=${IMAGE}"
