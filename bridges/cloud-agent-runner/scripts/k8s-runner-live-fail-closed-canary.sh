#!/usr/bin/env bash
# Manual live queue canary. It creates exactly one controlled fallback run with
# no provider-auth snapshot and verifies the runner fails it closed.

set -euo pipefail

if [[ "${CONFIRM_KORDI_RUNNER_LIVE_CANARY:-}" != "1" ]]; then
  echo "Set CONFIRM_KORDI_RUNNER_LIVE_CANARY=1 to run the live fail-closed canary." >&2
  exit 2
fi

namespace="${KORDI_CLOUD_SANDBOX_NAMESPACE:-kordi-cloud}"
deployment="kordi-cloud-agent-runner"
postgres_pod="${KORDI_CLOUD_POSTGRES_POD:-postgres-0}"
suffix="${KORDI_CLOUD_LIVE_CANARY_ID:-$(date +%s)}"
owner="acct_live_canary_owner_${suffix}"
requester="acct_live_canary_requester_${suffix}"
sandbox_id="cas_live_fail_${suffix}"
run_id="car_live_fail_${suffix}"
session_id="session:direct-person:${owner}:${requester}"
request_message_id="msg_live_fail_${suffix}"

psql_exec() {
  kubectl -n "$namespace" exec -i "$postgres_pod" -- \
    psql -U kordi -d kordi_cloud -v ON_ERROR_STOP=1 "$@"
}

psql_scalar() {
  psql_exec -At -F '|' "$@"
}

runner_pods() {
  kubectl -n "$namespace" get pods -l app.kubernetes.io/name=kordi-cloud-agent-runner --no-headers 2>/dev/null || true
}

wait_for_no_runner_pods() {
  echo "[live-canary] waiting for runner pods to terminate"
  for _ in $(seq 1 60); do
    local pods
    pods="$(runner_pods)"
    if [[ -z "$pods" ]] || grep -q "No resources found" <<<"$pods"; then
      echo "[live-canary] No runner pods remain"
      return 0
    fi
    sleep 1
  done
  echo "[live-canary] runner pods did not terminate:" >&2
  runner_pods >&2
  return 1
}

