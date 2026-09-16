#!/usr/bin/env bash
# Provision independent MinIO identities for desktop release reads and writes.
# Run locally. Secret values travel through stdin/files only and are never logged.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
POLICY_DIR="${REPO_ROOT}/bridges/cloud-server/deploy/k3s/policies"
SSH_TARGET="${KORDI_CLOUD_SSH_TARGET:?Set KORDI_CLOUD_SSH_TARGET}"
SSH_ZONE="${KORDI_CLOUD_SSH_ZONE:?Set KORDI_CLOUD_SSH_ZONE}"
GCP_PROJECT="${KORDI_CLOUD_GCP_PROJECT:?Set KORDI_CLOUD_GCP_PROJECT}"
NAMESPACE="kordi-cloud"
BOOTSTRAP_JOB="kordi-release-identity-bootstrap"
BOOTSTRAP_SECRET="kordi-release-publisher-bootstrap"
TMP_DIR="$(mktemp -d /tmp/kordi-release-credentials.XXXXXX)"
BOOTSTRAP_STARTED=0

umask 077
source "${SCRIPT_DIR}/release-credential-utils.sh"

echo "[release-credentials] target: ${SSH_TARGET} (project ${GCP_PROJECT}, zone ${SSH_ZONE})"

remote() {
  gcloud compute ssh "${SSH_TARGET}" \
    --zone "${SSH_ZONE}" \
    --project "${GCP_PROJECT}" \
    --quiet \
    --command "$1"
}

