#!/usr/bin/env bash
# Manual real-provider live canary. Run from the operator laptop: it resolves
# local Kordi provider auth, publishes it through Cloud server for a controlled
# canary owner, and lets exactly one scoped runner run use it.

set -euo pipefail

if [[ "${CONFIRM_KORDI_RUNNER_REAL_PROVIDER_CANARY:-}" != "1" ]]; then
  echo "Set CONFIRM_KORDI_RUNNER_REAL_PROVIDER_CANARY=1 to run the real-provider canary." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
remote_host="${KORDI_CLOUD_REAL_CANARY_SSH_HOST:-shu_yang@takotako}"
remote_zone="${KORDI_CLOUD_REAL_CANARY_SSH_ZONE:-us-central1-c}"
namespace="${KORDI_CLOUD_SANDBOX_NAMESPACE:-kordi-cloud}"
remote_server_port="${KORDI_CLOUD_SERVER_REMOTE_PORT:-0}"
suffix="${KORDI_CLOUD_REAL_PROVIDER_CANARY_ID:-$(date +%s)}"

payload_file="$(mktemp)"
session_file="$(mktemp)"
remote_script_file="$(mktemp)"
cleanup_local() {
  rm -f "$payload_file" "$session_file" "$remote_script_file"
}
trap cleanup_local EXIT

echo "[real-provider-canary] resolving local provider auth without printing secrets"
(
  cd "$repo_root"
  cargo run -p kordi-cloud-agent-runner --bin cloud-provider-auth-snapshot-payload --quiet >"$payload_file"
)
python3 - <<'PY' "$payload_file"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    body = json.load(fh)
provider = body.get('provider')
auth_choice = body.get('authChoice')
payload = body.get('payload') or {}
if not provider or not auth_choice or not isinstance(payload, dict):
    raise SystemExit('provider-auth snapshot payload is malformed')
if not (payload.get('apiKey') or payload.get('accessToken')):
    raise SystemExit('provider-auth snapshot payload is missing a credential')
print(f"[real-provider-canary] resolved provider={provider} authChoice={auth_choice} credential=<redacted>")
PY
snapshot_b64="$(base64 <"$payload_file" | tr -d '\n')"
session_b64=""
if [[ -n "${KORDI_CLOUD_SESSION_SECRET_PATH:-}" ]]; then
  python3 - <<'PY' "${KORDI_CLOUD_SESSION_SECRET_PATH}" "$session_file"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    session = json.load(fh)
if not session.get('token') or not session.get('accountId'):
    raise SystemExit('cloud session secret must contain token and accountId')
with open(sys.argv[2], 'w', encoding='utf-8') as out:
    json.dump({'token': session['token'], 'accountId': session['accountId']}, out)
print(f"[real-provider-canary] using existing cloud account {session['accountId']} for the canary owner/requester")
PY
  session_b64="$(base64 <"$session_file" | tr -d '\n')"
fi

echo "[real-provider-canary] rendering remote scoped canary script for ${remote_host}"
chmod 600 "$remote_script_file"
cat >"$remote_script_file" <<REMOTE
#!/usr/bin/env bash
set -euo pipefail
namespace='${namespace}'
deployment='kordi-cloud-agent-runner'
postgres_pod='postgres-0'
remote_server_port='${remote_server_port}'
suffix='${suffix}'
snapshot_b64='${snapshot_b64}'
session_b64='${session_b64}'
owner_email="real-provider-owner-${suffix}@canary.kordi.local"
requester_email="real-provider-requester-${suffix}@canary.kordi.local"
password="KordiCanary-${suffix}-Aa1!"
sandbox_id="cas_real_provider_${suffix}"
run_id="car_real_provider_${suffix}"
request_message_id="msg_real_provider_${suffix}"
seeded_run="0"
ids_env="/tmp/kordi-real-provider-canary-${suffix}.env"

psql_exec() {
  kubectl -n "\$namespace" exec -i "\$postgres_pod" -- \
    psql -U kordi -d kordi_cloud -v ON_ERROR_STOP=1 "\$@"
}

