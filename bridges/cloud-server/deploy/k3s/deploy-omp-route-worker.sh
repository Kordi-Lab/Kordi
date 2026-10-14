#!/usr/bin/env bash
#
# deploy-omp-route-worker.sh — RUN LOCALLY, every mutation runs on the VM.
#
# First-time bootstrap of the OMP route worker on a k3s product host. Later
# image changes go through the protected Deploy production workflow, which
# changes only images and fails until this bootstrap has run. This script:
#   1. Verifies a downloaded Backend delivery bundle against its revision and
#      build run, then copies only the worker OCI archive and manifest.
#   2. Under the shared host deployment lock, imports the archive into k3s
#      containerd, checks the approved digest, and pins a digest reference.
#   3. Creates Secret kordi-omp-route-worker with a random token generated on
#      the host when it does not exist. The token is never printed.
#   4. Applies the worker Deployment, Service, and NetworkPolicy, waits for the
#      rollout, and checks /health and bearer enforcement inside the pod.
#   5. Adds the worker URL and token to kordi-cloud-server and waits for it.
#   6. Checks the public provider catalog.
#
# Idempotent: rerunning keeps the existing token and reapplies the manifest.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET to the operator-provided gcloud SSH target}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE to the operator-provided gcloud zone}"
SSH_PROJECT="${KORDI_CLOUD_GCP_PROJECT:?Set KORDI_CLOUD_GCP_PROJECT to the operator-provided GCP project}"
BUNDLE="${KORDI_OMP_ROUTE_WORKER_BUNDLE:?Set KORDI_OMP_ROUTE_WORKER_BUNDLE to a downloaded Backend delivery bundle directory}"
BUNDLE_SHA="${KORDI_OMP_ROUTE_WORKER_SHA:?Set KORDI_OMP_ROUTE_WORKER_SHA to the bundle revision}"
BUNDLE_RUN_ID="${KORDI_OMP_ROUTE_WORKER_RUN_ID:?Set KORDI_OMP_ROUTE_WORKER_RUN_ID to the Backend delivery run ID}"
LOCK_DIR="${KORDI_BACKEND_LOCK_DIR:?Set KORDI_BACKEND_LOCK_DIR to the shared host deployment lock directory}"
PUBLIC_ORIGIN="${KORDI_CLOUD_PUBLIC_BASE_URL:-https://kordi.ai}"
MANIFEST=bridges/cloud-server/deploy/k3s/manifests/omp-route-worker-deployment.yaml

GCLOUD_SSH=(gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --project "${SSH_PROJECT}")
GCLOUD_SCP=(gcloud compute scp --zone "${SSH_ZONE}" --project "${SSH_PROJECT}")

echo "[worker-deploy] target: ${SSH_TARGET} (project ${SSH_PROJECT}, zone ${SSH_ZONE})"

echo "[worker-deploy] verifying the bundle for ${BUNDLE_SHA} (run ${BUNDLE_RUN_ID})"
python3 "${REPO_ROOT}/scripts/backend_artifact.py" verify \
    --directory "${BUNDLE}" --sha "${BUNDLE_SHA}" --run-id "${BUNDLE_RUN_ID}"
