# Cloud Runner Model Loop MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloud Agent Runner placeholder completion with a real OpenAI-compatible model loop that uses Cloud provider-auth snapshots, sandbox-gated tools, and explicit artifact export.

**Architecture:** Cloud server exposes decrypted provider-auth material only through a runner-auth endpoint scoped to a claimed run. The runner fetches that material, builds a Cloud sandbox prompt, calls a model provider abstraction, executes bounded tool calls through the existing sandbox policy/export helpers, and completes or fails the run.

**Tech Stack:** Rust workspace, Axum, sqlx/Postgres, reqwest, serde_json, async-trait, existing `kordi-cloud-server` provider-auth encryption, existing `kordi-cloud-agent-runner` client/runtime/tools/artifacts.

---

## File structure

### Server

- Modify: `bridges/cloud-server/src/cloud_agent_runtime/provider_auth.rs`
  - Add `RunnerProviderAuthMaterial` response and `provider_auth_for_run` helper that decrypts latest active snapshot for the run owner and records `used` audit.
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
  - Add runner-auth `POST /v1/cloud/agent-runs/:run_id/provider-auth`.
- Test: `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`
  - Add e2e tests for runner-only provider-auth material access, wrong-runner denial, missing snapshot, decrypted payload, and audit.

### Runner

- Create: `bridges/cloud-agent-runner/src/model_loop.rs`
  - Prompt builder, provider-auth config parsing, `CloudModelProvider` trait, OpenAI-compatible provider, tool-call loop, and tests.
- Modify: `bridges/cloud-agent-runner/src/client.rs`
  - Add `ProviderAuthMaterial` types and `fetch_provider_auth` method.
- Modify: `bridges/cloud-agent-runner/src/runtime.rs`
  - Replace placeholder completion with `run_model_loop` when provider auth is available.
- Modify: `bridges/cloud-agent-runner/src/lib.rs`
  - Export `model_loop`.
- Test: extend `bridges/cloud-agent-runner/src/runtime.rs` tests and add `model_loop` unit tests.

---

## Task 1: Server runner provider-auth material endpoint

**Files:**
- Modify: `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/provider_auth.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`

- [ ] **Step 1: Write failing server e2e tests**

Add a test to `cloud_agent_runtime_e2e.rs` that creates owner/requester, publishes a provider-auth snapshot, claims and leases a run, and calls `POST /v1/cloud/agent-runs/:run_id/provider-auth`.

Expected assertions:

```rust
assert_eq!(provider_auth.status(), StatusCode::OK);
let body = read_json(provider_auth).await;
assert_eq!(body["providerAuth"]["provider"], "openai");
assert_eq!(body["providerAuth"]["payload"]["apiKey"], "runner-secret");
assert_eq!(body["providerAuth"]["payload"]["baseUrl"], "https://api.openai.com/v1");
assert_eq!(body["providerAuth"]["payload"]["model"], "gpt-4.1-mini");
```

Add two negative checks in the same test file:

```rust
// user token is rejected
assert_eq!(user_token_response.status(), StatusCode::UNAUTHORIZED);
// wrong runner cannot fetch this run's provider auth
assert_eq!(wrong_runner_response.status(), StatusCode::NOT_FOUND);
```

Add missing snapshot check:

```rust
assert_eq!(missing_snapshot_response.status(), StatusCode::NOT_FOUND);
let body = read_json(missing_snapshot_response).await;
assert_eq!(body["errorCode"], "provider_auth_not_found");
```

- [ ] **Step 2: Run tests to verify red**

Run:

```bash
DATABASE_URL=${DATABASE_URL:-postgresql://kordi:kordi@127.0.0.1:15432/kordi_cloud} \
KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY='test-provider-auth-key-that-is-long-enough' \
cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e provider_auth_material -- --nocapture --test-threads=1
```

Expected: route returns 404 because it does not exist.

- [ ] **Step 3: Add server provider-auth material helper**

In `provider_auth.rs`, add:

