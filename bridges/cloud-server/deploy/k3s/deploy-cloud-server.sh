#!/usr/bin/env bash
#
# deploy-cloud-server.sh — RUN LOCALLY, build runs on the VM.
#
# After source is synced to the operator-provided Cloud host, this script:
#   1. Builds the binary and OCI runtime image against Bookworm with `buildah
#      bud` on the VM.
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
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET to the operator-provided gcloud SSH target}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE to the operator-provided gcloud zone}"
SSH_PROJECT="${KORDI_CLOUD_GCP_PROJECT:?Set KORDI_CLOUD_GCP_PROJECT to the operator-provided GCP project}"
REMOTE_DEPLOY="${KORDI_CLOUD_REMOTE_DIR:-\$HOME/kordi-cloud-server-deploy}"
IMAGE_TAG="${KORDI_CLOUD_IMAGE_TAG:-dev-$(date +%Y%m%d-%H%M%S)}"
IMAGE="docker.io/library/kordi-cloud-server:${IMAGE_TAG}"
EXPECT_UNPUBLISHED_RELEASE="${KORDI_EXPECT_DESKTOP_RELEASE_UNPUBLISHED:-true}"
VERIFY_PUBLIC_ORIGINS="${KORDI_VERIFY_PUBLIC_ORIGINS:-true}"
VERIFY_RESOLVE_IP="${KORDI_VERIFY_RESOLVE_IP:-}"
PUBLIC_ORIGIN="${KORDI_CLOUD_PUBLIC_BASE_URL:-https://kordi.ai}"
LEGACY_ORIGIN="${KORDI_CLOUD_LEGACY_BASE_URL:-https://coordinar.io}"

GCLOUD_SSH=(gcloud compute ssh "${SSH_TARGET}" --zone "${SSH_ZONE}" --project "${SSH_PROJECT}")

echo "[deploy] target:    ${SSH_TARGET} (project ${SSH_PROJECT}, zone ${SSH_ZONE})"
echo "[deploy] image tag: ${IMAGE_TAG}"
echo "[deploy] image ref: ${IMAGE}"

echo "[deploy] syncing Dockerfile.runtime + manifest to VM"
tar -C "${REPO_ROOT}" -czf - \
        bridges/cloud-server/Dockerfile.runtime \
        bridges/cloud-server/deploy/k3s/manifests/minio.yaml \
        bridges/cloud-server/deploy/k3s/manifests/livekit.yaml \
        bridges/cloud-server/deploy/k3s/manifests/cloud-server-deployment.yaml \
    | "${GCLOUD_SSH[@]}" \
        --command "cd ${REMOTE_DEPLOY} && tar -xzf -"

echo "[deploy] building OCI image on VM with buildah"
"${GCLOUD_SSH[@]}" --command "set -e
cd ${REMOTE_DEPLOY}
sudo buildah bud --layers -t ${IMAGE} -f bridges/cloud-server/Dockerfile.runtime ."