psql_scalar() {
  psql_exec -At -F '|' "\$@"
}

runner_pods() {
  kubectl -n "\$namespace" get pods -l app.kubernetes.io/name=kordi-cloud-agent-runner --no-headers 2>/dev/null || true
}

wait_for_no_runner_pods() {
  echo "[real-provider-canary] waiting for runner pods to terminate"
  for _ in \$(seq 1 60); do
    local pods
    pods="\$(runner_pods)"
    if [[ -z "\$pods" ]] || grep -q "No resources found" <<<"\$pods"; then
      echo "[real-provider-canary] No runner pods remain"
      return 0
    fi
    sleep 1
  done
  echo "[real-provider-canary] runner pods did not terminate:" >&2
  runner_pods >&2
  return 1
}

cleanup() {
  local status=\$?
  echo "[real-provider-canary] restoring runner idle mode and scaling to 0"
  kubectl -n "\$namespace" set env "deployment/\${deployment}" KORDI_CLOUD_RUNNER_CANARY_IDLE=1 KORDI_CLOUD_RUNNER_CANARY_RUN_ID- >/dev/null 2>&1 || true
  kubectl -n "\$namespace" scale "deployment/\${deployment}" --replicas=0 >/dev/null 2>&1 || true
  if [[ "\${seeded_run:-0}" == "1" ]]; then
    psql_scalar -c "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', updated_at = to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') WHERE run_id = '\${run_id}' AND status IN ('queued','leased','running')" >/dev/null 2>&1 || true
  fi
  rm -f "\$ids_env"
  return "\$status"
}
trap cleanup EXIT

echo "[real-provider-canary] verifying deployment starts safe"
kubectl -n "\$namespace" get "deployment/\${deployment}" >/dev/null
replicas="\$(kubectl -n "\$namespace" get "deployment/\${deployment}" -o jsonpath='{.spec.replicas}')"
if [[ "\$replicas" != "0" ]]; then
  echo "[real-provider-canary] refusing to start: expected runner replicas=0, got \${replicas}" >&2
  exit 1
fi
idle_value="\$(kubectl -n "\$namespace" get "deployment/\${deployment}" -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="KORDI_CLOUD_RUNNER_CANARY_IDLE")]}{.value}{end}')"
if [[ "\$idle_value" != "1" ]]; then
  echo "[real-provider-canary] refusing to start: expected KORDI_CLOUD_RUNNER_CANARY_IDLE=1, got \${idle_value:-<missing>}" >&2
  exit 1
fi

active_runs="\$(psql_scalar -c "SELECT COUNT(*) FROM cloud_agent_fallback_runs WHERE status IN ('queued','leased','running')")"
echo "[real-provider-canary] active fallback runs currently present: \${active_runs}; canary lease is scoped to \${run_id}"

SNAPSHOT_B64="\$snapshot_b64" SESSION_B64="\$session_b64" OWNER_EMAIL="\$owner_email" REQUESTER_EMAIL="\$requester_email" PASSWORD="\$password" IDS_ENV="\$ids_env" PORT="\$remote_server_port" NAMESPACE="\$namespace" SUFFIX="\$suffix" python3 - <<'PY'
import atexit, base64, datetime, hashlib, json, os, secrets, socket, subprocess, sys, time, urllib.error, urllib.request

port = int(os.environ['PORT'])
if port == 0:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
    probe.close()
