#!/usr/bin/env bash
#
# deploy-cloud-server.sh — RUN LOCALLY, build runs on the VM.
#
# After the binary is built on takotako (via cargo build --release on the
# synced source), this script:
#   1. Assembles the OCI runtime image with `buildah bud` on the VM.
#   2. Tags it as docker.io/library/kordi-cloud-server:<tag> so kubelet's
#      bare-name resolution finds it without trying Docker Hub.
#   3. Exports it to an OCI archive and imports into k3s's containerd.
#   4. Applies the Deployment + Service manifests with the new tag.
#   5. Waits for rollout, hits /health from inside the cluster.
#
# No Docker daemon needed on the laptop. Idempotent: re-running with a
# fresh binary triggers a rolling restart via image-tag rotation.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:-shu_yang@takotako}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:-us-central1-c}"
REMOTE_DEPLOY="${KORDI_CLOUD_REMOTE_DIR:-/home/shu_yang/kordi-cloud-server-deploy}"
IMAGE_TAG="${KORDI_CLOUD_IMAGE_TAG:-dev-$(date +%Y%m%d-%H%M%S)}"
IMAGE="docker.io/library/kordi-cloud-server:${IMAGE_TAG}"

echo "[deploy] image tag: ${IMAGE_TAG}"
echo "[deploy] image ref: ${IMAGE}"

echo "[deploy] syncing Dockerfile.runtime + manifest to VM"
tar -C "${REPO_ROOT}" -czf - \
        bridges/cloud-server/Dockerfile.runtime \
        bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml \
    | gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
        --command "cd ${REMOTE_DEPLOY} && tar -xzf -"

echo "[deploy] building OCI image on VM with buildah"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "set -e
cd ${REMOTE_DEPLOY}
sudo buildah bud --layers -t ${IMAGE} -f bridges/cloud-server/Dockerfile.runtime ."

echo "[deploy] importing into k3s containerd"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "set -e
TAR=/tmp/kordi-cloud-server-${IMAGE_TAG}.tar
sudo rm -f \$TAR
sudo buildah push ${IMAGE} oci-archive:\$TAR:${IMAGE}
sudo k3s ctr images import \$TAR
sudo rm -f \$TAR
sudo k3s ctr images ls | grep kordi-cloud-server | head -3"

echo "[deploy] applying manifest with image=${IMAGE}"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "cd ${REMOTE_DEPLOY}/bridges/cloud-server/deploy/k3s/manifests && \
    sed 's|image: kordi-cloud-server:dev|image: ${IMAGE}|' cloud-server-deployment.yaml | kubectl apply -f -"

echo "[deploy] waiting for rollout"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
    --command "kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s"

echo "[deploy] verifying /health from inside the cluster"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "kubectl -n kordi-cloud get pods,svc -l app.kubernetes.io/name=kordi-cloud-server -o wide
kubectl -n kordi-cloud run hc-${IMAGE_TAG} -i --rm --restart=Never --image=curlimages/curl:8.10.1 --quiet -- \
    -sS http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081/health"

echo "[deploy] done. image=${IMAGE}"
