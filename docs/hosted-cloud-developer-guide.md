# Kordi Hosted Cloud Developer Guide

This guide explains how developers should test and deploy against the hosted Cloud environment currently used for development.

Use the shared hosted test server below for developer Cloud testing. Do not put tokens, provider credentials, database credentials, account secrets, or private operator host details in GitHub issues, PRs, screenshots, commits, or shared logs.

## Mental model

The hosted Cloud setup has two separate parts:

1. Hosted Cloud backend
   - Remote Cloud server service
   - Remote database
   - Remote Cloud agent runner

2. Local developer desktop instances
   - Local Tauri desktop app
   - Local Vite dev server, usually `127.0.0.1:<port>`
   - Local isolated user data directories
   - Pointed at the hosted Cloud backend by environment variables

A local URL such as `http://127.0.0.1:1484` is only the local desktop test UI. It is not the hosted Cloud backend.

## Current shared hosted test server

Use this Cloud API base for the shared developer test environment:

```bash
export HOSTED_CLOUD_API_BASE="https://coordinar.io"
```

If an operator rotates the test server, update only this value and keep the rest of the guide unchanged.

## Required local environment

Set these before launching desktop clients:

```bash
export HOSTED_CLOUD_API_BASE="https://coordinar.io"
export VITE_KORDI_EDITION=cloud
export KORDI_EDITION=cloud
export VITE_KORDI_CLOUD_API_BASE="$HOSTED_CLOUD_API_BASE"
export KORDI_CLOUD_API_BASE="$HOSTED_CLOUD_API_BASE"
```

Health check the hosted Cloud backend:

```bash
curl -fsS "$VITE_KORDI_CLOUD_API_BASE/health"
```

Expected: HTTP 200 or a healthy response.

## Launch one local Cloud desktop

Use this for single-account testing:

```bash
pnpm install
pnpm dev:desktop
```

If the Tauri launcher reports missing sidecar binaries, run:

```bash
pnpm prepare:sidecars
```

`pnpm prepare:sidecars` is local desktop setup only. It does not host Cloud, deploy Cloud, or run the Cloud server.

## Launch multiple local Cloud users

Create a local-only config file. Do not commit it.

```bash
cat > /tmp/kordi-hosted-cloud-users.yaml <<'YAML'
defaults:
  host: 127.0.0.1
  titlePrefix: Kordi Cloud
  dataRoot: /tmp/kordi-hosted-cloud-data
  logsRoot: /tmp/kordi-hosted-cloud-logs
  runtimeRoot: /tmp/kordi-hosted-cloud-runtime

users:
  - id: user1
    port: 1482
    title: Kordi Cloud user1

  - id: user2
    port: 1484
    title: Kordi Cloud user2

  - id: user3
    port: 1486
    title: Kordi Cloud user3
YAML
```

Launch two users from a clean local state:

```bash
pnpm dev:desktop:multi -- --config /tmp/kordi-hosted-cloud-users.yaml --reset --users user1,user2
```

Open:

```text
http://127.0.0.1:1482
http://127.0.0.1:1484
```

Log in as a different Cloud account in each window.

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

It does not configure the hosted Cloud backend and does not contain the Cloud host. The hosted Cloud backend is selected by:

```bash
VITE_KORDI_CLOUD_API_BASE="<HOSTED_CLOUD_API_BASE>"
```

Use `--reset` when you want a clean local login/data state. Omit `--reset` when you want to preserve the local account session and cached desktop state for that test user.

## Decision tree: do we need to redeploy the Cloud server?

### Path A: no database change and no Cloud server backend change

Use the existing deployed Cloud server service. Do not redeploy the Cloud server.

This path applies to:

- Desktop UI changes
- Desktop Cloud client changes
- Sidebar/chat visual changes
- Local testing config changes
- Tests that only need existing Cloud APIs

Developer action:

1. Pull the branch or commit under test.
2. Set the Cloud environment variables listed above.
3. Restart the local desktop instance or multi-instance launcher.
4. Test against the existing hosted Cloud backend.

Example:

```bash
git checkout <branch-under-test>
git pull
pnpm install

export VITE_KORDI_EDITION=cloud
export KORDI_EDITION=cloud
export VITE_KORDI_CLOUD_API_BASE="<HOSTED_CLOUD_API_BASE>"
export KORDI_CLOUD_API_BASE="<HOSTED_CLOUD_API_BASE>"

pnpm dev:desktop:multi -- --config /tmp/kordi-hosted-cloud-users.yaml --reset --users user1,user2
```

What this redeploys or restarts:

- Local desktop instance only

What this does not redeploy:

- Cloud server
- Database
- Cloud agent runner

### Path B: Cloud agent runner change only

Use this when only the Cloud runner changes and the Cloud server/database schema do not change.

Examples:

- Runner polling behavior
- Runner model loop behavior
- Runner sandbox behavior
- Runner logging or canary changes

Developer action:

1. Build/test runner changes.
2. Redeploy the Cloud agent runner only.
3. Do not redeploy the Cloud server unless server code also changed.
4. Test from local desktop instances against the same hosted Cloud backend.

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

### Path C: Cloud server code change without database schema change

Use this when `bridges/cloud-server` code changed but there is no new migration and no database schema requirement.

Examples:

- Route logic change
- Presence behavior change
- Auth behavior change without schema change
- Runtime status behavior change without schema change

Developer action:

1. Verify there are no migration changes.
2. Deploy the Cloud server with a rolling restart.
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

A database change requires a Cloud server deploy.

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
- Cloud server can start against a fresh or migrated database.

Important implementation note:

The Cloud server migration runner applies embedded migrations at server startup. If a new SQL migration file is added, make sure the server code includes it in the embedded migration list, for example in the Postgres pool/migration module.

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
2. Capture Cloud server logs with secrets redacted.
3. Check whether migration partially applied.
4. If the migration did not apply, roll back the deployment image.
5. If the migration applied and is incompatible with the previous server, follow the written rollback plan for that migration.

Never run a destructive migration without a tested rollback or restore plan.

## Hosted Cloud test matrix

Run these after any Cloud-related change.

### Login persistence

1. Launch local desktop in Cloud mode.
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

### Offline direct Cloud agent fallback

1. user1 and user2 are contacts.
2. user2 has provider auth configured.
3. Quit user2 desktop completely.
4. user1 sends a request to user2's agent.
5. Wait for Cloud runner response.
6. Reopen user2.

Expected:

- Cloud handles the request once.
- One assistant response appears.
- Reconnect does not process the same request again.

Cloud-owned request states:

```text
queued
leased
running
completed
```

### Offline group Cloud agent fallback

1. Create a group with user1 and user2.
2. Quit user2.
3. user1 sends a group request to user2's agent.
4. Wait for Cloud runner response.
5. Reopen user2.

Expected:

- Response lands in the correct group/session.
- Exactly one response is generated.
- Reconnect does not duplicate processing.

## Bug report template

```text
Hosted Cloud bug

Desktop commit:
<git sha>

Cloud backend:
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
