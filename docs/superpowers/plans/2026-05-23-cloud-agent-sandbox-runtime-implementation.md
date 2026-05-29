# Cloud Agent Sandbox Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement #494 as the next #479 subissue set: a Cloud-hosted sandbox fallback runtime that keeps agents useful while the owner device is offline without accessing the owner laptop or other users' data.

**Architecture:** Build the runtime as small vertical slices. Cloud server owns fallback run claims, authorization, provider-auth snapshots, and chat persistence; warm K3s Cloud Agent Runner pods own model orchestration; sandbox executors own shell/files/browser execution inside isolated persistent session workspaces. Do not implement this as one large PR.

**Tech Stack:** Rust workspace (`kordi-cloud-server`, new `kordi-cloud-agent-runner`, agent crates), Postgres/sqlx migrations, Axum HTTP APIs, K3s manifests, existing Cloud desktop TypeScript client/hooks, existing S3 attachment/object path, existing three-user Cloud preview.

---

## Scope decomposition

This feature crosses independent subsystems, so implementation must be split into subissues/PRs. Each PR should be independently testable and should not require merging draft PR #490.

Recommended GitHub subissues under #494:

1. Runtime job model and offline fallback claim/dedupe.
2. Explicit Cloud provider-auth snapshot storage, revocation, and audit.
3. Cloud Agent Runner crate/service and model-loop bootstrap.
4. Sandbox workspace metadata, persistence, TTL, and quotas.
5. Sandbox tool backend and policy gate.
6. Artifact export from sandbox to Cloud chat.
7. K3s deployment and takotako e2e validation.

The first shippable vertical slice is: accepted contact mentions offline owner's agent, Cloud claims exactly one run, runner returns a policy-generated response for sandbox-local vs owner-local capability boundaries. Full tool execution follows in later PRs.

## File structure

### Cloud server runtime state

- Create: `bridges/cloud-server/migrations/0018_cloud_agent_fallback_runs.sql`
  - Tables for fallback runs, run events, and idempotent claims.
- Create: `bridges/cloud-server/src/cloud_agent_runtime/mod.rs`
  - Module boundary and public helpers used by routes/server/tests.
- Create: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`
  - Run creation, claim, lease, cancel, completion, and authorization checks.
- Create: `bridges/cloud-server/src/cloud_agent_runtime/policy.rs`
  - Sandbox-local allowed vs owner-local/private blocked policy primitives.
- Create: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
  - Authenticated Cloud APIs for run status and runner leasing.
- Modify: `bridges/cloud-server/src/lib.rs`
  - Export `cloud_agent_runtime` module.
- Modify: `bridges/cloud-server/src/server.rs`
  - Merge Cloud agent runtime routes.
- Modify: `bridges/cloud-server/src/events/mod.rs`
  - Add run claimed/updated event subjects if websocket fanout is needed by desktop.
- Test: `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`
  - End-to-end HTTP tests for authorization, offline gating, claim idempotency, and cancellation.

### Provider-auth snapshot

- Create: `bridges/cloud-server/migrations/0019_cloud_agent_provider_auth_snapshots.sql`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/provider_auth.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Create: `app/desktop/src/features/cloud/providerAuthSnapshot.ts`
- Create: `app/desktop/tests/cloudProviderAuthSnapshot.test.tsx`
- Test: extend `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`

### Runner service

- Create: `bridges/cloud-agent-runner/Cargo.toml`
- Create: `bridges/cloud-agent-runner/src/main.rs`
- Create: `bridges/cloud-agent-runner/src/client.rs`
- Create: `bridges/cloud-agent-runner/src/runtime.rs`
- Create: `bridges/cloud-agent-runner/src/prompt.rs`
- Modify: `Cargo.toml`
  - Add `bridges/cloud-agent-runner` as a workspace member.
- Modify: `agent/crates/cli/src/lib.rs`
  - Expose runtime bootstrap pieces only if the runner needs them directly.
- Test: `cargo test -p kordi-cloud-agent-runner`.

### Sandbox workspace and tool execution

- Create: `bridges/cloud-server/migrations/0020_cloud_agent_sandboxes.sql`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/sandboxes.rs`
- Create: `bridges/cloud-agent-runner/src/sandbox_client.rs`
- Create: `bridges/cloud-agent-runner/src/tool_policy.rs`
- Create: `bridges/cloud-agent-runner/src/tools.rs`
- Create: `bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner.yaml`
- Create: `bridges/cloud-server/deploy/k3s/manifests/cloud-agent-sandbox.yaml`
- Modify: `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`
- Test: `cargo test -p kordi-cloud-agent-runner tool_policy` and K3s smoke tests on takotako.