read -r IMAGE_TAG IMAGE_DIGEST < <(python3 -c '
import json, sys
image = json.load(open(sys.argv[1]))["images"]["omp-route-worker"]
print(image["tag"], image["digest"])' "${BUNDLE}/backend-manifest.json")
echo "[worker-deploy] image: ${IMAGE_TAG} (${IMAGE_DIGEST})"

echo "[worker-deploy] copying the worker archive and manifest"
REMOTE="$("${GCLOUD_SSH[@]}" --command 'umask 077; mktemp -d /tmp/kordi-omp-worker.XXXXXXXX')"
[[ "${REMOTE}" =~ ^/tmp/kordi-omp-worker\.[A-Za-z0-9]+$ ]] || { echo "[worker-deploy] unexpected remote directory" >&2; exit 1; }
cleanup() { "${GCLOUD_SSH[@]}" --command "rm -rf -- '${REMOTE}'" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${GCLOUD_SCP[@]}" "${BUNDLE}/omp-route-worker.oci.tar" "${REPO_ROOT}/${MANIFEST}" "${SSH_TARGET}:${REMOTE}/"

echo "[worker-deploy] bootstrapping under the host deployment lock"
printf -v REMOTE_ARGS '%q ' "${REMOTE}" "${IMAGE_TAG}" "${IMAGE_DIGEST}" "${LOCK_DIR}"
"${GCLOUD_SSH[@]}" --command "bash -s -- ${REMOTE_ARGS}" <<'REMOTE_SCRIPT'
set -euo pipefail
remote="$1"
tag="$2"
digest="$3"
lock_dir="$4"
kubectl=(sudo k3s kubectl --namespace kordi-cloud)
ctr=(sudo k3s ctr --namespace k8s.io)
reference="docker.io/library/kordi-omp-route-worker@${digest}"

exec 9>>"${lock_dir}/host-wide.lock"
flock --wait 1800 9 || { echo "Another deployment still holds the host lock" >&2; exit 1; }

"${ctr[@]}" images import "${remote}/omp-route-worker.oci.tar" >/dev/null
stored="$("${ctr[@]}" images list | awk -v ref="${tag}" '$1 == ref { print $3 }')"
if [ "${stored}" != "${digest}" ]; then
  echo "Imported worker image differs from its approved digest" >&2
  exit 1
fi
if ! "${ctr[@]}" images list --quiet | grep -qxF "${reference}"; then
  "${ctr[@]}" images tag "${tag}" "${reference}" >/dev/null
fi

if ! "${kubectl[@]}" get secret kordi-omp-route-worker >/dev/null 2>&1; then
  # Generated and stored on the host; it never reaches a terminal or a log.
  openssl rand -hex 32 | tr -d '\n' \
    | "${kubectl[@]}" create secret generic kordi-omp-route-worker --from-file=token=/dev/stdin >/dev/null
  echo "created Secret kordi-omp-route-worker"
fi
"${kubectl[@]}" get secret kordi-omp-route-worker -o jsonpath='{.data.token}' | grep -q .

sed "s|image: kordi-omp-route-worker:dev|image: ${reference}|" "${remote}/omp-route-worker-deployment.yaml" \
  | "${kubectl[@]}" apply -f -
"${kubectl[@]}" rollout status deployment/kordi-omp-route-worker --timeout=180s
# /health answers, and a request without the bearer is refused.
"${kubectl[@]}" exec deployment/kordi-omp-route-worker -c worker -- bun -e '
Promise.all([
  fetch("http://127.0.0.1:17331/health"),
  fetch("http://127.0.0.1:17331/login", { method: "POST" }),
]).then(([health, login]) => process.exit(health.ok && login.status === 401 ? 0 : 1), () => process.exit(1));'

"${kubectl[@]}" patch deployment kordi-cloud-server --type=strategic --patch '
{"spec": {"template": {"spec": {"containers": [{"name": "server", "env": [
  {"name": "KORDI_OMP_ROUTE_WORKER_URL", "value": "http://kordi-omp-route-worker:17331"},
  {"name": "KORDI_OMP_ROUTE_WORKER_TOKEN", "valueFrom": {"secretKeyRef":
    {"name": "kordi-omp-route-worker", "key": "token", "optional": true}}}
]}]}}}}'
"${kubectl[@]}" rollout status deployment/kordi-cloud-server --timeout=180s
"${kubectl[@]}" get deployment kordi-omp-route-worker kordi-cloud-server -o wide
REMOTE_SCRIPT

echo "[worker-deploy] verifying the public provider catalog"
status="$(curl --silent --show-error --max-time 20 --output /dev/null --write-out '%{http_code}' \
    "${PUBLIC_ORIGIN}/v1/cloud/agent-provider-auth/catalog")"
if [ "${status}" != "200" ]; then
    echo "[worker-deploy] expected catalog status 200, got ${status}" >&2
    exit 1
fi

echo "[worker-deploy] done. image=docker.io/library/kordi-omp-route-worker@${IMAGE_DIGEST}"
