# Kordi Hosted Developer Guide

This guide explains how developers should choose an environment, test, and deploy against a hosted environment. It is the canonical policy for Kordi preview and debug sessions that may use remote hosted infrastructure. Read [Development environment isolation](development-environments.md) first for the complete local, remote development, and product decision matrix. Any host or release validation that includes voice or video must also follow [Hosting Kordi voice and video calls](call-hosting.md).

Production API is `https://kordi.ai`, but that does not make it the correct target for every operator session. Apply the preflight below before launching a preview, debug session, tunnel, deploy, or server restart.

Do not put tokens, provider credentials, database credentials, account secrets, or private operator host details in GitHub issues, PRs, screenshots, commits, or shared logs.

## Required preflight before preview or debug

Determine whether the requested settings, code, or test can affect a product server before launching anything. Treat the work as product-server-affecting when the current session will apply hosted server or runner code, routes, auth/runtime behavior, schema or data changes, server configuration, destructive/load/recovery behavior, a deploy, or anything that requires a product-server restart. When the impact is uncertain, stop and fail closed before connecting to remote infrastructure.

| Classification | Required path |
| --- | --- |
| Product-server-affecting operator work | Develop, deploy, restart, inspect, and test on the corresponding product-server machine, then validate through canonical production origin `https://kordi.ai`. |
| Desktop-only remote operator preview | Check the active GitHub account against `deploy/dev/operator-github-allowlist.txt`, then use the approved operator launcher against `https://kordi.ai`. |
| Isolated local development | Use the loopback Docker backend, an explicit loopback origin, and an isolated named desktop profile. This path cannot substitute for product-server validation. |
| Approved isolated remote development | Reach the private development host through an IAP-style SSH tunnel, keep its API bound to loopback, and use the same isolated named profile. This path cannot substitute for product-server validation. |
| Unknown impact or missing required access | Fail closed. Never silently fall back to a local community/debug-server profile, switch origins, or bypass endpoint/account checks as if it validated the product server. |

### Product-server-affecting path

For product-server-affecting work:

1. Obtain approved access to the corresponding product-server machine. Keep its identity and credentials private.
2. Verify the public diagnostic route before making a change:

   ```bash
   curl -fsS https://kordi.ai/health
   ```