### Artifact export

- Create: `bridges/cloud-agent-runner/src/artifacts.rs`
- Modify: `bridges/cloud-server/src/attachments.rs`
- Modify: `bridges/cloud-server/src/auth/routes.rs` or route ownership if attachment APIs live there.
- Reuse: `cloud_attachments`, `cloud_message_attachments`, and `cloud_session_artifacts`.
- Test: upload/export an artifact from sandbox and verify only authorized chat participants can fetch it.

---

## Task 1: Runtime job model and fallback claim/dedupe

**Files:**
- Create: `bridges/cloud-server/migrations/0018_cloud_agent_fallback_runs.sql`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/mod.rs`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/policy.rs`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
- Modify: `bridges/cloud-server/src/lib.rs`
- Modify: `bridges/cloud-server/src/server.rs`
- Test: `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`

- [ ] **Step 1: Create failing tests for claim idempotency and offline gating**

Add tests that set up two accepted contacts, mark the owner offline through presence, send/claim one agent request, and assert a second claim with the same idempotency key returns the original run instead of creating a duplicate.

Use this test shape in `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`:

```rust
#[tokio::test]
async fn fallback_claim_is_idempotent_when_owner_is_offline() {
    let app = TestCloudApp::spawn().await;
    let owner = app.signup("owner@example.com", "Owner").await;
    let requester = app.signup("requester@example.com", "Requester").await;
    app.accept_contacts(&owner, &requester).await;
    app.mark_presence_offline(&owner).await;

    let first = app
        .claim_cloud_agent_run(&requester, ClaimRunRequest {
            request_message_id: "msg_agent_request_1".to_string(),
            session_id: "session:direct-person:requester:owner".to_string(),
            owner_account_id: owner.account_id.clone(),
            requester_account_id: requester.account_id.clone(),
            prompt: "@OwnerKordi make a small plan".to_string(),
            idempotency_key: "session:direct-person:requester:owner:msg_agent_request_1:owner".to_string(),
        })
        .await;

    let second = app
        .claim_cloud_agent_run(&requester, ClaimRunRequest {
            request_message_id: "msg_agent_request_1".to_string(),
            session_id: "session:direct-person:requester:owner".to_string(),
            owner_account_id: owner.account_id.clone(),
            requester_account_id: requester.account_id.clone(),
            prompt: "@OwnerKordi make a small plan".to_string(),
            idempotency_key: "session:direct-person:requester:owner:msg_agent_request_1:owner".to_string(),
        })
        .await;

    assert_eq!(first.run_id, second.run_id);
    assert_eq!(first.status, "queued");
    assert_eq!(second.status, "queued");
    assert_eq!(app.count_cloud_agent_runs().await, 1);
}

#[tokio::test]
async fn fallback_claim_is_rejected_when_owner_is_online() {
    let app = TestCloudApp::spawn().await;
    let owner = app.signup("online-owner@example.com", "Owner").await;
    let requester = app.signup("online-requester@example.com", "Requester").await;
    app.accept_contacts(&owner, &requester).await;
    app.mark_presence_online(&owner).await;

    let response = app
        .try_claim_cloud_agent_run(&requester, ClaimRunRequest {
            request_message_id: "msg_online_owner".to_string(),
            session_id: "session:direct-person:requester:owner".to_string(),
            owner_account_id: owner.account_id.clone(),
            requester_account_id: requester.account_id.clone(),
            prompt: "@OwnerKordi respond from cloud".to_string(),
            idempotency_key: "session:direct-person:requester:owner:msg_online_owner:owner".to_string(),
        })
        .await;

    assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
}
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
cargo test -p kordi-cloud-server cloud_agent_runtime --test cloud_agent_runtime_e2e
```