cleanup() {
  echo "[live-canary] restoring runner idle mode and scaling to 0"
  kubectl -n "$namespace" set env "deployment/${deployment}" KORDI_CLOUD_RUNNER_CANARY_IDLE=1 >/dev/null 2>&1 || true
  kubectl -n "$namespace" scale "deployment/${deployment}" --replicas=0 >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[live-canary] verifying deployment starts safe"
kubectl -n "$namespace" get "deployment/${deployment}" >/dev/null
replicas="$(kubectl -n "$namespace" get "deployment/${deployment}" -o jsonpath='{.spec.replicas}')"
if [[ "$replicas" != "0" ]]; then
  echo "[live-canary] refusing to start: expected runner replicas=0, got ${replicas}" >&2
  exit 1
fi

idle_value="$(kubectl -n "$namespace" get "deployment/${deployment}" -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="KORDI_CLOUD_RUNNER_CANARY_IDLE")]}{.value}{end}')"
if [[ "$idle_value" != "1" ]]; then
  echo "[live-canary] refusing to start: expected KORDI_CLOUD_RUNNER_CANARY_IDLE=1, got ${idle_value:-<missing>}" >&2
  exit 1
fi

active_runs="$(psql_scalar -c "SELECT COUNT(*) FROM cloud_agent_fallback_runs WHERE status IN ('queued','leased','running')")"
if [[ "$active_runs" != "0" ]]; then
  echo "[live-canary] refusing to start: found ${active_runs} active fallback runs" >&2
  exit 1
fi

echo "[live-canary] seeding controlled run ${run_id}"
psql_exec \
  -v owner="$owner" \
  -v requester="$requester" \
  -v sandbox_id="$sandbox_id" \
  -v run_id="$run_id" \
  -v session_id="$session_id" \
  -v request_message_id="$request_message_id" <<'SQL'
WITH now_text AS (
  SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS value
)
INSERT INTO cloud_accounts (account_id, display_name, primary_email, created_at, updated_at)
SELECT :'owner', 'Live Canary Owner', :'owner' || '@canary.kordi.local', value, value FROM now_text
ON CONFLICT (account_id) DO NOTHING;
WITH now_text AS (
  SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS value
)
INSERT INTO cloud_accounts (account_id, display_name, primary_email, created_at, updated_at)
SELECT :'requester', 'Live Canary Requester', :'requester' || '@canary.kordi.local', value, value FROM now_text
ON CONFLICT (account_id) DO NOTHING;
WITH now_text AS (
  SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS value
)
INSERT INTO cloud_agent_sandboxes (
  sandbox_id, owner_account_id, requester_account_id, session_id, scope, status,
  workspace_key, storage_bytes_used, storage_bytes_quota, created_at, last_active_at, expires_at
)
SELECT :'sandbox_id', :'owner', :'requester', :'session_id', 'requester_isolated', 'active',
       'live-canary:' || :'sandbox_id', 0, 536870912, value, value, value
FROM now_text
ON CONFLICT (sandbox_id) DO NOTHING;
WITH now_text AS (
  SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS value
)
INSERT INTO cloud_agent_fallback_runs (
  run_id, idempotency_key, request_message_id, session_id, owner_account_id,
  requester_account_id, status, prompt, sandbox_id, created_at, updated_at
)
SELECT :'run_id', 'live-canary:' || :'run_id', :'request_message_id', :'session_id', :'owner',
       :'requester', 'queued', '@Canary prove missing provider auth fails closed', :'sandbox_id', value, value
FROM now_text;
SQL

provider_snapshots="$(psql_scalar -v owner="$owner" -c "SELECT COUNT(*) FROM cloud_agent_provider_auth_snapshots WHERE account_id = :'owner' AND revoked_at IS NULL")"
if [[ "$provider_snapshots" != "0" ]]; then
  echo "[live-canary] expected zero provider snapshots for ${owner}, got ${provider_snapshots}" >&2
  exit 1
fi

echo "[live-canary] enabling runner polling for one controlled run with KORDI_CLOUD_RUNNER_CANARY_IDLE=0"
kubectl -n "$namespace" set env "deployment/${deployment}" KORDI_CLOUD_RUNNER_CANARY_IDLE=0
kubectl -n "$namespace" scale "deployment/${deployment}" --replicas=1
kubectl -n "$namespace" rollout status "deployment/${deployment}" --timeout=180s

echo "[live-canary] waiting for run ${run_id} to fail closed"
result=""
status=""
error_code=""
response_message_id=""
artifact_count=""
for _ in $(seq 1 60); do
  result="$(psql_scalar -v run_id="$run_id" -c "
    SELECT status || '|' || COALESCE(error_code,'') || '|' || COALESCE(response_message_id,'') || '|' ||
           (SELECT COUNT(*) FROM cloud_agent_run_artifacts WHERE run_id = :'run_id')::TEXT
    FROM cloud_agent_fallback_runs WHERE run_id = :'run_id'")"
  IFS='|' read -r status error_code response_message_id artifact_count <<<"$result"
  if [[ "$status" == "failed" ]]; then
    break
  fi
  sleep 2
done

if [[ "${status:-}" != "failed" || "${error_code:-}" != "missing_provider_auth" ]]; then
  echo "[live-canary] expected failed|missing_provider_auth, got ${result:-<empty>}" >&2
  exit 1
fi
if [[ -n "${response_message_id:-}" ]]; then
  echo "[live-canary] expected empty response_message_id, got ${response_message_id}" >&2
  exit 1
fi
if [[ "${artifact_count:-}" != "0" ]]; then
  echo "[live-canary] expected zero artifacts, got ${artifact_count}" >&2
  exit 1
fi

echo "[live-canary] observed ${run_id}: status=${status} error_code=${error_code} response_message_id=<empty> artifacts=0"

cleanup
trap - EXIT
final_replicas="$(kubectl -n "$namespace" get "deployment/${deployment}" -o jsonpath='{.spec.replicas}')"
if [[ "$final_replicas" != "0" ]]; then
  echo "[live-canary] final replicas check failed: ${final_replicas}" >&2
  exit 1
fi
wait_for_no_runner_pods

echo "[live-canary] ok"