3. Develop, deploy, restart, and inspect the affected service on that corresponding product-server machine.
4. After every required restart or deploy, verify rollout state and redacted server logs on that machine, then run the health check again.
5. Run the end-to-end validation through `https://kordi.ai` and confirm the desktop logs show that exact API base. After the server-side work is complete, launch the client with the allowlisted wrapper:

   ```bash
   KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1 \
     pnpm dev:cloud:operator -- "https://kordi.ai"
   ```

   If the deployment can affect calling, complete the [product call readiness checks and two-account acceptance test](call-hosting.md#product-host) before reporting it healthy.

Do not route this path through a public test API, self-hosted API, local tunnel, or community/debug-server profile. Those environments are useful for separate isolated work, but they do not substitute for required product-server validation. If product-server access or approval is missing, stop.

### Desktop-only remote operator path

For a remote preview that cannot affect the product server, verify the active GitHub login against the staged allowlist before launch:

```bash
gh api user --jq .login
sed -n '1,120p' deploy/dev/operator-github-allowlist.txt
```

If the account is listed, use the approved wrapper and acknowledgement against `https://kordi.ai`:

```bash
KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1 \
  pnpm dev:cloud:operator -- "https://kordi.ai"
```

The underlying allowlisted entrypoint is `scripts/dev-cloud-operator.sh https://kordi.ai`; use it only through the documented command above so the acknowledgement and profile arguments remain explicit.

The named-profile launcher also binds native branding to the validated environment profile: isolated community previews use the gray development icon, while this allowlisted operator path uses the color product icon. Window titles do not control that decision.

If the account is not listed, fail closed. Do not edit the allowlist, bypass the launcher, or expose production credentials. The isolated contributor workflow remains available for genuinely local work, but it does not count as a remote operator or product-server test.

## Mental model

The hosted setup has two separate parts:

1. Hosted backend
   - Remote server service
   - Remote database
   - Remote agent runner

2. Local developer desktop instances
   - Local Tauri desktop app
   - Local Vite dev server, usually `127.0.0.1:<port>`
   - Local isolated user data directories
   - Pointed at the hosted backend by environment variables

A local URL such as `http://127.0.0.1:1484` is only the local desktop test UI. It is not the hosted backend.

## Select a hosted test server

Use a public test API base supplied by an operator, or the HTTPS origin of your own compatible server:

```bash
export HOSTED_CLOUD_API_BASE="<PUBLIC_TEST_CLOUD_API_BASE>"
```

If an operator rotates the test server, update only this value and keep the rest of the guide unchanged.

## Required local environment

Hosted/dev runs must set `VITE_KORDI_CLOUD_API_BASE` explicitly before launching desktop clients. Do not rely on the production default for hosted testing.

Development launches fail closed if the API base is missing or points at the production origin. For ordinary contributor work, use the isolated setup in [`self-hosted-debug.md`](self-hosted-debug.md).

Set these before launching desktop clients:

```bash
export HOSTED_CLOUD_API_BASE="<PUBLIC_TEST_CLOUD_API_BASE>"
export VITE_KORDI_CLOUD_API_BASE="$HOSTED_CLOUD_API_BASE"
export KORDI_CLOUD_API_BASE="$HOSTED_CLOUD_API_BASE"
```

Health check the hosted backend:

```bash
curl -fsS "$VITE_KORDI_CLOUD_API_BASE/health"
```

Expected: HTTP 200 or a healthy response.

## Allowlisted operator debug profile

The operator profile exists for approved core-maintainer diagnostics against a remote API, including production when necessary. It is not a client-side admin role and does not connect the desktop directly to Postgres, Redis, object storage, or any other data service. The hosted backend remains the only component with database credentials and must enforce the real account permissions, IAM rules, and audit policy.

The launcher verifies the account currently authenticated in GitHub CLI against
the local `deploy/dev/operator-github-allowlist.txt`. Copy the tracked
`operator-github-allowlist.example.txt` first, then add only approved operator
logins. The real allowlist is ignored because it reveals privileged identities.
A local source edit is not authorization; server-side controls remain mandatory.

Authenticate GitHub CLI, then launch a desktop-only remote preview with an explicit acknowledgement against the current production API at `https://kordi.ai`:

```bash
gh auth login
KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1 \
  pnpm dev:cloud:operator -- "https://kordi.ai"
```

`coordinar.io` is retained only as a compatibility route for already-released clients. New operator validation and desktop previews use the canonical `https://kordi.ai` origin.

The launcher fails closed unless all of these are true:

- `gh api user` returns an allowlisted GitHub login.
- `KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1` is set for this invocation.
- An explicit absolute API origin is supplied.
- Both the renderer and native endpoint guards recognize the operator profile and acknowledgement.

Do not add community contributors to this allowlist to work around the normal production guard. Use the isolated backend or an approved staging API instead.

### If a preview reports `app_data_dir_unavailable`

This error is a local native-launch configuration failure, not evidence of account-data loss or a hosted-backend outage. Tauri resolves the application data directory during native startup. An isolated preview that uses an `io.kordi.desktop.*` identifier is treated as a non-Cloud bundle, so Cloud account storage is not initialized before the renderer asks for it.

Always launch an operator preview through the approved wrapper. A named isolated profile identifier must begin with `io.kordi.cloud.` and must never equal the production identifier `io.kordi.cloud`. The profile launcher chooses a unique suffix by default and rejects identifiers that could reuse the production app data directory:

```bash
KORDI_OPERATOR_DEBUG_ACKNOWLEDGED=1 \
  pnpm dev:cloud:operator -- "<APPROVED_REMOTE_API_BASE>" \
  --port <LOCAL_PORT> \
  --profile <PREVIEW_NAME> \
  --title "<PREVIEW_TITLE>"
```

Do not add `--identifier io.kordi.desktop.<name>`. If this error appears, quit that preview and relaunch it with the wrapper; do not delete the account database, cache, or application-data directory. A corrected identifier intentionally gives the isolated preview its own Cloud application-data directory, so a fresh sign-in may be required once.

## Internal/operator local tunnel debug pipeline

Use this path only when an operator explicitly asks you to test against a private, non-product hosted backend through a local tunnel. It is not permitted for product-server-affecting work; use the corresponding product-server machine and `https://kordi.ai` for that work. Keep all real operator hostnames, projects, account names, private IPs, and credentials out of commits, PRs, screenshots, and shared logs.

Set the operator-provided values in your shell. Use placeholders in docs and bug reports:

```bash
export KORDI_CLOUD_USE_LOCAL_TUNNEL=1
export KORDI_CLOUD_SSH_TARGET="<OPERATOR_SSH_TARGET>"
export KORDI_CLOUD_SSH_ZONE="<OPERATOR_SSH_ZONE>"
export KORDI_CLOUD_GCP_PROJECT="<OPERATOR_GCP_PROJECT>"
export KORDI_CLOUD_LOCAL_PORT="<LOCAL_TUNNEL_PORT>"
export KORDI_CLOUD_VM_PORT="<REMOTE_FORWARD_PORT>"
```

Before launching desktop clients, verify the selected tunnel endpoint is healthy:

```bash
curl -fsS "http://127.0.0.1:${KORDI_CLOUD_LOCAL_PORT}/health"
```

Launch isolated users through the tunnel-enabled helper:

```bash
pnpm dev:cloud:multi -- --users user1,user2,user3
```

The tunnel helper sets `VITE_KORDI_CLOUD_API_BASE` for the launched local desktop instances. The API base should point at the local tunnel endpoint, not at production, when this debug path is in use.

When debugging sync or login failures in this mode:

1. Confirm `/health` succeeds on the local tunnel endpoint.
2. Confirm each desktop log shows the expected `VITE_KORDI_CLOUD_API_BASE` value for that launch.
3. Confirm the local desktop URLs are only UI windows; they are not backend URLs.
4. Check whether the change path requires a hosted server deploy. If it does, stop the tunnel path and use Path C or D on the corresponding product-server machine through `https://kordi.ai`.
5. If the tunnel drops, restart the tunnel or relaunch the tunnel helper. Do not silently switch to production as a workaround.
6. Redact tokens, account IDs when needed, private hostnames, project names, database details, and local filesystem paths before sharing logs.

## Launch one local desktop

Use this for single-account testing after exporting `VITE_KORDI_CLOUD_API_BASE`:

```bash
pnpm install
VITE_KORDI_DEV_PROFILE=community \
pnpm dev:desktop:profile -- \
  --profile approved-staging --title "Kordi Staging" --port 1422
```

If the Tauri launcher reports missing sidecar binaries, run:

```bash
pnpm prepare:sidecars
```

`pnpm prepare:sidecars` is local desktop setup only. It does not host, deploy, or run the hosted server.

## Launch multiple local users

Create a local-only config file. Do not commit it.

```bash
cat > /tmp/kordi-hosted-cloud-users.yaml <<'YAML'
defaults:
  host: 127.0.0.1
  titlePrefix: Kordi
  dataRoot: /tmp/kordi-hosted-cloud-data
  logsRoot: /tmp/kordi-hosted-cloud-logs
  runtimeRoot: /tmp/kordi-hosted-cloud-runtime

users:
  - id: user1
    port: 1482
    title: Kordi user1

  - id: user2
    port: 1484
    title: Kordi user2

  - id: user3
    port: 1486
    title: Kordi user3
YAML
```

Launch two users from a clean local state after exporting `VITE_KORDI_CLOUD_API_BASE`:

```bash
pnpm dev:desktop:multi -- --config /tmp/kordi-hosted-cloud-users.yaml --reset --users user1,user2
```

Open:

```text
http://127.0.0.1:1482
http://127.0.0.1:1484
```

Log in as a different account in each window.

Local logs:

```text
/tmp/kordi-hosted-cloud-logs/user1/dev-1482.log
/tmp/kordi-hosted-cloud-logs/user2/dev-1484.log
/tmp/kordi-hosted-cloud-logs/user3/dev-1486.log
```

### What the multi-instance config controls

`--config /tmp/kordi-hosted-cloud-users.yaml` controls only the local desktop test layout:

- local test user ids
- local Vite ports
- local window titles
- local app data directories
- local log and runtime directories

It does not configure the hosted backend and does not contain the hosted API host. The hosted backend is selected by:

```bash
VITE_KORDI_CLOUD_API_BASE="<HOSTED_CLOUD_API_BASE>"
```

Use `--reset` when you want a clean local login/data state. Omit `--reset` when you want to preserve the local account session and cached desktop state for that test user.

### Debug checklist for multi-user runs

Before attributing a multi-user bug to app code, record the selected backend without exposing private infrastructure:

```text
Selected backend mode: public test API / self-hosted API / operator local tunnel
Health check: pass / fail
Desktop user logs show expected VITE_KORDI_CLOUD_API_BASE: yes / no
Local UI URLs under test: <LOCAL_UI_URLS>
Change path: no backend change / server change / database migration / runner change
```

If a message, pin, read receipt, group update, or presence change does not sync:

1. Verify the backend health check first.
2. Verify the sending client did not report a load/send failure.
3. Verify the receiving client is connected to the same backend mode.
4. For backend changes, verify the server deploy and migration state before retesting.
5. Only then inspect redacted desktop/server logs for the event or API request.

## Decision tree after the required preflight

### Path A: no database change and no hosted server backend change

Use the existing deployed hosted server service. Do not redeploy the hosted server. A remote operator preview uses the allowlisted `https://kordi.ai` wrapper; isolated contributor work uses its explicit loopback or approved non-production origin.

This path applies to:

- Desktop UI changes
- Desktop API client changes
- Sidebar/chat visual changes
- Local testing config changes
- Tests that only need existing hosted APIs

Developer action:

1. Pull the branch or commit under test.
2. Confirm the session cannot affect the product server.
3. For a remote operator preview, check the active GitHub account against `deploy/dev/operator-github-allowlist.txt` and use `pnpm dev:cloud:operator -- "https://kordi.ai"` with the required acknowledgement.
4. For isolated contributor work, set the explicit loopback or approved non-production API variables listed above.
5. Restart the local desktop instance or multi-instance launcher and test against the selected existing backend.

Example:

```bash
git checkout <branch-under-test>
git pull
pnpm install

export VITE_KORDI_CLOUD_API_BASE="<HOSTED_CLOUD_API_BASE>"
export KORDI_CLOUD_API_BASE="<HOSTED_CLOUD_API_BASE>"

pnpm dev:desktop:multi -- --config /tmp/kordi-hosted-cloud-users.yaml --reset --users user1,user2
```

What this redeploys or restarts:

- Local desktop instance only

What this does not redeploy:

- Hosted server
- Database
- Hosted agent runner

### Path B: hosted agent runner change only

Use this when only the hosted runner changes and the hosted server/database schema do not change. A runner deploy affects the hosted product, so perform it on the corresponding product-server machine and validate through `https://kordi.ai`.

Examples:

- Runner polling behavior
- Runner model loop behavior
- Runner sandbox behavior
- Runner logging or canary changes

Developer action:

1. Build/test runner changes on the corresponding product-server machine.
2. Redeploy the hosted agent runner only on that machine.
3. Do not redeploy the hosted server unless server code also changed.
4. Verify rollout and redacted logs, then confirm `https://kordi.ai/health` succeeds.
5. Run the end-to-end test from an allowlisted desktop instance connected to `https://kordi.ai`.

Use the project runner deploy script if available in the branch:

```bash
KORDI_CLOUD_RUNNER_IMAGE_TAG="runner-$(date +%Y%m%d-%H%M%S)" \
  bridges/cloud-server/deploy/k3s/deploy-cloud-agent-runner.sh
```

Verify:

```bash
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-agent-runner --timeout=180s
kubectl -n kordi-cloud logs deployment/kordi-cloud-agent-runner --since=10m
```

Do not paste runner tokens into logs or chat.

### Path C: hosted server code change without database schema change

Use this when `bridges/cloud-server` code or server configuration changed but there is no new migration and no database schema requirement. This is product-server-affecting work.

Examples:

- Route logic change
- Presence behavior change
- Auth behavior change without schema change
- Runtime status behavior change without schema change
- Server settings or behavior that requires a restart

Developer action:

1. Switch to the approved corresponding product-server machine and verify there are no migration changes.
2. Develop and deploy the hosted server there with a rolling restart.
3. Verify health and logs.
4. Run the end-to-end test through `https://kordi.ai`.

Run these commands on, or explicitly targeting, the corresponding product-server machine. Real access details are provided privately by the operator:

```bash
bridges/cloud-server/deploy/sync-and-build.sh

KORDI_CLOUD_IMAGE_TAG="cloud-server-$(date +%Y%m%d-%H%M%S)" \
  bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
```

Verify:

```bash
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s
kubectl -n kordi-cloud logs deployment/kordi-cloud-server --since=10m
curl -fsS https://kordi.ai/health
```

### Path D: database schema changed

A database change requires a hosted server deploy and is always product-server-affecting. Develop, deploy, and validate it on the corresponding product-server machine through `https://kordi.ai`.

This path applies when any of these changed:

- New file under `bridges/cloud-server/migrations/`
- Existing migration list updated
- New table, column, index, constraint, enum, or schema assumption
- Server code depends on a schema that does not exist in the hosted database yet

Before deploy checklist:

- Migration has a new version number.
- Migration is additive or has an explicit rollback plan.
- Destructive migrations have a backup and approval.
- Migration is idempotent where possible.
- Migration is registered in the embedded migration list if the branch uses embedded migrations.
- Server tests pass.
- Hosted server can start against a fresh or migrated database.

Important implementation note:

The hosted server migration runner applies embedded migrations at server startup. If a new SQL migration file is added, make sure the server code includes it in the embedded migration list, for example in the Postgres pool/migration module.

Run the deploy steps on, or explicitly targeting, the corresponding product-server machine:

```bash
bridges/cloud-server/deploy/sync-and-build.sh

KORDI_CLOUD_IMAGE_TAG="cloud-server-db-$(date +%Y%m%d-%H%M%S)" \
  bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
```

Watch rollout:

```bash
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s
kubectl -n kordi-cloud logs deployment/kordi-cloud-server --since=10m
curl -fsS https://kordi.ai/health
```

Verify migration state using operator-only database access. Do not share credentials.

Example query shape:

```sql
SELECT version, description, applied_at
FROM cloud_schema_versions
ORDER BY version;
```

If rollout fails:

1. Stop testing immediately.
2. Capture hosted server logs with secrets redacted.
3. Check whether migration partially applied.
4. If the migration did not apply, roll back the deployment image.
5. If the migration applied and is incompatible with the previous server, follow the written rollback plan for that migration.

Never run a destructive migration without a tested rollback or restore plan.

## Hosted test matrix

Run these after any backend-related change. Paths B, C, and D must run against `https://kordi.ai` after the affected service is deployed or restarted on the corresponding product-server machine. A remote Path A operator preview uses the same origin through the allowlisted launcher.

### Login persistence

1. Launch local desktop in account mode.
2. Log in.
3. Quit and relaunch without deleting local data.
4. Confirm the same account loads.

### Direct contact and messaging

1. user2 copies account ID.
2. user1 adds user2 as contact.
3. Accept if required.
4. Send messages both ways.
5. Restart both local desktop users.

Expected:

- Messages sync both ways.
- No duplicate messages.
- Sender identity is correct.
- Unread count updates correctly.

### Presence

1. Keep user1 and user2 open.
2. Confirm user2 appears online for user1.
3. Quit user2.
4. Wait for offline state.
5. Reopen user2.

Expected:

- Presence state updates.
- No bulky visible online/offline text pills in current UI.

### Group chat

1. user1 creates a group with user2.
2. Send messages both ways.
3. Restart both local desktop users.

Expected:

- Group messages sync.
- Group membership stays stable.
- No duplicate group sessions.

### Offline direct hosted agent fallback

1. user1 and user2 are contacts.
2. user2 has provider auth configured.
3. Quit user2 desktop completely.
4. user1 sends a request to user2's agent.
5. Wait for hosted runner response.
6. Reopen user2.

Expected:

- The hosted runner handles the request once.
- One assistant response appears.
- Reconnect does not process the same request again.

Hosted request states:

```text
queued
leased
running
completed
```

### Offline group hosted agent fallback

1. Create a group with user1 and user2.
2. Quit user2.
3. user1 sends a group request to user2's agent.
4. Wait for hosted runner response.
5. Reopen user2.

Expected:

- Response lands in the correct group/session.
- Exactly one response is generated.
- Reconnect does not duplicate processing.

## Bug report template

```text
Hosted bug

Desktop commit:
<git sha>

Hosted backend:
<HOSTED_CLOUD_API_BASE, redacted if needed>

Change path:
No DB change / Runner only / Server only / DB migration

Users:
user1:
user2:

Scenario:
Login / Direct message / Presence / Group / Offline agent / Reconnect duplicate

Steps:
1.
2.
3.

Expected:

Actual:

UTC time window:

Logs:
Attach redacted desktop logs and, if relevant, redacted server/runner logs.

Notes:
```

## Redaction checklist

Before sharing anything, remove:

- Auth tokens
- Provider tokens
- Runner token
- Database URL or password
- `auth.json`
- Any secret mounted from Kubernetes

Use placeholders instead:

```text
<ACCOUNT_ID>
<REQUEST_ID>
<TOKEN_REDACTED>
```