```rust
#[derive(Debug, Serialize)]
pub struct RunnerProviderAuthMaterialEnvelope {
    #[serde(rename = "providerAuth")]
    pub provider_auth: RunnerProviderAuthMaterial,
}

#[derive(Debug, Serialize)]
pub struct RunnerProviderAuthMaterial {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: serde_json::Value,
}

pub async fn provider_auth_for_run(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<RunnerProviderAuthMaterial>, sqlx_core::Error> {
    let run: Option<(String,)> = query_as(
        "SELECT owner_account_id FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner_account_id,)) = run else { return Ok(None); };

    let row: Option<(String, String, String, Vec<u8>)> = query_as(
        "SELECT snapshot_id, provider, auth_choice, encrypted_payload \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&owner_account_id)
    .fetch_optional(pool)
    .await?;
    let Some((snapshot_id, provider, auth_choice, encrypted_payload)) = row else { return Ok(None); };
    let plaintext = cipher
        .decrypt(&encrypted_payload)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let payload = serde_json::from_slice(&plaintext)
        .map_err(|err| sqlx_core::Error::Decode(Box::new(err)))?;
    record_snapshot_used(pool, &snapshot_id, &owner_account_id, Some(run_id)).await?;
    Ok(Some(RunnerProviderAuthMaterial { snapshot_id, provider, auth_choice, payload }))
}
```

- [ ] **Step 4: Add runner route**

In `routes.rs`, import:

```rust
use crate::cloud_agent_runtime::provider_auth::{
    current_snapshot, provider_auth_for_run, publish_snapshot, revoke_snapshot,
    CurrentProviderAuthSnapshotQuery, CurrentProviderAuthSnapshotResponse, EnvProviderAuthCipher,
    PublishProviderAuthSnapshotRequest, RunnerProviderAuthMaterialEnvelope,
};
```

Add route:

```rust
.route(
    "/v1/cloud/agent-runs/:run_id/provider-auth",
    post(fetch_runner_provider_auth),
)
```

Add handler:

```rust
async fn fetch_runner_provider_auth(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<RunnerRunRequest>,
) -> Response {
    if !runner_authorized(&headers) {
        return runner_unauthorized();
    }
    let Some(runner_id) = input.runner_id() else {
        return error_response("invalid_runner_request", "runnerId is required.", StatusCode::BAD_REQUEST);
    };
    let cipher = match EnvProviderAuthCipher::from_env() {
        Ok(cipher) => cipher,
        Err(err) => {
            eprintln!("[cloud_agent_runtime] provider auth cipher unavailable: {err}");
            return error_response("provider_auth_not_configured", "Cloud provider-auth snapshots are not configured on this server.", StatusCode::SERVICE_UNAVAILABLE);
        }
    };
    match provider_auth_for_run(state.db_pool(), &cipher, &run_id, &runner_id).await {
        Ok(Some(provider_auth)) => Json(RunnerProviderAuthMaterialEnvelope { provider_auth }).into_response(),
        Ok(None) => error_response("provider_auth_not_found", "Cloud provider-auth snapshot was not found for this run.", StatusCode::NOT_FOUND),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] fetch provider auth for run: {err}");
            error_response("server_error", "Could not load Cloud provider-auth material.", StatusCode::INTERNAL_SERVER_ERROR)
        }
    }
}
```

- [ ] **Step 5: Run server tests and commit**

Run:

```bash
rustfmt --edition 2021 --check bridges/cloud-server/src/cloud_agent_runtime/provider_auth.rs bridges/cloud-server/src/cloud_agent_runtime/routes.rs bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs
cargo test -p kordi-cloud-server cloud_agent_runtime
```

Then commit:

```bash
git add bridges/cloud-server/src/cloud_agent_runtime/provider_auth.rs \
  bridges/cloud-server/src/cloud_agent_runtime/routes.rs \
  bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs
git commit -m "feat: expose run-scoped provider auth to cloud runner"
```

---

## Task 2: Runner client and model-loop core

