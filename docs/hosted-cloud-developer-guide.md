# Kordi Hosted Developer Guide

This guide explains how developers should test and deploy against a hosted environment.

Production API is `https://coordinar.io`. Do not use the production server for destructive, load, or throwaway multi-account testing unless explicitly authorized. For development and QA, use an operator-provided public test API base or host your own compatible server.

Do not put tokens, provider credentials, database credentials, account secrets, or private operator host details in GitHub issues, PRs, screenshots, commits, or shared logs.

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

## Internal/operator local tunnel debug pipeline

Use this path only when an operator explicitly asks you to test against a private hosted backend through a local tunnel. Keep all real operator hostnames, projects, account names, private IPs, and credentials out of commits, PRs, screenshots, and shared logs.

Set the operator-provided values in your shell. Use placeholders in docs and bug reports:

```bash
export KORDI_CLOUD_USE_LOCAL_TUNNEL=1
export KORDI_CLOUD_SSH_TARGET="<OPERATOR_SSH_TARGET>"
export KORDI_CLOUD_SSH_ZONE="<OPERATOR_SSH_ZONE>"
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
4. Check whether the change path requires a hosted server deploy: use Path C for server code changes and Path D for schema changes.
5. If the tunnel drops, restart the tunnel or relaunch the tunnel helper. Do not silently switch to production as a workaround.
6. Redact tokens, account IDs when needed, private hostnames, project names, database details, and local filesystem paths before sharing logs.

## Launch one local desktop

Use this for single-account testing after exporting `VITE_KORDI_CLOUD_API_BASE`:

```bash
pnpm install
pnpm dev
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

## Decision tree: do we need to redeploy the hosted server?

### Path A: no database change and no hosted server backend change

Use the existing deployed hosted server service. Do not redeploy the hosted server.

This path applies to:

- Desktop UI changes
- Desktop API client changes
- Sidebar/chat visual changes
- Local testing config changes
- Tests that only need existing hosted APIs

Developer action:

1. Pull the branch or commit under test.
2. Set the API environment variables listed above.
3. Restart the local desktop instance or multi-instance launcher.
4. Test against the existing hosted backend.

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

Use this when only the hosted runner changes and the hosted server/database schema do not change.

Examples:

- Runner polling behavior
- Runner model loop behavior
- Runner sandbox behavior
- Runner logging or canary changes

Developer action:

1. Build/test runner changes.
2. Redeploy the hosted agent runner only.
3. Do not redeploy the hosted server unless server code also changed.
4. Test from local desktop instances against the same hosted backend.

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

Use this when `bridges/cloud-server` code changed but there is no new migration and no database schema requirement.

Examples:

- Route logic change
- Presence behavior change
- Auth behavior change without schema change
- Runtime status behavior change without schema change

Developer action:

1. Verify there are no migration changes.
2. Deploy the hosted server with a rolling restart.
3. Verify health and logs.
4. Test from local desktop instances.

Commands, with real host details provided privately by the operator:

```bash
bridges/cloud-server/deploy/sync-and-build.sh

KORDI_CLOUD_IMAGE_TAG="cloud-server-$(date +%Y%m%d-%H%M%S)" \
  bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
```

Verify:

```bash
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s
kubectl -n kordi-cloud logs deployment/kordi-cloud-server --since=10m
curl -fsS "<HOSTED_CLOUD_API_BASE>/health"
```

### Path D: database schema changed

A database change requires a hosted server deploy.

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

Deploy steps:

```bash
bridges/cloud-server/deploy/sync-and-build.sh

KORDI_CLOUD_IMAGE_TAG="cloud-server-db-$(date +%Y%m%d-%H%M%S)" \
  bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh
```

Watch rollout:

```bash
kubectl -n kordi-cloud rollout status deployment/kordi-cloud-server --timeout=180s
kubectl -n kordi-cloud logs deployment/kordi-cloud-server --since=10m
curl -fsS "<HOSTED_CLOUD_API_BASE>/health"
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

Run these after any backend-related change.

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
