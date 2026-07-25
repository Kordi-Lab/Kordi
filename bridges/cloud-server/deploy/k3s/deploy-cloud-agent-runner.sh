#!/usr/bin/env bash
#
# deploy-cloud-agent-runner.sh — RUN LOCALLY, build runs on the VM.
#
# Builds/imports the Cloud Agent Runner image and applies the runner Deployment
# with one active sandbox-capable worker so queued fallback runs are processed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET to the operator-provided gcloud SSH target}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE to the operator-provided gcloud zone}"
SSH_PROJECT="${KORDI_CLOUD_GCP_PROJECT:-}"
REMOTE_DEPLOY="${KORDI_CLOUD_REMOTE_DIR:-\$HOME/kordi-cloud-server-deploy}"
IMAGE_TAG="${KORDI_CLOUD_RUNNER_IMAGE_TAG:-runner-dev-$(date +%Y%m%d-%H%M%S)}"
IMAGE="docker.io/library/kordi-cloud-agent-runner:${IMAGE_TAG}"

GCLOUD_SSH=(gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}")
if [ -n "${SSH_PROJECT}" ]; then
    GCLOUD_SSH+=(--project "${SSH_PROJECT}")
fi

echo "[runner-deploy] image tag: ${IMAGE_TAG}"
echo "[runner-deploy] image ref: ${IMAGE}"

echo "[runner-deploy] syncing runner Dockerfile + manifest to VM"
tar -C "${REPO_ROOT}" -czf - \
    bridges/cloud-agent-runner/Dockerfile.runtime \
    bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner-deployment.yaml \
  | "${GCLOUD_SSH[@]}" \
      --command "cd ${REMOTE_DEPLOY} && tar -xzf -"

echo "[runner-deploy] building runner binary on VM"
"${GCLOUD_SSH[@]}" --command "set -e
cd ${REMOTE_DEPLOY}
\$HOME/.cargo/bin/cargo build --release -p kordi-cloud-agent-runner"

echo "[runner-deploy] building OCI image on VM with buildah"
"${GCLOUD_SSH[@]}" --command "set -e
cd ${REMOTE_DEPLOY}
sudo buildah bud --layers -t ${IMAGE} -f bridges/cloud-agent-runner/Dockerfile.runtime ."

echo "[runner-deploy] importing into k3s containerd"
"${GCLOUD_SSH[@]}" --command "set -e
TAR=/tmp/kordi-cloud-agent-runner-${IMAGE_TAG}.tar
sudo rm -f \$TAR
sudo buildah push ${IMAGE} oci-archive:\$TAR:${IMAGE}
sudo k3s ctr images import \$TAR
sudo rm -f \$TAR
sudo k3s ctr images ls | grep kordi-cloud-agent-runner | head -3"

echo "[runner-deploy] applying runner manifest with image=${IMAGE}"
"${GCLOUD_SSH[@]}" --command "cd ${REMOTE_DEPLOY}/bridges/cloud-server/deploy/k3s/manifests && \
    sed 's|image: kordi-cloud-agent-runner:dev|image: ${IMAGE}|' cloud-agent-runner-deployment.yaml | kubectl apply -f -"

echo "[runner-deploy] enabling live queue processing"
"${GCLOUD_SSH[@]}" \
    --command "kubectl -n kordi-cloud set env deployment/kordi-cloud-agent-runner KORDI_CLOUD_RUNNER_CANARY_IDLE=0 KORDI_CLOUD_RUNNER_CANARY_RUN_ID- && kubectl -n kordi-cloud scale deployment/kordi-cloud-agent-runner --replicas=1"

echo "[runner-deploy] verifying deployment has one active runner"
"${GCLOUD_SSH[@]}" --command "set -e
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-agent-runner --timeout=180s
kubectl -n kordi-cloud wait \
  --for=condition=Ready \
  pod \
  -l app.kubernetes.io/name=kordi-cloud-agent-runner \
  --timeout=180s
sleep 10
replicas=\$(kubectl -n kordi-cloud get deployment kordi-cloud-agent-runner -o jsonpath='{.spec.replicas}')
available=\$(kubectl -n kordi-cloud get deployment kordi-cloud-agent-runner -o jsonpath='{.status.availableReplicas}')
idle=\$(kubectl -n kordi-cloud get deployment kordi-cloud-agent-runner -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name==\"KORDI_CLOUD_RUNNER_CANARY_IDLE\")].value}')
restarts=\$(kubectl -n kordi-cloud get pods -l app.kubernetes.io/name=kordi-cloud-agent-runner -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.restartCount}{\"\\n\"}{end}{end}' | awk '{ total += \$1 } END { print total + 0 }')
test \"\$replicas\" = \"1\"
test \"\$available\" = \"1\"
test \"\$idle\" = \"0\"
test \"\$restarts\" = \"0\"
kubectl -n kordi-cloud get deployment kordi-cloud-agent-runner -o wide"

echo "[runner-deploy] done. image=${IMAGE}; replicas=1; idle=0"