**Files:**
- Modify: `bridges/cloud-agent-runner/src/client.rs`
- Create: `bridges/cloud-agent-runner/src/model_loop.rs`
- Modify: `bridges/cloud-agent-runner/src/lib.rs`

- [ ] **Step 1: Write failing runner model-loop tests**

Create tests inside `model_loop.rs` for:

```rust
#[tokio::test]
async fn model_loop_completes_text_response() { /* fake provider returns final text */ }

#[tokio::test]
async fn model_loop_executes_sandbox_tool_call_then_finishes() { /* fake provider asks write, then final */ }

#[tokio::test]
async fn model_loop_returns_boundary_explanation_for_owner_local_tool() { /* fake provider asks read /Users/... */ }

#[tokio::test]
async fn model_loop_exports_artifact_when_requested() { /* fake provider asks export_artifact */ }
```

Run:

```bash
cargo test -p kordi-cloud-agent-runner model_loop -- --nocapture
```

Expected: unresolved `model_loop` module/types.

- [ ] **Step 2: Extend runner client with provider-auth fetch**

In `client.rs`, add:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderAuthMaterial {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ProviderAuthEnvelope {
    #[serde(rename = "providerAuth")]
    provider_auth: ProviderAuthMaterial,
}
```

Add trait method:

```rust
async fn fetch_provider_auth(&self, run_id: &str) -> Result<ProviderAuthMaterial, RunnerClientError>;
```

Add HTTP implementation:

```rust
async fn fetch_provider_auth(&self, run_id: &str) -> Result<ProviderAuthMaterial, RunnerClientError> {
    let envelope: ProviderAuthEnvelope = self
        .post_json(
            &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
            serde_json::json!({ "runnerId": self.runner_id }),
        )
        .await?;
    Ok(envelope.provider_auth)
}
```

- [ ] **Step 3: Implement model-loop module**

Create `model_loop.rs` with:

```rust
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::artifacts::export_sandbox_file;
use crate::client::{CloudAgentRun, CloudAgentRunClient, ProviderAuthMaterial, RunnerClientError};
use crate::sandbox_client::LocalSandboxBackend;
use crate::tool_policy::RunnerToolRequest;
use crate::tools::{CloudToolExecutor, CloudToolOutput};

pub const MAX_MODEL_CALLS: usize = 3;
pub const MAX_TOOL_CALLS: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelProviderResponse {
    FinalText(String),
    ToolCalls(Vec<ModelToolCall>),
}

#[derive(Debug, thiserror::Error)]
pub enum ModelLoopError {
    #[error("provider error: {0}")]
    Provider(String),
    #[error("tool loop limit exceeded")]
    LimitExceeded,
    #[error("runner client error: {0}")]
    Client(#[from] RunnerClientError),
}

#[async_trait]
pub trait CloudModelProvider {
    async fn next_response(
        &self,
        auth: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiProviderConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}
```

Then add:

- `OpenAiProviderConfig::from_material(material: &ProviderAuthMaterial)` parsing `apiKey` or `accessToken`, `baseUrl`, `model`.
- `cloud_sandbox_system_prompt()` returning the boundary prompt.
- `tool_catalog()` returning JSON function schemas for read/write/bash/export_artifact.
- `run_model_loop(client, provider, run, sandbox, auth)` executing up to 3 model calls / 5 tool calls.
- `OpenAiCompatibleProvider` that POSTs to `{base_url}/chat/completions` with `{model, messages, tools}` and parses either `message.content` or `message.tool_calls`.

- [ ] **Step 4: Export module and run tests**

Modify `lib.rs`:

```rust
pub mod model_loop;
```

Run:

```bash
rustfmt --edition 2021 --check bridges/cloud-agent-runner/src/model_loop.rs bridges/cloud-agent-runner/src/client.rs bridges/cloud-agent-runner/src/lib.rs
cargo test -p kordi-cloud-agent-runner model_loop -- --nocapture
```

Commit:

```bash
git add bridges/cloud-agent-runner/src/model_loop.rs bridges/cloud-agent-runner/src/client.rs bridges/cloud-agent-runner/src/lib.rs
git commit -m "feat: add cloud runner model loop"
```

---

## Task 3: Wire runtime to model loop

**Files:**
- Modify: `bridges/cloud-agent-runner/src/runtime.rs`

- [ ] **Step 1: Write failing runtime tests**

Extend runtime fake client with provider-auth material and assert:

```rust
#[tokio::test]
async fn uses_model_loop_text_instead_of_placeholder() { /* fake provider returns text */ }

#[tokio::test]
async fn marks_failed_when_provider_auth_fetch_fails() { /* client fetch_provider_auth errors */ }
```

Run:

```bash
cargo test -p kordi-cloud-agent-runner runtime -- --nocapture
```

Expected: existing runtime still completes with placeholder text.

- [ ] **Step 2: Add runtime entrypoint with provider injection**

In `runtime.rs`, keep `process_one_run(&client)` for production, but implement it by calling:

```rust
pub async fn process_one_run_with_provider<C, P>(
    client: &C,
    provider: &P,
    sandbox_root: std::path::PathBuf,
) -> Result<RunnerStepOutcome, RunnerClientError>
where
    C: CloudAgentRunClient + Sync,
    P: crate::model_loop::CloudModelProvider + Sync,
{
    // lease, cancelled/missing auth checks, mark running,
    // fetch provider auth,
    // run_model_loop,
    // complete/fail
}
```

Production `process_one_run` should use:

```rust
let provider = crate::model_loop::OpenAiCompatibleProvider::default();
let sandbox_root = std::env::var("KORDI_CLOUD_SANDBOX_ROOT")
    .map(std::path::PathBuf::from)
    .unwrap_or_else(|_| std::env::temp_dir().join("kordi-cloud-runner-sandbox"));
process_one_run_with_provider(client, &provider, sandbox_root).await
```

- [ ] **Step 3: Run tests and commit**

Run:

```bash
rustfmt --edition 2021 --check bridges/cloud-agent-runner/src/runtime.rs
cargo test -p kordi-cloud-agent-runner
```

Commit:

```bash
git add bridges/cloud-agent-runner/src/runtime.rs
git commit -m "feat: run leased cloud agent turns through model loop"
```

---

## Task 4: Verification, remote e2e, and PR

**Files:**
- Create/update: `/tmp/issue-505-model-loop-pr.md`

- [ ] **Step 1: Local verification**

Run:

```bash
rustfmt --edition 2021 --check bridges/cloud-agent-runner/src/*.rs bridges/cloud-agent-runner/tests/*.rs bridges/cloud-server/src/cloud_agent_runtime/*.rs bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs
cargo test -p kordi-cloud-agent-runner
cargo test -p kordi-cloud-server cloud_agent_runtime
cargo test -p kordi-cloud-server presence
```

- [ ] **Step 2: Sync/build and remote tests**

Run:

```bash
bridges/cloud-server/deploy/sync-and-build.sh
```

Then run takotako full e2e with VM-local Postgres port-forward, same pattern as #504:

```bash
KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY='test-provider-auth-key-that-is-long-enough' \
DATABASE_URL='postgresql://kordi:kordi@127.0.0.1:15432/kordi_cloud' \
$HOME/.cargo/bin/cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e -- --nocapture --test-threads=1
```

Also run:

```bash
cargo test -p kordi-cloud-agent-runner
kubectl -n kordi-cloud run hc-issue505-final -i --rm --restart=Never --image=curlimages/curl:8.10.1 --quiet -- -sS http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081/health
```

- [ ] **Step 3: Create stacked draft PR**

Push branch and create PR:

```bash
git push -u origin feature/issue-505-cloud-runner-model-loop
gh pr create --draft --base feature/issue-504-cloud-artifact-export --head feature/issue-505-cloud-runner-model-loop --title "feat: run cloud fallback turns through model loop" --body-file /tmp/issue-505-model-loop-pr.md
```

Keep draft until user testing.
