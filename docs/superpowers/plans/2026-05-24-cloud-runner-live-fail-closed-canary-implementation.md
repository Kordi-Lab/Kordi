# Cloud Runner Fail-Closed Live Queue Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual K3s canary that lets the runner poll exactly one controlled run and verifies it fails closed with `missing_provider_auth`.

**Architecture:** A Bash canary script seeds one queue row directly into Postgres, temporarily disables runner idle mode, sets a canary run-id lease filter, scales the runner to one replica, polls Postgres for the expected failed status, then restores idle mode and zero replicas. Static Node tests verify script guardrails.

**Tech Stack:** Bash, kubectl, psql inside `postgres-0`, Kubernetes Deployment patching, Node built-in test runner.

---

## Files

- Create: `bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh`
- Modify: `scripts/cloud-runner-canary-deploy.test.mjs`

## Task 1: Static guardrail tests

- [ ] **Step 1: Write failing static tests**

Extend `scripts/cloud-runner-canary-deploy.test.mjs` with a new `liveCanaryScriptPath` constant and a test named `live fail-closed canary script is gated and restores safe state`.

The test must assert the script:

```js
const liveCanaryScriptPath = 'bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh';

test('live fail-closed canary script is gated and restores safe state', () => {
  assert.ok(fs.existsSync(liveCanaryScriptPath));
  const script = read(liveCanaryScriptPath);
  assert.match(script, /CONFIRM_KORDI_RUNNER_LIVE_CANARY/);
  assert.match(script, /active fallback runs/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_IDLE=0/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_RUN_ID/);
  assert.match(script, /KORDI_CLOUD_RUNNER_CANARY_IDLE=1/);
  assert.match(script, /missing_provider_auth/);
  assert.match(script, /response_message_id/);
  assert.match(script, /cloud_agent_run_artifacts/);
  assert.match(script, /scale "deployment\/\$\{deployment\}" --replicas=1/);
  assert.match(script, /scale "deployment\/\$\{deployment\}" --replicas=0/);
  assert.match(script, /No runner pods remain/);
});
```

Run:

```bash
node --test scripts/cloud-runner-canary-deploy.test.mjs
```

Expected: fail because the script does not exist.

- [ ] **Step 2: Commit the failing test only if needed for review**

Do not commit a red test to the branch. Keep it in the working tree for the TDD red-green cycle.

## Task 2: Implement live fail-closed canary script

- [ ] **Step 1: Create script skeleton**

Create `bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh`:

```bash
#!/usr/bin/env bash
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
```

- [ ] **Step 2: Add helper functions**

Add:

```bash
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
```

- [ ] **Step 3: Add cleanup trap**

Add:

```bash
cleanup() {
  echo "[live-canary] restoring runner idle mode and scaling to 0"
  kubectl -n "$namespace" set env "deployment/${deployment}" KORDI_CLOUD_RUNNER_CANARY_IDLE=1 >/dev/null 2>&1 || true
  kubectl -n "$namespace" scale "deployment/${deployment}" --replicas=0 >/dev/null 2>&1 || true
}
trap cleanup EXIT
```

- [ ] **Step 4: Add preflight checks**

Add:

```bash
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
echo "[live-canary] active fallback runs currently present: ${active_runs}; canary lease is scoped to ${run_id}"
```

- [ ] **Step 5: Seed exactly one controlled run**

Add SQL insertion using unique ids:

```bash
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
```

Verify no provider auth:

```bash
provider_snapshots="$(psql_scalar -v owner="$owner" -c "SELECT COUNT(*) FROM cloud_agent_provider_auth_snapshots WHERE account_id = :'owner' AND revoked_at IS NULL")"
if [[ "$provider_snapshots" != "0" ]]; then
  echo "[live-canary] expected zero provider snapshots for ${owner}, got ${provider_snapshots}" >&2
  exit 1
fi
```

- [ ] **Step 6: Temporarily enable live polling and scale runner**

Add:

```bash
echo "[live-canary] enabling runner polling for one controlled run"
kubectl -n "$namespace" set env "deployment/${deployment}" KORDI_CLOUD_RUNNER_CANARY_IDLE=0 KORDI_CLOUD_RUNNER_CANARY_RUN_ID="$run_id"
kubectl -n "$namespace" scale "deployment/${deployment}" --replicas=1
kubectl -n "$namespace" rollout status "deployment/${deployment}" --timeout=180s
```

- [ ] **Step 7: Poll for missing-provider failure and side-effect checks**

Add:

```bash
echo "[live-canary] waiting for run ${run_id} to fail closed"
result=""
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
```

- [ ] **Step 8: Restore safe state and wait for pods**

Add:

```bash
cleanup
trap - EXIT
final_replicas="$(kubectl -n "$namespace" get "deployment/${deployment}" -o jsonpath='{.spec.replicas}')"
if [[ "$final_replicas" != "0" ]]; then
  echo "[live-canary] final replicas check failed: ${final_replicas}" >&2
  exit 1
fi
wait_for_no_runner_pods

echo "[live-canary] ok"
```

- [ ] **Step 9: Run local tests**

```bash
bash -n bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh
node --test scripts/cloud-runner-canary-deploy.test.mjs
```

Expected: pass.

- [ ] **Step 10: Commit**

```bash
git add bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh scripts/cloud-runner-canary-deploy.test.mjs
git commit -m "test: add fail-closed live runner canary"
```

## Task 3: Verification and PR

- [ ] **Step 1: Local verification**

```bash
node --test scripts/cloud-runner-canary-deploy.test.mjs
bash -n bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh
bash -n bridges/cloud-agent-runner/scripts/k8s-runner-canary.sh
cargo test -p kordi-cloud-agent-runner
```

- [ ] **Step 2: Remote verification**

Sync the new script to takotako:

```bash
tar -czf - bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh \
  | gcloud compute ssh shu_yang@takotako --zone us-central1-c \
      --command 'cd /home/shu_yang/kordi-cloud-server-deploy && tar -xzf -'
```

Run:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command \
  'cd /home/shu_yang/kordi-cloud-server-deploy && CONFIRM_KORDI_RUNNER_LIVE_CANARY=1 bridges/cloud-agent-runner/scripts/k8s-runner-live-fail-closed-canary.sh'
```

Then verify:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command \
  'echo replicas=$(kubectl -n kordi-cloud get deployment kordi-cloud-agent-runner -o jsonpath={.spec.replicas}); kubectl -n kordi-cloud get pods -l app.kubernetes.io/name=kordi-cloud-agent-runner --no-headers || true'
```

Expected:

- script prints `observed ... status=failed error_code=missing_provider_auth response_message_id=<empty> artifacts=0`
- script prints `No runner pods remain`
- final replicas are `0`
- no runner pods remain

- [ ] **Step 3: Open draft PR**

```bash
git push -u origin feature/issue-513-cloud-runner-live-fail-closed-canary
gh pr create --draft --base feature/issue-511-cloud-runner-canary --head feature/issue-513-cloud-runner-live-fail-closed-canary --title "test: add fail-closed cloud runner live canary" --body-file /tmp/issue-513-live-fail-canary-pr.md
```
