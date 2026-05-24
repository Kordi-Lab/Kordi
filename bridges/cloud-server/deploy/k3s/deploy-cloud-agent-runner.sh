#!/usr/bin/env bash
#
# deploy-cloud-agent-runner.sh — RUN LOCALLY, build runs on the VM.
#
# Builds/imports the Cloud Agent Runner image and applies the runner Deployment
# at zero replicas. It intentionally does not leave a live runner consuming
# queued fallback runs. Use k8s-runner-canary.sh for an explicit temporary scale-up.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:-shu_yang@takotako}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:-us-central1-c}"
REMOTE_DEPLOY="${KORDI_CLOUD_REMOTE_DIR:-/home/shu_yang/kordi-cloud-server-deploy}"
IMAGE_TAG="${KORDI_CLOUD_RUNNER_IMAGE_TAG:-runner-dev-$(date +%Y%m%d-%H%M%S)}"
IMAGE="docker.io/library/kordi-cloud-agent-runner:${IMAGE_TAG}"

echo "[runner-deploy] image tag: ${IMAGE_TAG}"
echo "[runner-deploy] image ref: ${IMAGE}"

echo "[runner-deploy] syncing runner Dockerfile + manifest to VM"
tar -C "${REPO_ROOT}" -czf - \
    bridges/cloud-agent-runner/Dockerfile.runtime \
    bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner-deployment.yaml \
  | gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
      --command "cd ${REMOTE_DEPLOY} && tar -xzf -"

echo "[runner-deploy] building runner binary on VM"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "set -e
cd ${REMOTE_DEPLOY}
\$HOME/.cargo/bin/cargo build --release -p kordi-cloud-agent-runner"

echo "[runner-deploy] building OCI image on VM with buildah"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "set -e
cd ${REMOTE_DEPLOY}
sudo buildah bud --layers -t ${IMAGE} -f bridges/cloud-agent-runner/Dockerfile.runtime ."

echo "[runner-deploy] importing into k3s containerd"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "set -e
TAR=/tmp/kordi-cloud-agent-runner-${IMAGE_TAG}.tar
sudo rm -f \$TAR
sudo buildah push ${IMAGE} oci-archive:\$TAR:${IMAGE}
sudo k3s ctr images import \$TAR
sudo rm -f \$TAR
sudo k3s ctr images ls | grep kordi-cloud-agent-runner | head -3"

echo "[runner-deploy] applying runner manifest with image=${IMAGE}"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "cd ${REMOTE_DEPLOY}/bridges/cloud-server/deploy/k3s/manifests && \
    sed 's|image: kordi-cloud-agent-runner:dev|image: ${IMAGE}|' cloud-agent-runner-deployment.yaml | kubectl apply -f -"

echo "[runner-deploy] enforcing zero replicas"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" \
    --command "kubectl -n kordi-cloud scale deployment/kordi-cloud-agent-runner --replicas=0"

echo "[runner-deploy] verifying deployment remains at zero replicas"
gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --command "set -e
replicas=\$(kubectl -n kordi-cloud get deployment kordi-cloud-agent-runner -o jsonpath='{.spec.replicas}')
test \"\$replicas\" = \"0\"
kubectl -n kordi-cloud get deployment kordi-cloud-agent-runner -o wide"

echo "[runner-deploy] done. image=${IMAGE}; replicas=0"