Expected: fails because runtime routes/tables do not exist.

- [ ] **Step 3: Add run-state migration**

Create `bridges/cloud-server/migrations/0018_cloud_agent_fallback_runs.sql`:

```sql
CREATE TABLE IF NOT EXISTS cloud_agent_fallback_runs (
    run_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    requester_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'completed', 'failed', 'cancelled')),
    prompt TEXT NOT NULL,
    claimed_by TEXT,
    lease_expires_at TEXT,
    response_message_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_owner_status
    ON cloud_agent_fallback_runs(owner_account_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_runs_requester_session
    ON cloud_agent_fallback_runs(requester_account_id, session_id, updated_at);

CREATE TABLE IF NOT EXISTS cloud_agent_fallback_run_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_fallback_run_events_run_created
    ON cloud_agent_fallback_run_events(run_id, created_at);
```

- [ ] **Step 4: Add runtime modules and policy primitives**

Create `bridges/cloud-server/src/cloud_agent_runtime/mod.rs`:

```rust
pub mod policy;
pub mod routes;
pub mod runs;
```

Create `bridges/cloud-server/src/cloud_agent_runtime/policy.rs`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudToolCapability {
    SandboxLocal,
    OwnerLocal,
    OtherUserData,
    UnsyncedPrivateResource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudToolDecision {
    AllowSandbox,
    Block { reason: &'static str },
}

pub fn decide_cloud_tool_capability(capability: CloudToolCapability) -> CloudToolDecision {
    match capability {
        CloudToolCapability::SandboxLocal => CloudToolDecision::AllowSandbox,
        CloudToolCapability::OwnerLocal => CloudToolDecision::Block {
            reason: "This action requires the owner's local device, which is offline. I can work in the Cloud sandbox instead.",
        },
        CloudToolCapability::OtherUserData => CloudToolDecision::Block {
            reason: "This action would cross into another user's data, so it is not available from the Cloud sandbox.",
        },
        CloudToolCapability::UnsyncedPrivateResource => CloudToolDecision::Block {
            reason: "This resource has not been synced or explicitly made available to Cloud fallback.",
        },
    }
}
```

- [ ] **Step 5: Implement run claim functions**

Create `bridges/cloud-server/src/cloud_agent_runtime/runs.rs` with typed request/response structs and functions:

```rust
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct ClaimRunRequest {
    #[serde(rename = "requestMessageId")]
    pub request_message_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    pub prompt: String,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
}

#[derive(Debug, Serialize)]
pub struct CloudAgentRunResponse {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

pub async fn requester_can_target_owner(
    pool: &PgPool,
    requester_account_id: &str,
    owner_account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(
        "SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2 LIMIT 1",
    )
    .bind(requester_account_id)
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some() || requester_account_id == owner_account_id)
}

pub async fn claim_run(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<CloudAgentRunResponse, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let run_id = format!("car_{}", Uuid::new_v4().simple());
    let row: (String, String, String, String) = query_as(
        "INSERT INTO cloud_agent_fallback_runs (
            run_id, idempotency_key, request_message_id, session_id, owner_account_id,
            requester_account_id, status, prompt, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $8)
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = cloud_agent_fallback_runs.updated_at
         RETURNING run_id, status, created_at, updated_at",
    )
    .bind(&run_id)
    .bind(&input.idempotency_key)
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .bind(&input.owner_account_id)
    .bind(&input.requester_account_id)
    .bind(&input.prompt)
    .bind(&now)
    .fetch_one(pool)
    .await?;

    Ok(CloudAgentRunResponse {
        run_id: row.0,
        status: row.1,
        created_at: row.2,
        updated_at: row.3,
    })
}
```

- [ ] **Step 6: Add authenticated claim route**

Create `bridges/cloud-server/src/cloud_agent_runtime/routes.rs` and mount `POST /v1/cloud/agent-runs/claim`. The handler must:

1. Require `CloudSession` extension from existing auth middleware.
2. Reject if caller account does not match `requesterAccountId`.
3. Reject if requester is not self or accepted contact of owner.
4. Reject with `409 CONFLICT` if owner presence rollup is online.
5. Call `claim_run`.

- [ ] **Step 7: Wire routes**

Modify `bridges/cloud-server/src/lib.rs`:

```rust
pub mod cloud_agent_runtime;
```

Modify `bridges/cloud-server/src/server.rs` inside `router_with_rate_limiter`:

```rust
.merge(crate::cloud_agent_runtime::routes::routes(state.clone()))
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
cargo test -p kordi-cloud-server cloud_agent_runtime --test cloud_agent_runtime_e2e
cargo test -p kordi-cloud-server presence
```

Expected: claim tests pass; presence tests remain passing.

- [ ] **Step 9: Commit Task 1**

```bash
git add bridges/cloud-server/migrations/0018_cloud_agent_fallback_runs.sql \
  bridges/cloud-server/src/cloud_agent_runtime \
  bridges/cloud-server/src/lib.rs \
  bridges/cloud-server/src/server.rs \
  bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs
git commit -m "feat: add cloud agent fallback run claims"
```

---

## Task 2: Provider-auth snapshot opt-in, revocation, and audit

**Files:**
- Create: `bridges/cloud-server/migrations/0019_cloud_agent_provider_auth_snapshots.sql`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/provider_auth.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/mod.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
- Modify: `app/desktop/src/features/cloud/authClient.ts`
- Create: `app/desktop/src/features/cloud/providerAuthSnapshot.ts`
- Create: `app/desktop/tests/cloudProviderAuthSnapshot.test.tsx`
- Test: extend `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`

- [ ] **Step 1: Write failing tests**

Backend tests:

- storing snapshot requires authenticated owner session,
- latest unrevoked snapshot is returned for owner account,
- revoke prevents future runner use,
- every runner use inserts an audit row.

Frontend tests:

- desktop builds a snapshot only from active provider/profile,
- snapshot publisher never runs without explicit opt-in,
- revocation calls the Cloud API and clears local enabled state.

- [ ] **Step 2: Add migration**

Create `bridges/cloud-server/migrations/0019_cloud_agent_provider_auth_snapshots.sql`:

```sql
CREATE TABLE IF NOT EXISTS cloud_agent_provider_auth_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES cloud_devices(device_id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    auth_choice TEXT NOT NULL,
    encrypted_payload BYTEA NOT NULL,
    encryption_key_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    UNIQUE (account_id, provider, auth_choice, revoked_at)
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_provider_auth_snapshots_account_active
    ON cloud_agent_provider_auth_snapshots(account_id, provider, auth_choice)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS cloud_agent_provider_auth_snapshot_audit (
    audit_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES cloud_agent_provider_auth_snapshots(snapshot_id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    run_id TEXT REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('created', 'used', 'revoked')),
    created_at TEXT NOT NULL
);
```

- [ ] **Step 3: Implement encryption boundary**

In `provider_auth.rs`, define an interface that can be backed by env key locally and KMS later:

```rust
pub trait ProviderAuthCipher: Send + Sync {
    fn key_id(&self) -> &str;
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError>;
    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError>;
}
```

The first implementation may use `KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY` with authenticated encryption. It must fail closed if the key is missing in production.

- [ ] **Step 4: Add APIs**

Add authenticated endpoints:

- `POST /v1/cloud/agent-provider-auth/snapshots`
- `DELETE /v1/cloud/agent-provider-auth/snapshots/:snapshot_id`
- `GET /v1/cloud/agent-provider-auth/snapshots/current`

- [ ] **Step 5: Add desktop client helpers**

In `authClient.ts`, add:

```ts
export type CloudProviderAuthSnapshotInput = {
  provider: string;
  authChoice: string;
  payload: unknown;
};

export type CloudProviderAuthSnapshot = {
  snapshotId: string;
  provider: string;
  authChoice: string;
  createdAt: string;
  revokedAt: string | null;
};
```

Add functions to publish, fetch current, and revoke snapshots.

- [ ] **Step 6: Run tests**

```bash
cargo test -p kordi-cloud-server provider_auth --test cloud_agent_runtime_e2e
cd app/desktop && pnpm test -- cloudProviderAuthSnapshot.test.tsx
```

- [ ] **Step 7: Commit Task 2**

```bash
git add bridges/cloud-server/migrations/0019_cloud_agent_provider_auth_snapshots.sql \
  bridges/cloud-server/src/cloud_agent_runtime/provider_auth.rs \
  bridges/cloud-server/src/cloud_agent_runtime/mod.rs \
  bridges/cloud-server/src/cloud_agent_runtime/routes.rs \
  bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs \
  app/desktop/src/features/cloud/authClient.ts \
  app/desktop/src/features/cloud/providerAuthSnapshot.ts \
  app/desktop/tests/cloudProviderAuthSnapshot.test.tsx
git commit -m "feat: add cloud provider auth snapshots"
```

---

## Task 3: Cloud Agent Runner service skeleton

**Files:**
- Create: `bridges/cloud-agent-runner/Cargo.toml`
- Create: `bridges/cloud-agent-runner/src/main.rs`
- Create: `bridges/cloud-agent-runner/src/client.rs`
- Create: `bridges/cloud-agent-runner/src/runtime.rs`
- Create: `bridges/cloud-agent-runner/src/prompt.rs`
- Modify: `Cargo.toml`
- Test: `bridges/cloud-agent-runner/src/runtime.rs` unit tests

- [ ] **Step 1: Write failing runner tests**

Test that the runner:

- polls/leases one queued run,
- marks it running,
- writes exactly one completed response,
- marks failed when provider auth is missing,
- does not process cancelled runs.

- [ ] **Step 2: Add workspace crate**

Modify root `Cargo.toml` members:

```toml
"bridges/cloud-agent-runner",
```

Create `bridges/cloud-agent-runner/Cargo.toml`:

```toml
[package]
name = "kordi-cloud-agent-runner"
version = "0.0.1"
edition = "2021"
license.workspace = true
authors.workspace = true
repository.workspace = true
publish = false

[[bin]]
name = "kordi-cloud-agent-runner"
path = "src/main.rs"

[dependencies]
anyhow.workspace = true
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
reqwest.workspace = true
chrono.workspace = true
uuid.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
kordi-core.workspace = true
kordi-provider.workspace = true
kordi-tools.workspace = true
kordi-session.workspace = true
```

- [ ] **Step 3: Implement runner loop**

`main.rs` should read:

- `KORDI_CLOUD_API_BASE`
- `KORDI_CLOUD_RUNNER_TOKEN`
- `KORDI_CLOUD_RUNNER_ID`
- `KORDI_CLOUD_RUNNER_POLL_MS`

Then poll lease endpoint, process one run at a time for the MVP, and report completion/failure.

- [ ] **Step 4: Add Cloud server runner endpoints**

Extend Task 1 routes:

- `POST /v1/cloud/agent-runs/lease`
- `POST /v1/cloud/agent-runs/:run_id/running`
- `POST /v1/cloud/agent-runs/:run_id/complete`
- `POST /v1/cloud/agent-runs/:run_id/fail`

Use a separate runner bearer token, not user session auth.

- [ ] **Step 5: Run tests**

```bash
cargo test -p kordi-cloud-agent-runner
cargo test -p kordi-cloud-server cloud_agent_runtime --test cloud_agent_runtime_e2e
```

- [ ] **Step 6: Commit Task 3**

```bash
git add Cargo.toml bridges/cloud-agent-runner bridges/cloud-server/src/cloud_agent_runtime bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs
git commit -m "feat: add cloud agent runner skeleton"
```

---

## Task 4: Sandbox metadata, persistence, TTL, and quotas

**Files:**
- Create: `bridges/cloud-server/migrations/0020_cloud_agent_sandboxes.sql`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/sandboxes.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/mod.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
- Test: extend `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`

- [ ] **Step 1: Write failing tests for sandbox scope**

Tests must prove:

- group/project sessions reuse one shared sandbox,
- direct/private sessions use requester-isolated sandbox keys,
- sandbox lookup never returns a sandbox for an unauthorized account,
- inactive sandboxes can be marked expired without deleting shared artifacts.

- [ ] **Step 2: Add migration**

Create `bridges/cloud-server/migrations/0020_cloud_agent_sandboxes.sql`:

```sql
CREATE TABLE IF NOT EXISTS cloud_agent_sandboxes (
    sandbox_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('shared_session', 'requester_isolated')),
    requester_account_id TEXT REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    owner_account_id TEXT NOT NULL REFERENCES cloud_accounts(account_id) ON DELETE CASCADE,
    workspace_key TEXT NOT NULL UNIQUE,
    storage_quota_bytes BIGINT NOT NULL,
    used_bytes BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_sandboxes_session_active
    ON cloud_agent_sandboxes(session_id, deleted_at, last_used_at);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_sandboxes_expiry
    ON cloud_agent_sandboxes(expires_at)
    WHERE deleted_at IS NULL;
```

- [ ] **Step 3: Implement sandbox key derivation**

Rules:

- `shared_session`: `sandbox:{session_id}:shared:{owner_account_id}`
- `requester_isolated`: `sandbox:{session_id}:requester:{requester_account_id}:owner:{owner_account_id}`

Normalize by hashing the raw key before storing as object/pvc identifier.

- [ ] **Step 4: Attach sandbox to run claim**

When claiming a run, compute or create its sandbox row and store `sandbox_id` on `cloud_agent_fallback_runs` through an additive migration if Task 1 shipped without it:

```sql
ALTER TABLE cloud_agent_fallback_runs
    ADD COLUMN IF NOT EXISTS sandbox_id TEXT REFERENCES cloud_agent_sandboxes(sandbox_id) ON DELETE SET NULL;
```

- [ ] **Step 5: Run tests**

```bash
cargo test -p kordi-cloud-server sandbox --test cloud_agent_runtime_e2e
```

- [ ] **Step 6: Commit Task 4**

```bash
git add bridges/cloud-server/migrations/0020_cloud_agent_sandboxes.sql \
  bridges/cloud-server/src/cloud_agent_runtime/sandboxes.rs \
  bridges/cloud-server/src/cloud_agent_runtime/mod.rs \
  bridges/cloud-server/src/cloud_agent_runtime/runs.rs \
  bridges/cloud-server/src/cloud_agent_runtime/routes.rs \
  bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs
git commit -m "feat: add cloud agent sandbox metadata"
```

---

## Task 5: Sandbox tool backend and policy gate

**Files:**
- Create: `bridges/cloud-agent-runner/src/tool_policy.rs`
- Create: `bridges/cloud-agent-runner/src/tools.rs`
- Create: `bridges/cloud-agent-runner/src/sandbox_client.rs`
- Modify: `bridges/cloud-agent-runner/src/runtime.rs`
- Modify: `agent/crates/tools/src/registry.rs` only if a runtime-scoped registry hook is required.
- Test: `bridges/cloud-agent-runner/src/tool_policy.rs` and `bridges/cloud-agent-runner/src/tools.rs`

- [ ] **Step 1: Write failing policy tests**

Cover:

- `read`, `write`, `edit`, `find`, `grep`, `ls`, `bash` are allowed only for sandbox paths,
- web tools are allowed from runner environment,
- owner-local path attempts are blocked,
- `reach_out` and cross-user data access are blocked for Cloud fallback until a specific safe remote implementation exists.

- [ ] **Step 2: Implement policy classifier**

Create `tool_policy.rs` with:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunnerToolDecision {
    AllowSandbox,
    AllowRemoteWeb,
    BlockOwnerLocal,
    BlockOtherUserData,
    BlockUnsupported,
}

pub fn decide_runner_tool(tool_name: &str, path_args: &[String]) -> RunnerToolDecision {
    match tool_name {
        "read" | "write" | "edit" | "find" | "grep" | "ls" | "bash" => {
            if path_args.iter().any(|path| path.starts_with("/Users/") || path.starts_with("/home/") || path.starts_with("~")) {
                RunnerToolDecision::BlockOwnerLocal
            } else {
                RunnerToolDecision::AllowSandbox
            }
        }
        "web_search" | "web_fetch" | "browser_fetch" => RunnerToolDecision::AllowRemoteWeb,
        "reach_out" => RunnerToolDecision::BlockUnsupported,
        _ => RunnerToolDecision::BlockUnsupported,
    }
}
```

- [ ] **Step 3: Implement sandbox client boundary**

`sandbox_client.rs` owns the execution transport. Initial local-dev implementation can execute inside a configured workspace directory. K3s implementation uses sandbox executor service/pod later without changing the policy interface.

- [ ] **Step 4: Route runner tool calls through policy**

`runtime.rs` must call policy before executing any tool. Blocked actions return a model-visible tool error that follows the runtime principle: Cloud sandbox cannot access owner-local/private resources while owner device is offline.

- [ ] **Step 5: Run tests**

```bash
cargo test -p kordi-cloud-agent-runner tool_policy
cargo test -p kordi-cloud-agent-runner tools
```

- [ ] **Step 6: Commit Task 5**

```bash
git add bridges/cloud-agent-runner/src/tool_policy.rs \
  bridges/cloud-agent-runner/src/tools.rs \
  bridges/cloud-agent-runner/src/sandbox_client.rs \
  bridges/cloud-agent-runner/src/runtime.rs \
  agent/crates/tools/src/registry.rs
git commit -m "feat: gate cloud runner tools to sandbox scope"
```

---

## Task 6: Artifact export from sandbox to chat

**Files:**
- Create: `bridges/cloud-agent-runner/src/artifacts.rs`
- Modify: `bridges/cloud-agent-runner/src/runtime.rs`
- Modify: `bridges/cloud-server/src/attachments.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
- Test: `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`

- [ ] **Step 1: Write failing artifact tests**

Tests must prove:

- sandbox files are invisible until explicitly exported,
- exported artifact creates a Cloud attachment or session artifact row,
- only chat participants can request a download URL,
- deleting/expiring sandbox does not delete exported artifact metadata.

- [ ] **Step 2: Add export endpoint**

Add runner-auth endpoint:

- `POST /v1/cloud/agent-runs/:run_id/artifacts`

Request shape:

```json
{
  "name": "report.md",
  "path": "report.md",
  "contentType": "text/markdown",
  "sizeBytes": 1234,
  "sha256Hex": "..."
}
```

- [ ] **Step 3: Reuse attachment/object storage path**

Use existing S3 config and attachment metadata. The runner uploads content to the presigned/object path, then Cloud server links it to the run/session response.

- [ ] **Step 4: Run tests**

```bash
cargo test -p kordi-cloud-server artifact --test cloud_agent_runtime_e2e
cargo test -p kordi-cloud-agent-runner artifacts
```

- [ ] **Step 5: Commit Task 6**

```bash
git add bridges/cloud-agent-runner/src/artifacts.rs \
  bridges/cloud-agent-runner/src/runtime.rs \
  bridges/cloud-server/src/attachments.rs \
  bridges/cloud-server/src/cloud_agent_runtime/routes.rs \
  bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs
git commit -m "feat: export cloud sandbox artifacts to chat"
```

---

## Task 7: K3s deployment and takotako e2e

**Files:**
- Create: `bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner.yaml`
- Create: `bridges/cloud-server/deploy/k3s/manifests/cloud-agent-sandbox.yaml`
- Modify: `bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh`
- Modify: `bridges/cloud-server/deploy/sync-and-build.sh`
- Create: `scripts/cloud-agent-runtime-e2e.mjs`
- Test: takotako deployed e2e with three preview users.

- [ ] **Step 1: Add manifests**

Runner manifest must include:

- deployment with at least two replicas for warm pool behavior,
- env: `KORDI_CLOUD_API_BASE`, `KORDI_CLOUD_RUNNER_TOKEN`, `KORDI_CLOUD_RUNNER_ID`, `KORDI_CLOUD_RUNNER_POLL_MS`,
- resource requests/limits,
- network policy that permits Cloud server and sandbox executor only as needed.

Sandbox manifest must include:

- isolated execution pod/job template or service,
- workspace PVC or object-backed workspace mount,
- CPU/memory/ephemeral storage limits,
- no hostPath mounts,
- no privileged mode,
- restricted service account.

- [ ] **Step 2: Build and deploy images**

Extend sync/build to build:

- `kordi-cloud-server`,
- `kordi-cloud-agent-runner`,
- sandbox executor image if separate from runner.

- [ ] **Step 3: Run e2e manually on takotako**

Use:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c
```

Tunnel:

```bash
# local 127.0.0.1:17081 -> takotako 127.0.0.1:17082 -> k3s svc/kordi-cloud-server:17081
```

Preview instances:

- `http://127.0.0.1:1482`
- `http://127.0.0.1:1484`
- `http://127.0.0.1:1486`

Validation flow:

1. Sign in all three users.
2. Ensure accepted contacts/group session exists.
3. Enable provider-auth snapshot for owner.
4. Quit owner device and wait for presence offline.
5. Mention owner's agent from accepted contact.
6. Confirm one Cloud fallback run is created and completed.
7. Ask for a sandbox-local file/code task and confirm it succeeds.
8. Ask for owner-local file access and confirm it is blocked with boundary explanation.
9. Reopen owner device and confirm next turn is handled by desktop, not Cloud fallback.

- [ ] **Step 4: Run verification commands**

```bash
cargo test -p kordi-cloud-server cloud_agent_runtime --test cloud_agent_runtime_e2e
cargo test -p kordi-cloud-agent-runner
cd app/desktop && pnpm typecheck
node scripts/cloud-agent-runtime-e2e.mjs --cloud-base http://127.0.0.1:17081
```

- [ ] **Step 5: Commit Task 7**

```bash
git add bridges/cloud-server/deploy/k3s/manifests/cloud-agent-runner.yaml \
  bridges/cloud-server/deploy/k3s/manifests/cloud-agent-sandbox.yaml \
  bridges/cloud-server/deploy/k3s/deploy-cloud-server.sh \
  bridges/cloud-server/deploy/sync-and-build.sh \
  scripts/cloud-agent-runtime-e2e.mjs
git commit -m "deploy: add cloud agent runner sandbox runtime"
```

---

## PR order and merge policy

1. PR A: Task 1 only. This creates safe claim/dedupe state and proves Cloud does not duplicate desktop execution.
2. PR B: Task 2 only. This adds explicit encrypted provider-auth snapshot support.
3. PR C: Task 3 only. This adds the runner service skeleton with fake/minimal completion.
4. PR D: Task 4 only. This adds sandbox metadata and retention model.
5. PR E: Task 5 only. This enables sandbox tool policy and execution.
6. PR F: Task 6 only. This enables artifact export.
7. PR G: Task 7 only. This deploys K3s runner/sandbox and validates e2e.

Do not merge any PR before user testing. Keep #490 draft/reference unmerged.

## Final verification checklist

Before claiming the full runtime is implemented:

- [ ] `cargo test -p kordi-cloud-server cloud_agent_runtime --test cloud_agent_runtime_e2e` passes.
- [ ] `cargo test -p kordi-cloud-agent-runner` passes.
- [ ] `cd app/desktop && pnpm typecheck` passes.
- [ ] Takotako `/health` through tunnel returns `200`.
- [ ] Three local preview instances stay exactly on `1482`, `1484`, `1486`.
- [ ] Owner offline mention creates exactly one Cloud fallback response.
- [ ] Owner reconnect prevents subsequent duplicate Cloud fallback.
- [ ] Sandbox-local bash/file/code task works.
- [ ] Owner-local/private task is blocked with capability-boundary explanation.
- [ ] Exported artifact is visible only through explicit chat artifact/attachment sharing.
- [ ] Provider-auth snapshot can be revoked and then blocks fallback model execution.
