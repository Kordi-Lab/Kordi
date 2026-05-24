#!/usr/bin/env bash
# Manual Cloud Agent Runner canary. This script temporarily scales the runner to
# one replica and always scales it back to zero on exit.

set -euo pipefail

if [[ "${CONFIRM_KORDI_RUNNER_CANARY:-}" != "1" ]]; then
  echo "Set CONFIRM_KORDI_RUNNER_CANARY=1 to run the Cloud runner canary." >&2
  exit 2
fi

namespace="${KORDI_CLOUD_SANDBOX_NAMESPACE:-kordi-cloud}"
deployment="kordi-cloud-agent-runner"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  echo "[runner-canary] scaling ${deployment} back to 0"
  kubectl -n "$namespace" scale "deployment/${deployment}" --replicas=0 >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[runner-canary] running sandbox smoke first"
"${script_dir}/k8s-sandbox-smoke.sh"

echo "[runner-canary] verifying deployment exists and starts at replicas=0"
kubectl -n "$namespace" get "deployment/${deployment}" >/dev/null
replicas="$(kubectl -n "$namespace" get "deployment/${deployment}" -o jsonpath='{.spec.replicas}')"
if [[ "$replicas" != "0" ]]; then
  echo "[runner-canary] refusing to start: expected replicas=0, got ${replicas}" >&2
  exit 1
fi

echo "[runner-canary] scaling runner to 1"
kubectl -n "$namespace" scale "deployment/${deployment}" --replicas=1
kubectl -n "$namespace" rollout status "deployment/${deployment}" --timeout=180s

echo "[runner-canary] recent runner pods"
kubectl -n "$namespace" get pods -l app.kubernetes.io/name=kordi-cloud-agent-runner -o wide

echo "[runner-canary] recent logs"
kubectl -n "$namespace" logs "deployment/${deployment}" --tail=80 || true

cleanup
trap - EXIT
final_replicas="$(kubectl -n "$namespace" get "deployment/${deployment}" -o jsonpath='{.spec.replicas}')"
if [[ "$final_replicas" != "0" ]]; then
  echo "[runner-canary] final replicas check failed: ${final_replicas}" >&2
  exit 1
fi

echo "[runner-canary] ok; runner is scaled to 0"