echo "[deploy] smoke-testing the image entrypoint"
"${GCLOUD_SSH[@]}" --command "set -e
container=\$(sudo buildah from ${IMAGE})
cleanup() { sudo buildah rm \"\$container\" >/dev/null; }
trap cleanup EXIT
set +e
output=\$(sudo buildah run \"\$container\" -- timeout 5 /usr/local/bin/kordi-cloud-server --help 2>&1)
status=\$?
set -e
printf '%s\\n' \"\$output\"
if printf '%s' \"\$output\" | grep -Eq 'GLIBC_[0-9.]+.*not found|No such file or directory'; then
  echo '[deploy] entrypoint failed its runtime ABI check' >&2
  exit 1
fi
test \"\$status\" -ne 126
test \"\$status\" -ne 127"

echo "[deploy] importing into k3s containerd"
"${GCLOUD_SSH[@]}" --command "set -e
TAR=/tmp/kordi-cloud-server-${IMAGE_TAG}.tar
sudo rm -f \$TAR
sudo buildah push ${IMAGE} oci-archive:\$TAR:${IMAGE}
sudo k3s ctr images import \$TAR
sudo rm -f \$TAR
sudo k3s ctr images ls | grep kordi-cloud-server | head -3"

echo "[deploy] reconciling private release storage"
"${GCLOUD_SSH[@]}" --command "set -e
cd ${REMOTE_DEPLOY}/bridges/cloud-server/deploy/k3s/manifests
kubectl -n kordi-cloud delete job/minio-bucket-init --ignore-not-found=true --wait=true >/dev/null
kubectl apply -f minio.yaml >/dev/null
kubectl -n kordi-cloud rollout status statefulset/minio --timeout=180s
kubectl -n kordi-cloud wait --for=condition=complete job/minio-bucket-init --timeout=180s >/dev/null
kubectl -n kordi-cloud get secret kordi-release-reader -o jsonpath='{.data.access-key}' | grep -q .
kubectl -n kordi-cloud get secret kordi-release-reader -o jsonpath='{.data.secret-key}' | grep -q .
kubectl -n kordi-cloud delete pod/release-store-check --ignore-not-found=true --wait=true >/dev/null
cat <<'YAML' | kubectl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: release-store-check
  namespace: kordi-cloud
spec:
  restartPolicy: Never
  containers:
    - name: mc
      image: minio/mc:RELEASE.2024-11-21T17-21-54Z
      env:
        - name: ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: kordi-release-reader
              key: access-key
        - name: SECRET_KEY
          valueFrom:
            secretKeyRef:
              name: kordi-release-reader
              key: secret-key
      command:
        - sh
        - -c
        - |
          set -eu
          mc alias set release http://minio.kordi-cloud.svc.cluster.local:9000 \"\$ACCESS_KEY\" \"\$SECRET_KEY\" >/dev/null
          mc stat release/kordi-releases >/dev/null
          echo release-store-ready
YAML
kubectl -n kordi-cloud wait --for=jsonpath='{.status.phase}'=Succeeded pod/release-store-check --timeout=120s >/dev/null
kubectl -n kordi-cloud logs pod/release-store-check
kubectl -n kordi-cloud delete pod/release-store-check --wait=true >/dev/null"

echo "[deploy] reconciling call media"
"${GCLOUD_SSH[@]}" --command "set -e
kubectl -n kordi-cloud get secret kordi-livekit -o jsonpath='{.data.url}' | grep -q .
kubectl -n kordi-cloud get secret kordi-livekit -o jsonpath='{.data.api-key}' | grep -q .
kubectl -n kordi-cloud get secret kordi-livekit -o jsonpath='{.data.api-secret}' | grep -q .
kubectl -n kordi-cloud get secret kordi-livekit -o jsonpath='{.data.keys}' | grep -q .
kubectl apply -f ${REMOTE_DEPLOY}/bridges/cloud-server/deploy/k3s/manifests/livekit.yaml >/dev/null
kubectl -n kordi-cloud rollout status deployment/livekit --timeout=180s"

echo "[deploy] applying manifest with image=${IMAGE}"
"${GCLOUD_SSH[@]}" --command "set -e
if ! kubectl -n kordi-cloud get secret kordi-chat-sync >/dev/null 2>&1; then
    CURSOR_SECRET=\$(kubectl -n kordi-cloud get secret kordi-chat-sync-v2 -o jsonpath='{.data.KORDI_CHAT_SYNC_CURSOR_SECRET}' 2>/dev/null || true)
    if [ -n \"\$CURSOR_SECRET\" ]; then
        printf '%s' \"\$CURSOR_SECRET\" | base64 --decode | kubectl -n kordi-cloud create secret generic kordi-chat-sync --from-file=KORDI_CHAT_SYNC_CURSOR_SECRET=/dev/stdin >/dev/null
    fi
fi"
"${GCLOUD_SSH[@]}" --command "cd ${REMOTE_DEPLOY}/bridges/cloud-server/deploy/k3s/manifests && \
    sed 's|image: kordi-cloud-server:dev|image: ${IMAGE}|' cloud-server-deployment.yaml | kubectl apply -f -"

echo "[deploy] waiting for rollout"
"${GCLOUD_SSH[@]}" \
    --command "kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s"

echo "[deploy] verifying /health from inside the cluster"
"${GCLOUD_SSH[@]}" --command "kubectl -n kordi-cloud get pods,svc -l app.kubernetes.io/name=kordi-cloud-server -o wide
kubectl -n kordi-cloud run hc-${IMAGE_TAG} -i --rm --restart=Never --image=curlimages/curl:8.10.1 --quiet -- \
    -sS http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081/health"

echo "[deploy] verifying /health through the host NodePort"
"${GCLOUD_SSH[@]}" --command "curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:30081/health >/dev/null"

echo "[deploy] verifying safe legacy updater fallback"
"${GCLOUD_SSH[@]}" --command "kubectl -n kordi-cloud run legacy-${IMAGE_TAG} -i --rm --restart=Never --image=curlimages/curl:8.10.1 --quiet --command -- sh -c '
set -eu
BASE=http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081
LEGACY=\$(curl -fsS \"\$BASE/updates/releases/version\")
printf %s \"\$LEGACY\" | grep -q \"\\\"version\\\":\\\"0.0.1-beta.\"
if printf %s \"\$LEGACY\" | grep -q \"\\\"downloadUrl\\\"\"; then
  echo legacy-response-must-not-authorize-native-installation >&2
  exit 1
fi
echo legacy-manual-bootstrap-ready
'"

if [ "${EXPECT_UNPUBLISHED_RELEASE}" = "true" ]; then
    echo "[deploy] verifying unpublished beta channel returns 204"
    UPDATE_STATUS="$("${GCLOUD_SSH[@]}" --command "kubectl -n kordi-cloud run updater-${IMAGE_TAG} -i --rm --restart=Never --image=curlimages/curl:8.10.1 --quiet -- -sS -o /dev/null -w '%{http_code}' http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081/updates/desktop/darwin/aarch64/0.0.1-beta.5")"
    if [ "${UPDATE_STATUS}" != "204" ]; then
        echo "[deploy] expected unpublished updater status 204, got ${UPDATE_STATUS}" >&2
        exit 1
    fi
fi

verify_product_origin() {
    local origin="$1"
    local label="$2"
    local headers
    local origin_host
    # Keep the array non-empty for Bash 3.2 (the macOS system shell), where
    # expanding an empty local array under `set -u` raises an unbound error.
    local -a resolve_args=(--connect-timeout 20)
    local status
    headers="$(mktemp)"
    trap 'rm -f "${headers}"' RETURN

    if [ -n "${VERIFY_RESOLVE_IP}" ]; then
        if [[ "${origin}" != https://* ]]; then
            echo "[deploy] ${label}: pre-DNS resolution requires an HTTPS origin" >&2
            return 1
        fi
        origin_host="${origin#https://}"
        origin_host="${origin_host%%/*}"
        origin_host="${origin_host%%:*}"
        resolve_args=(--resolve "${origin_host}:443:${VERIFY_RESOLVE_IP}")
    fi

    status="$(curl --silent --show-error --max-time 20 \
        "${resolve_args[@]}" \
        --output /dev/null --write-out '%{http_code}' \
        "${origin}/health")"
    if [ "${status}" != "200" ]; then
        echo "[deploy] ${label}: expected direct health status 200, got ${status}" >&2
        return 1
    fi

    status="$(curl --silent --show-error --max-time 20 \
        "${resolve_args[@]}" \
        --dump-header "${headers}" --output /dev/null --write-out '%{http_code}' \
        --request OPTIONS \
        --header 'Origin: tauri://localhost' \
        --header 'Access-Control-Request-Method: POST' \
        --header 'Access-Control-Request-Headers: content-type' \
        "${origin}/v1/cloud/auth/login")"
    if [ "${status}" != "200" ]; then
        echo "[deploy] ${label}: expected direct login preflight status 200, got ${status}" >&2
        return 1
    fi
    if ! grep -Eiq '^access-control-allow-origin:[[:space:]]*(\*|tauri://localhost)' "${headers}"; then
        echo "[deploy] ${label}: login preflight is missing an allowed CORS origin" >&2
        return 1
    fi

    status="$(curl --silent --show-error --max-time 20 \
        "${resolve_args[@]}" \
        --output /dev/null --write-out '%{http_code}' \
        "${origin}/updates/releases/version")"
    if [ "${status}" != "200" ]; then
        echo "[deploy] ${label}: expected direct updater metadata status 200, got ${status}" >&2
        return 1
    fi
    rm -f "${headers}"
    trap - RETURN
}

if [ "${VERIFY_PUBLIC_ORIGINS}" = "true" ]; then
    echo "[deploy] verifying canonical and legacy public product routes"
    verify_product_origin "${PUBLIC_ORIGIN}" "canonical origin"
    verify_product_origin "${LEGACY_ORIGIN}" "legacy origin"
else
    echo "[deploy] skipping public-origin checks for pre-DNS staging"
fi

echo "[deploy] done. image=${IMAGE}"