snapshot = json.loads(base64.b64decode(os.environ['SNAPSHOT_B64']).decode('utf-8'))
proc = subprocess.Popen(
    ['kubectl', '-n', os.environ['NAMESPACE'], 'port-forward', 'svc/kordi-cloud-server', f'{port}:17081'],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
atexit.register(proc.terminate)
for _ in range(60):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            break
    except OSError:
        time.sleep(1)
else:
    raise SystemExit('cloud server port-forward did not become ready')

base = f'http://127.0.0.1:{port}'
avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

def post(path, body, token=None):
    data = json.dumps(body).encode('utf-8')
    headers = {'content-type': 'application/json'}
    if token:
        headers['authorization'] = f'Bearer {token}'
    req = urllib.request.Request(base + path, data=data, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', 'replace')
        raise SystemExit(f'{path} returned {exc.code}: {detail}')

def signup(email):
    return post('/v1/cloud/auth/signup', {
        'email': email,
        'password': os.environ['PASSWORD'],
        'displayName': email.split('@')[0],
        'avatarUrl': avatar,
    })

def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"

def psql(sql):
    subprocess.run(
        ['kubectl', '-n', os.environ['NAMESPACE'], 'exec', '-i', 'postgres-0', '--', 'psql', '-U', 'kordi', '-d', 'kordi_cloud', '-v', 'ON_ERROR_STOP=1'],
        input=sql.encode('utf-8'),
        check=True,
    )

session_b64 = os.environ.get('SESSION_B64', '').strip()
if session_b64:
    session = json.loads(base64.b64decode(session_b64).decode('utf-8'))
    token = session['token']
    owner_id = session['accountId']
    requester_id = owner_id
else:
    suffix = os.environ['SUFFIX']
    owner_id = f'acct_real_provider_owner_{suffix}'
    requester_id = f'acct_real_provider_requester_{suffix}'
    device_id = f'cdev_real_provider_{suffix}'
    token = 'kordi_cs_' + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('ascii').rstrip('=')
    token_hash = hashlib.sha256(token.encode('utf-8')).hexdigest()
    token_id = f'cs_real_provider_{suffix}'
    now = datetime.datetime.now(datetime.timezone.utc)
    created_at = now.isoformat()
    expires_at = (now + datetime.timedelta(days=1)).isoformat()
    psql(f"""
INSERT INTO cloud_accounts (account_id, display_name, primary_email, avatar_url, created_at, updated_at)
VALUES ({sql_literal(owner_id)}, 'Real Provider Canary Owner', {sql_literal(os.environ['OWNER_EMAIL'])}, NULL, {sql_literal(created_at)}, {sql_literal(created_at)})
ON CONFLICT (account_id) DO NOTHING;
INSERT INTO cloud_accounts (account_id, display_name, primary_email, avatar_url, created_at, updated_at)
VALUES ({sql_literal(requester_id)}, 'Real Provider Canary Requester', {sql_literal(os.environ['REQUESTER_EMAIL'])}, NULL, {sql_literal(created_at)}, {sql_literal(created_at)})
ON CONFLICT (account_id) DO NOTHING;
INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at)
VALUES ({sql_literal(device_id)}, {sql_literal(owner_id)}, 'real-provider-canary', 'real-provider-canary', {sql_literal(created_at)}, {sql_literal(created_at)})
ON CONFLICT (device_id) DO NOTHING;
INSERT INTO cloud_refresh_tokens (token_id, account_id, device_id, token_hash, created_at, expires_at)
VALUES ({sql_literal(token_id)}, {sql_literal(owner_id)}, {sql_literal(device_id)}, {sql_literal(token_hash)}, {sql_literal(created_at)}, {sql_literal(expires_at)})
ON CONFLICT (token_id) DO NOTHING;
""")
post('/v1/cloud/agent-provider-auth/snapshots', snapshot, token=token)
with open(os.environ['IDS_ENV'], 'w', encoding='utf-8') as fh:
    fh.write(f'owner={owner_id}\nrequester={requester_id}\n')
print(f"[real-provider-canary] provider snapshot published for controlled owner {owner_id}")
PY
source "\$ids_env"
session_id="session:direct-person:\${owner}:\${requester}"

provider_snapshots="\$(psql_scalar -c "SELECT COUNT(*) FROM cloud_agent_provider_auth_snapshots WHERE account_id = '\${owner}' AND revoked_at IS NULL")"
if [[ "\$provider_snapshots" == "0" ]]; then
  echo "[real-provider-canary] expected provider snapshot for \${owner}, got 0" >&2
  exit 1
fi

echo "[real-provider-canary] seeding controlled run \${run_id}"
psql_exec \
  -v owner="\$owner" \
  -v requester="\$requester" \
  -v sandbox_id="\$sandbox_id" \
  -v run_id="\$run_id" \
  -v session_id="\$session_id" \
  -v request_message_id="\$request_message_id" <<'SQL'
WITH now_text AS (
  SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS value
)
INSERT INTO cloud_agent_sandboxes (
  sandbox_id, owner_account_id, requester_account_id, session_id, scope, status,
  workspace_key, storage_bytes_used, storage_bytes_quota, created_at, last_active_at, expires_at
)
SELECT :'sandbox_id', :'owner', :'requester', :'session_id', 'requester_isolated', 'active',
       'real-provider-canary:' || :'sandbox_id', 0, 536870912, value, value, value
FROM now_text
ON CONFLICT (sandbox_id) DO NOTHING;
WITH now_text AS (
  SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS value
)
INSERT INTO cloud_agent_fallback_runs (
  run_id, idempotency_key, request_message_id, session_id, owner_account_id,
  requester_account_id, status, prompt, sandbox_id, created_at, updated_at
)
SELECT :'run_id', 'real-provider-canary:' || :'run_id', :'request_message_id', :'session_id', :'owner',
       :'requester', 'queued', '@Canary Reply with a short confirmation that says real-provider-canary-ok.', :'sandbox_id', value, value
FROM now_text;
SQL
seeded_run="1"

echo "[real-provider-canary] enabling runner polling for one controlled run with KORDI_CLOUD_RUNNER_CANARY_IDLE=0"
kubectl -n "\$namespace" set env "deployment/\${deployment}" KORDI_CLOUD_RUNNER_CANARY_IDLE=0 KORDI_CLOUD_RUNNER_CANARY_RUN_ID="\$run_id"
kubectl -n "\$namespace" scale "deployment/\${deployment}" --replicas=1
kubectl -n "\$namespace" rollout status "deployment/\${deployment}" --timeout=180s

echo "[real-provider-canary] waiting for run \${run_id} to complete"
result=""
status=""
error_code=""
response_message_id=""
for _ in \$(seq 1 120); do
  result="\$(psql_scalar -c "
    SELECT status || '|' || COALESCE(error_code,'') || '|' || COALESCE(response_message_id,'')
    FROM cloud_agent_fallback_runs WHERE run_id = '\${run_id}'")"
  IFS='|' read -r status error_code response_message_id <<<"\$result"
  if [[ "\$status" == "completed" || "\$status" == "failed" ]]; then
    break
  fi
  sleep 2
done

if [[ "\${status:-}" != "completed" ]]; then
  echo "[real-provider-canary] expected status=completed, got \${result:-<empty>}" >&2
  exit 1
fi
if [[ -n "\${error_code:-}" ]]; then
  echo "[real-provider-canary] expected empty error_code, got \${error_code}" >&2
  exit 1
fi
if [[ -z "\${response_message_id:-}" ]]; then
  echo "[real-provider-canary] expected non-empty response_message_id" >&2
  exit 1
fi

echo "[real-provider-canary] observed \${run_id}: status=completed response_message_id=\${response_message_id}"
cleanup
trap - EXIT
final_replicas="\$(kubectl -n "\$namespace" get "deployment/\${deployment}" -o jsonpath='{.spec.replicas}')"
if [[ "\$final_replicas" != "0" ]]; then
  echo "[real-provider-canary] final replicas check failed: \${final_replicas}" >&2
  exit 1
fi
wait_for_no_runner_pods

echo "[real-provider-canary] ok"
REMOTE

remote_script_path="/tmp/kordi-real-provider-canary-${suffix}.sh"
echo "[real-provider-canary] running remote scoped canary on ${remote_host}"
gcloud compute scp "$remote_script_file" "$remote_host:${remote_script_path}" --zone "$remote_zone" >/dev/null
gcloud compute ssh "$remote_host" --zone "$remote_zone" --command "chmod 700 ${remote_script_path}; bash ${remote_script_path}; status=\$?; rm -f ${remote_script_path}; exit \$status"