cleanup() {
  if [[ "${BOOTSTRAP_STARTED}" == "1" ]]; then
    remote "kubectl -n ${NAMESPACE} delete job/${BOOTSTRAP_JOB} secret/${BOOTSTRAP_SECRET} --ignore-not-found=true --wait=false >/dev/null" >/dev/null 2>&1 || true
  fi
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT INT TERM

reader_access_file="${TMP_DIR}/reader-access"
reader_secret_file="${TMP_DIR}/reader-secret"
publisher_access_file="${TMP_DIR}/publisher-access"
publisher_access_original_file="${TMP_DIR}/publisher-access-original"
publisher_secret_file="${TMP_DIR}/publisher-secret"

reader_secret_state="$(remote_secret_state "${NAMESPACE}" kordi-release-reader)"
if [[ "${reader_secret_state}" == "present" ]]; then
  remote "kubectl -n ${NAMESPACE} get secret kordi-release-reader -o jsonpath='{.data.access-key}' | base64 -d" >"${reader_access_file}"
  remote "kubectl -n ${NAMESPACE} get secret kordi-release-reader -o jsonpath='{.data.secret-key}' | base64 -d" >"${reader_secret_file}"
elif [[ "${reader_secret_state}" == "absent" ]]; then
  openssl rand -hex 16 | tr -d '\r\n' >"${reader_access_file}"
  openssl rand -base64 36 | tr -d '\n' >"${reader_secret_file}"
else
  echo "release reader secret state is invalid" >&2
  exit 1
fi

load_or_create_gcp_secret() {
  local secret_name="$1"
  local destination="$2"
  local generation_kind="$3"
  if gcloud secrets describe "${secret_name}" --project "${GCP_PROJECT}" --quiet >/dev/null 2>&1; then
    gcloud secrets versions access latest \
      --secret "${secret_name}" \
      --project "${GCP_PROJECT}" \
      --out-file "${destination}" \
      --quiet >/dev/null
    return
  fi
  if [[ "${generation_kind}" == "access" ]]; then
    openssl rand -hex 16 | tr -d '\r\n' >"${destination}"
  else
    openssl rand -base64 36 | tr -d '\n' >"${destination}"
  fi
  gcloud secrets create "${secret_name}" \
    --project "${GCP_PROJECT}" \
    --replication-policy automatic \
    --quiet >/dev/null
  gcloud secrets versions add "${secret_name}" \
    --project "${GCP_PROJECT}" \
    --data-file "${destination}" \
    --quiet >/dev/null
}

load_or_create_gcp_secret \
  "kordi-release-publisher-access-key" \
  "${publisher_access_file}" \
  "access"
load_or_create_gcp_secret \
  "kordi-release-publisher-secret-key" \
  "${publisher_secret_file}" \
  "secret"

cp "${publisher_access_file}" "${publisher_access_original_file}"
normalize_access_key_file "${reader_access_file}"
normalize_access_key_file "${publisher_access_file}"

for value_file in \
  "${reader_access_file}" \
  "${reader_secret_file}" \
  "${publisher_access_file}" \
  "${publisher_secret_file}"; do
  test -s "${value_file}"
  chmod 600 "${value_file}"
done

if ! cmp -s "${publisher_access_original_file}" "${publisher_access_file}"; then
  gcloud secrets versions add "kordi-release-publisher-access-key" \
    --project "${GCP_PROJECT}" \
    --data-file "${publisher_access_file}" \
    --quiet >/dev/null
fi
rm -f "${publisher_access_original_file}"

reader_access_b64="$(base64 <"${reader_access_file}" | tr -d '\n')"
reader_secret_b64="$(base64 <"${reader_secret_file}" | tr -d '\n')"
publisher_access_b64="$(base64 <"${publisher_access_file}" | tr -d '\n')"
publisher_secret_b64="$(base64 <"${publisher_secret_file}" | tr -d '\n')"

{
  printf '%s\n' \
    'apiVersion: v1' \
    'kind: Secret' \
    'metadata:' \
    '  name: kordi-release-reader' \
    "  namespace: ${NAMESPACE}" \
    'type: Opaque' \
    'data:' \
    "  access-key: ${reader_access_b64}" \
    "  secret-key: ${reader_secret_b64}"
} | remote "kubectl apply -f - >/dev/null"

{
  printf '%s\n' \
    'apiVersion: v1' \
    'kind: Secret' \
    'metadata:' \
    "  name: ${BOOTSTRAP_SECRET}" \
    "  namespace: ${NAMESPACE}" \
    'type: Opaque' \
    'data:' \
    "  access-key: ${publisher_access_b64}" \
    "  secret-key: ${publisher_secret_b64}"
} | remote "kubectl apply -f - >/dev/null"

BOOTSTRAP_STARTED=1

tar -C "${POLICY_DIR}" -czf - \
  kordi-releases-reader.json \
  kordi-releases-publisher.json \
  | remote "rm -rf /tmp/kordi-release-policies && mkdir -p /tmp/kordi-release-policies && tar -C /tmp/kordi-release-policies -xzf -"

remote "kubectl -n ${NAMESPACE} create configmap kordi-release-policies \
  --from-file=reader.json=/tmp/kordi-release-policies/kordi-releases-reader.json \
  --from-file=publisher.json=/tmp/kordi-release-policies/kordi-releases-publisher.json \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null"

remote "kubectl -n ${NAMESPACE} delete job/${BOOTSTRAP_JOB} --ignore-not-found=true --wait=true >/dev/null"

cat <<'YAML' | remote "kubectl apply -f - >/dev/null"
apiVersion: batch/v1
kind: Job
metadata:
  name: kordi-release-identity-bootstrap
  namespace: kordi-cloud
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: mc
          image: minio/mc:RELEASE.2024-11-21T17-21-54Z
          env:
            - name: ROOT_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: minio-credentials
                  key: access-key
            - name: ROOT_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: minio-credentials
                  key: secret-key
            - name: READER_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: kordi-release-reader
                  key: access-key
            - name: READER_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: kordi-release-reader
                  key: secret-key
            - name: PUBLISHER_ACCESS_KEY
              valueFrom:
                secretKeyRef:
                  name: kordi-release-publisher-bootstrap
                  key: access-key
            - name: PUBLISHER_SECRET_KEY
              valueFrom:
                secretKeyRef:
                  name: kordi-release-publisher-bootstrap
                  key: secret-key
          volumeMounts:
            - name: policies
              mountPath: /policies
              readOnly: true
          command:
            - sh
            - -c
            - |
              set -eu
              endpoint="http://minio.kordi-cloud.svc.cluster.local:9000"
              mc alias set root "$endpoint" "$ROOT_ACCESS_KEY" "$ROOT_SECRET_KEY" >/dev/null
              mc mb --ignore-existing root/kordi-releases >/dev/null
              mc anonymous set none root/kordi-releases >/dev/null
              mc admin policy create root kordi-releases-reader /policies/reader.json >/dev/null
              mc admin policy create root kordi-releases-publisher /policies/publisher.json >/dev/null
              mc admin user add root "$READER_ACCESS_KEY" "$READER_SECRET_KEY" >/dev/null
              mc admin user add root "$PUBLISHER_ACCESS_KEY" "$PUBLISHER_SECRET_KEY" >/dev/null
              mc admin policy attach root kordi-releases-reader --user "$READER_ACCESS_KEY" >/dev/null
              mc admin policy attach root kordi-releases-publisher --user "$PUBLISHER_ACCESS_KEY" >/dev/null
              anonymous_access="$(mc anonymous get root/kordi-releases)"
              case "$anonymous_access" in
                *private*|*Private*|*PRIVATE*|*none*|*None*|*NONE*|*disabled*|*Disabled*|*DISABLED*) ;;
                *)
                  echo "release bucket must remain private" >&2
                  exit 1
                  ;;
              esac
              mc alias set reader "$endpoint" "$READER_ACCESS_KEY" "$READER_SECRET_KEY" >/dev/null
              mc ls reader/kordi-releases >/dev/null
              if printf test | mc pipe reader/kordi-releases/.reader-write-probe >/dev/null 2>&1; then
                echo "reader unexpectedly has write access" >&2
                exit 1
              fi
              mc alias set publisher "$endpoint" "$PUBLISHER_ACCESS_KEY" "$PUBLISHER_SECRET_KEY" >/dev/null
              immutable_probe="desktop/releases/.publisher-policy-probe/immutable"
              pointer_probe="desktop/channels/.publisher-policy-probe/latest.json"
              printf test | mc pipe "publisher/kordi-releases/$immutable_probe" >/dev/null
              mc stat "publisher/kordi-releases/$immutable_probe" >/dev/null
              if mc rm "publisher/kordi-releases/$immutable_probe" >/dev/null 2>&1; then
                echo "publisher unexpectedly has immutable delete access" >&2
                exit 1
              fi
              printf test | mc pipe "publisher/kordi-releases/$pointer_probe" >/dev/null
              if mc rm "publisher/kordi-releases/$pointer_probe" >/dev/null 2>&1; then
                echo "publisher unexpectedly has pointer delete access" >&2
                exit 1
              fi
              mc rm --force "root/kordi-releases/$immutable_probe" >/dev/null
              mc rm --force "root/kordi-releases/$pointer_probe" >/dev/null
              echo "release identities ready"
      volumes:
        - name: policies
          configMap:
            name: kordi-release-policies
YAML

remote "kubectl -n ${NAMESPACE} wait --for=condition=complete job/${BOOTSTRAP_JOB} --timeout=180s >/dev/null"
remote "kubectl -n ${NAMESPACE} logs job/${BOOTSTRAP_JOB}"
remote "kubectl -n ${NAMESPACE} delete job/${BOOTSTRAP_JOB} secret/${BOOTSTRAP_SECRET} --ignore-not-found=true --wait=true >/dev/null"
BOOTSTRAP_STARTED=0

echo "[release-storage] scoped reader and publisher identities are ready"
