# Cloud Sandbox Artifact Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit full-byte Cloud sandbox artifact export so runner-shared sandbox files become authorized Cloud chat attachments while unexported sandbox files remain private.

**Architecture:** Cloud Agent Runner reads a sandbox-local file only when an explicit export action is requested, then sends bytes to a runner-auth Cloud server endpoint. Cloud server validates runner/run/sandbox authorization, stores bytes in object storage using server-owned S3 config, persists attachment/artifact/link metadata, and ties visibility to the run response Cloud message.

**Tech Stack:** Rust workspace (`kordi-cloud-server`, `kordi-cloud-agent-runner`), Axum routes, Postgres/sqlx migrations, existing `cloud_attachments` / `cloud_message_attachments` / `cloud_session_artifacts`, server-proxied S3-compatible object storage, TDD with local unit tests and remote Postgres e2e.

---

## File structure

### Cloud server

- Create: `bridges/cloud-server/migrations/0021_cloud_agent_run_artifacts.sql`
  - Stores explicit run artifact exports and links runs, sandboxes, attachments, and response messages.
- Create: `bridges/cloud-server/src/cloud_agent_runtime/artifacts.rs`
  - Request validation, runner export handler logic, response-message creation/update helper, object upload helper, and row inserts.
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/mod.rs`
  - Exports `artifacts` module.
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
  - Adds `POST /v1/cloud/agent-runs/:run_id/artifacts` under runner-auth routes.
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`
  - Makes `complete_run` create/update a real `cloud_messages` row for the stable `response_message_id`.
- Test: `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`
  - Adds a lightweight in-test object store and e2e coverage for export, content access, auth failures, invalid paths, sha mismatch, and completion/update semantics.

### Cloud Agent Runner

- Create: `bridges/cloud-agent-runner/src/artifacts.rs`
  - Explicit export helper that resolves sandbox paths, reads bytes, computes sha256, and posts bytes to Cloud server.
- Modify: `bridges/cloud-agent-runner/src/client.rs`
  - Adds export request/response types and HTTP method.
- Modify: `bridges/cloud-agent-runner/src/lib.rs`
  - Exports `artifacts` module.
- Modify: `bridges/cloud-agent-runner/Cargo.toml`
  - Adds `base64.workspace = true` and `sha2.workspace = true`.
- Test: `bridges/cloud-agent-runner/tests/cloud_artifact_export.rs`
  - Tests explicit export behavior and local path blocking.

---

## Task 1: Server TDD for explicit full-byte export

**Files:**
- Modify: `bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs`

- [ ] **Step 1: Add in-test object store helper**

Add these imports near the top of `cloud_agent_runtime_e2e.rs`:

```rust
use std::collections::HashMap;
use axum::extract::OriginalUri;
use axum::http::Method;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use kordi_cloud_server::attachments::S3Config;
use url::Url;
```

Add helper code after `test_router`:

```rust
#[derive(Clone)]
struct TestObjectStore {
    endpoint: String,
    objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

impl TestObjectStore {
    async fn spawn() -> Self {
        let objects = Arc::new(Mutex::new(HashMap::<String, Vec<u8>>::new()));
        let app_objects = objects.clone();
        let app = axum::Router::new().fallback(
            move |method: Method, uri: OriginalUri, body: Body| {
                let objects = app_objects.clone();
                async move {
                    let key = uri.0.path().trim_start_matches('/').to_string();
                    match method {
                        Method::PUT => {
                            let bytes = to_bytes(body, 8 * 1024 * 1024).await.unwrap();
                            objects.lock().await.insert(key, bytes.to_vec());
                            StatusCode::OK.into_response()
                        }
                        Method::GET => {
                            let value = objects.lock().await.get(&key).cloned();
                            match value {
                                Some(bytes) => bytes.into_response(),
                                None => StatusCode::NOT_FOUND.into_response(),
                            }
                        }
                        _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
                    }
                }
            },
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            endpoint: format!("http://{}", addr),
            objects,
        }
    }

    fn s3_config(&self) -> S3Config {
        S3Config {
            endpoint: Url::parse(&self.endpoint).unwrap(),
            region: "us-east-1".to_string(),
            bucket: "kordi-test".to_string(),
            access_key: "test-access".to_string(),
            secret_key: "test-secret".to_string(),
        }
    }
}

fn test_router_with_s3(pool: sqlx_postgres::PgPool, store: &TestObjectStore) -> axum::Router {
    let state = Arc::new(ServerState::new(pool, EventBus::noop()).with_s3(store.s3_config()));
    test_router(state)
}
```

- [ ] **Step 2: Add helper functions for artifact export tests**

Add these helpers near existing request helpers:

```rust
fn get_json_with_runner_token(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

fn export_body(runner_id: &str, name: &str, sandbox_path: &str, bytes: &[u8]) -> Value {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let sha = Sha256::digest(bytes);
    json!({
        "runnerId": runner_id,
        "name": name,
        "sandboxPath": sandbox_path,
        "contentType": "text/markdown",
        "sha256Hex": format!("{sha:x}"),
        "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

async fn lease_claimed_run_for_export(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    owner: &TestAccount,
    requester: &TestAccount,
    request_message_id: &str,
    runner_id: &str,
) -> String {
    let claim = router
        .clone()
        .oneshot(post_json_with_token(
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            claim_body(owner, requester, request_message_id),
        ))
        .await
        .unwrap();
    assert_eq!(claim.status(), StatusCode::OK);
    let run_id = read_json(claim).await["runId"].as_str().unwrap().to_string();
    cancel_other_queued_runs(pool, &run_id).await;
    let lease = router
        .clone()
        .oneshot(post_json_with_runner_token(
            "/v1/cloud/agent-runs/lease",
            "runner-test-token",
            json!({ "runnerId": runner_id }),
        ))
        .await
        .unwrap();
    assert_eq!(lease.status(), StatusCode::OK);
    assert_eq!(read_json(lease).await["run"]["runId"], run_id);
    run_id
}
```

- [ ] **Step 3: Write failing export success/access test**

Add this test:

```rust
#[tokio::test]
async fn runner_explicit_artifact_export_creates_object_backed_chat_attachment() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-owner", "Owner").await;
    let requester = signup(&router, "artifact-requester", "Requester").await;
    let stranger = signup(&router, "artifact-stranger", "Stranger").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router.clone().oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token)).await.unwrap().status(),
        StatusCode::OK
    );

    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_export",
        "runner-export",
    )
    .await;

    let unexported_count: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_run_artifacts WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unexported_count.0, 0);

    let bytes = b"# Report\nGenerated inside the Cloud sandbox.\n";
    let export = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            export_body("runner-export", "report.md", "report.md", bytes),
        ))
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::CREATED);
    let body = read_json(export).await;
    let attachment_id = body["artifact"]["attachmentId"].as_str().unwrap().to_string();
    let message_id = body["artifact"]["messageId"].as_str().unwrap().to_string();
    assert_eq!(body["artifact"]["runId"], run_id);
    assert_eq!(body["artifact"]["name"], "report.md");
    assert_eq!(body["artifact"]["sandboxPath"], "report.md");

    let linked: (i64,) = sqlx_core::query_as::query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_message_attachments WHERE message_id = $1 AND attachment_id = $2",
    )
    .bind(&message_id)
    .bind(&attachment_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(linked.0, 1);

    let requester_content = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/content"),
            &requester.token,
        ))
        .await
        .unwrap();
    assert_eq!(requester_content.status(), StatusCode::OK);
    let requester_bytes = to_bytes(requester_content.into_body(), 1024 * 1024).await.unwrap();
    assert_eq!(&requester_bytes[..], bytes);

    let stranger_content = router
        .clone()
        .oneshot(get_with_token(
            &format!("/v1/cloud/attachments/{attachment_id}/content"),
            &stranger.token,
        ))
        .await
        .unwrap();
    assert_eq!(stranger_content.status(), StatusCode::NOT_FOUND);
}
```

- [ ] **Step 4: Write failing invalid export tests**

Add this test:

```rust
#[tokio::test]
async fn runner_artifact_export_rejects_bad_auth_paths_and_sha_mismatch() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-invalid-owner", "Owner").await;
    let requester = signup(&router, "artifact-invalid-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router.clone().oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token)).await.unwrap().status(),
        StatusCode::OK
    );
    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_invalid",
        "runner-invalid",
    )
    .await;

    let user_token = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            &requester.token,
            export_body("runner-invalid", "report.md", "report.md", b"ok"),
        ))
        .await
        .unwrap();
    assert_eq!(user_token.status(), StatusCode::UNAUTHORIZED);

    for bad_path in ["../secret.txt", "/Users/owner/.ssh/id_rsa", "/tmp/report.md", "~/report.md"] {
        let response = router
            .clone()
            .oneshot(post_json_with_runner_token(
                &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
                "runner-test-token",
                export_body("runner-invalid", "report.md", bad_path, b"ok"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "path={bad_path}");
    }

    let mut bad_sha = export_body("runner-invalid", "report.md", "report.md", b"ok");
    bad_sha["sha256Hex"] = json!("0000000000000000000000000000000000000000000000000000000000000000");
    let response = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            bad_sha,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 5: Write failing completion/update test**

Add this test:

```rust
#[tokio::test]
async fn export_before_completion_uses_stable_response_message_that_completion_updates() {
    let Some(pool) = try_pool().await else { return };
    std::env::set_var("KORDI_CLOUD_RUNNER_TOKEN", "runner-test-token");
    let store = TestObjectStore::spawn().await;
    let router = test_router_with_s3(pool.clone(), &store);
    let owner = signup(&router, "artifact-complete-owner", "Owner").await;
    let requester = signup(&router, "artifact-complete-requester", "Requester").await;
    accept_contacts(&router, &requester, &owner).await;
    assert_eq!(
        router.clone().oneshot(post_with_token("/v1/cloud/presence/offline", &owner.token)).await.unwrap().status(),
        StatusCode::OK
    );
    let run_id = lease_claimed_run_for_export(
        &router,
        &pool,
        &owner,
        &requester,
        "msg_artifact_complete",
        "runner-complete",
    )
    .await;

    let export = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
            "runner-test-token",
            export_body("runner-complete", "report.md", "report.md", b"artifact"),
        ))
        .await
        .unwrap();
    assert_eq!(export.status(), StatusCode::CREATED);
    let message_id = read_json(export).await["artifact"]["messageId"].as_str().unwrap().to_string();

    let complete = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            "runner-test-token",
            json!({ "runnerId": "runner-complete", "responseText": "Here is the exported report." }),
        ))
        .await
        .unwrap();
    assert_eq!(complete.status(), StatusCode::OK);
    assert_eq!(read_json(complete).await["run"]["responseMessageId"], message_id);

    let message: (String,) = sqlx_core::query_as::query_as(
        "SELECT body FROM cloud_messages WHERE message_id = $1",
    )
    .bind(&message_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(message.0, "Here is the exported report.");
}
```

- [ ] **Step 6: Run tests and verify red**

Run:

```bash
DATABASE_URL=${DATABASE_URL:-postgresql://kordi:kordi@127.0.0.1:15432/kordi_cloud} \
KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY='test-provider-auth-key-that-is-long-enough' \
cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e artifact -- --nocapture --test-threads=1
```

Expected: fails because `cloud_agent_run_artifacts` and the export route do not exist.

---

## Task 2: Server implementation for artifact export and real response message persistence

**Files:**
- Create: `bridges/cloud-server/migrations/0021_cloud_agent_run_artifacts.sql`
- Create: `bridges/cloud-server/src/cloud_agent_runtime/artifacts.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/mod.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/routes.rs`
- Modify: `bridges/cloud-server/src/cloud_agent_runtime/runs.rs`

- [ ] **Step 1: Add migration**

Create `bridges/cloud-server/migrations/0021_cloud_agent_run_artifacts.sql`:

```sql
CREATE TABLE IF NOT EXISTS cloud_agent_run_artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES cloud_agent_fallback_runs(run_id) ON DELETE CASCADE,
    sandbox_id TEXT NOT NULL REFERENCES cloud_agent_sandboxes(sandbox_id) ON DELETE RESTRICT,
    attachment_id TEXT NOT NULL REFERENCES cloud_attachments(attachment_id) ON DELETE RESTRICT,
    message_id TEXT NOT NULL REFERENCES cloud_messages(message_id) ON DELETE CASCADE,
    sandbox_path TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256_hex TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_run_artifacts_run_created
    ON cloud_agent_run_artifacts(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_run_artifacts_attachment
    ON cloud_agent_run_artifacts(attachment_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_agent_run_artifacts_run_path_sha
    ON cloud_agent_run_artifacts(run_id, sandbox_path, sha256_hex)
    WHERE sha256_hex IS NOT NULL;
```

- [ ] **Step 2: Add artifacts module skeleton**

Create `bridges/cloud-server/src/cloud_agent_runtime/artifacts.rs`:

```rust
use axum::http::StatusCode;
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::attachments::{presign_upload_url, S3Config};

pub const MAX_ARTIFACT_EXPORT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct ExportArtifactRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    pub name: String,
    #[serde(rename = "sandboxPath")]
    pub sandbox_path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: Option<String>,
    #[serde(rename = "bytesBase64")]
    pub bytes_base64: String,
}

#[derive(Debug, Serialize)]
pub struct ExportArtifactEnvelope {
    pub artifact: ExportedArtifact,
}

#[derive(Debug, Serialize)]
pub struct ExportedArtifact {
    #[serde(rename = "artifactId")]
    pub artifact_id: String,
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub name: String,
    #[serde(rename = "sandboxPath")]
    pub sandbox_path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug)]
pub struct ExportArtifactError {
    pub code: &'static str,
    pub message: &'static str,
    pub status: StatusCode,
}

impl ExportArtifactError {
    fn invalid(message: &'static str) -> Self {
        Self { code: "invalid_artifact_export", message, status: StatusCode::BAD_REQUEST }
    }
}
```

- [ ] **Step 3: Add request validation helpers**

Append to `artifacts.rs`:

```rust
impl ExportArtifactRequest {
    pub fn runner_id(&self) -> Option<String> {
        let value = self.runner_id.trim();
        (!value.is_empty()).then(|| value.to_string())
    }

    pub fn validate_path(&self) -> Result<String, ExportArtifactError> {
        let value = self.sandbox_path.trim();
        if value.is_empty()
            || value.starts_with('/')
            || value.starts_with('~')
            || value.contains("../")
            || value == ".."
            || value.contains("/..")
            || value.starts_with("/Users/")
            || value.starts_with("/home/")
        {
            return Err(ExportArtifactError::invalid("sandboxPath must stay inside the sandbox."));
        }
        Ok(value.to_string())
    }

    pub fn decode_bytes(&self) -> Result<(Vec<u8>, Option<String>), ExportArtifactError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(self.bytes_base64.trim())
            .map_err(|_| ExportArtifactError::invalid("bytesBase64 is invalid."))?;
        if bytes.is_empty() {
            return Err(ExportArtifactError::invalid("artifact bytes are required."));
        }
        if bytes.len() > MAX_ARTIFACT_EXPORT_BYTES {
            return Err(ExportArtifactError { code: "artifact_too_large", message: "Artifact export is too large.", status: StatusCode::PAYLOAD_TOO_LARGE });
        }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if let Some(expected) = self.sha256_hex.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(ExportArtifactError::invalid("sha256Hex must be a 64-character hex digest."));
            }
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err(ExportArtifactError::invalid("sha256Hex does not match artifact bytes."));
            }
            return Ok((bytes, Some(expected.to_ascii_lowercase())));
        }
        Ok((bytes, Some(actual)))
    }

    pub fn validated_name(&self) -> Result<String, ExportArtifactError> {
        let value = self.name.trim();
        if value.is_empty() || value.contains('/') || value.contains('\\') {
            return Err(ExportArtifactError::invalid("name must be a file name."));
        }
        Ok(value.to_string())
    }

    pub fn validated_content_type(&self) -> Result<String, ExportArtifactError> {
        let value = self.content_type.trim();
        if value.is_empty() || value.len() > 255 {
            return Err(ExportArtifactError::invalid("contentType is required."));
        }
        Ok(value.to_string())
    }
}
```

- [ ] **Step 4: Add response message helper**

Append to `artifacts.rs`:

```rust
type RunForExport = (String, String, String, String, String, Option<String>, Option<String>);

async fn run_for_export(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> Result<Option<RunForExport>, sqlx_core::Error> {
    query_as(
        "SELECT run_id, owner_account_id, requester_account_id, session_id, status, sandbox_id, response_message_id \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running', 'completed')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await
}

pub async fn ensure_response_message(
    pool: &PgPool,
    run_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
    session_id: &str,
    body: &str,
) -> Result<String, sqlx_core::Error> {
    if let Some((message_id,)) = query_as::<_, (String,)>(
        "SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1 AND response_message_id IS NOT NULL",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?
    {
        query(
            "INSERT INTO cloud_messages (message_id, from_account_id, to_account_id, body, created_at, delivered_at, session_id) \
             VALUES ($1, $2, $3, $4, $5, $5, $6) \
             ON CONFLICT (message_id) DO UPDATE SET body = EXCLUDED.body",
        )
        .bind(&message_id)
        .bind(owner_account_id)
        .bind(requester_account_id)
        .bind(body)
        .bind(Utc::now().to_rfc3339())
        .bind(session_id)
        .execute(pool)
        .await?;
        return Ok(message_id);
    }

    let message_id = format!("cloudrunmsg_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_messages (message_id, from_account_id, to_account_id, body, created_at, delivered_at, session_id) \
         VALUES ($1, $2, $3, $4, $5, $5, $6)",
    )
    .bind(&message_id)
    .bind(owner_account_id)
    .bind(requester_account_id)
    .bind(body)
    .bind(&now)
    .bind(session_id)
    .execute(pool)
    .await?;
    query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2, updated_at = $3 WHERE run_id = $1")
        .bind(run_id)
        .bind(&message_id)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(message_id)
}
```

- [ ] **Step 5: Add object upload and export function**

Append to `artifacts.rs`:

```rust
async fn upload_object(s3: &S3Config, object_key: &str, content_type: &str, bytes: Vec<u8>) -> Result<(), ExportArtifactError> {
    let url = presign_upload_url(s3, object_key).map_err(|_| ExportArtifactError {
        code: "server_error",
        message: "Could not sign artifact upload.",
        status: StatusCode::INTERNAL_SERVER_ERROR,
    })?;
    let resp = reqwest::Client::new()
        .put(url.to_string())
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not upload artifact bytes.", status: StatusCode::BAD_GATEWAY })?;
    if !resp.status().is_success() {
        return Err(ExportArtifactError { code: "server_error", message: "Object storage rejected artifact bytes.", status: StatusCode::BAD_GATEWAY });
    }
    Ok(())
}

pub async fn export_run_artifact(
    pool: &PgPool,
    s3: &S3Config,
    run_id: &str,
    runner_id: &str,
    input: ExportArtifactRequest,
) -> Result<ExportedArtifact, ExportArtifactError> {
    let name = input.validated_name()?;
    let sandbox_path = input.validate_path()?;
    let content_type = input.validated_content_type()?;
    let (bytes, sha256_hex) = input.decode_bytes()?;
    let size_bytes = i64::try_from(bytes.len()).map_err(|_| ExportArtifactError { code: "artifact_too_large", message: "Artifact export is too large.", status: StatusCode::PAYLOAD_TOO_LARGE })?;

    let Some((run_id, owner_account_id, requester_account_id, session_id, _status, sandbox_id, _message_id)) =
        run_for_export(pool, run_id, runner_id).await.map_err(|_| ExportArtifactError { code: "server_error", message: "Could not load Cloud agent run.", status: StatusCode::INTERNAL_SERVER_ERROR })?
    else {
        return Err(ExportArtifactError { code: "agent_run_not_found", message: "Cloud agent run was not found for this runner.", status: StatusCode::NOT_FOUND });
    };
    let Some(sandbox_id) = sandbox_id else {
        return Err(ExportArtifactError { code: "agent_run_not_found", message: "Cloud agent run has no sandbox.", status: StatusCode::NOT_FOUND });
    };

    let message_id = ensure_response_message(pool, &run_id, &owner_account_id, &requester_account_id, &session_id, "Shared sandbox artifact.")
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not create run response message.", status: StatusCode::INTERNAL_SERVER_ERROR })?;

    let attachment_id = format!("att_{}", Uuid::new_v4().simple());
    let artifact_id = format!("carartifact_{}", Uuid::new_v4().simple());
    let activity_id = format!("artifact_activity_{}", Uuid::new_v4().simple());
    let object_key = format!("attachments/{owner_account_id}/{attachment_id}");
    let now = Utc::now().to_rfc3339();

    upload_object(s3, &object_key, &content_type, bytes).await?;

    query("INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, size_bytes, content_type, sha256_hex, created_at, finalized_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)")
        .bind(&attachment_id)
        .bind(&owner_account_id)
        .bind(&object_key)
        .bind(size_bytes)
        .bind(&content_type)
        .bind(sha256_hex.as_deref())
        .bind(&now)
        .execute(pool)
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not record exported attachment.", status: StatusCode::INTERNAL_SERVER_ERROR })?;

    query("INSERT INTO cloud_message_attachments (message_id, attachment_id, name, kind, mime_type, size_bytes, position) VALUES ($1, $2, $3, 'file', $4, $5, 0) ON CONFLICT (message_id, attachment_id) DO NOTHING")
        .bind(&message_id)
        .bind(&attachment_id)
        .bind(&name)
        .bind(&content_type)
        .bind(size_bytes)
        .execute(pool)
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not link exported attachment.", status: StatusCode::INTERNAL_SERVER_ERROR })?;

    query("INSERT INTO cloud_agent_run_artifacts (artifact_id, run_id, sandbox_id, attachment_id, message_id, sandbox_path, name, content_type, size_bytes, sha256_hex, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)")
        .bind(&artifact_id)
        .bind(&run_id)
        .bind(&sandbox_id)
        .bind(&attachment_id)
        .bind(&message_id)
        .bind(&sandbox_path)
        .bind(&name)
        .bind(&content_type)
        .bind(size_bytes)
        .bind(sha256_hex.as_deref())
        .bind(&now)
        .execute(pool)
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not record run artifact.", status: StatusCode::INTERNAL_SERVER_ERROR })?;

    query("INSERT INTO cloud_session_artifacts (artifact_activity_id, session_id, artifact_id, name, path, kind, category, summary, created_by_account_id, source_message_id, attachment_id, content_type, size_bytes, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'file', 'artifact', $6, $7, $8, $9, $10, $11, $12, $12) ON CONFLICT (session_id, artifact_id) DO NOTHING")
        .bind(&activity_id)
        .bind(&session_id)
        .bind(&artifact_id)
        .bind(&name)
        .bind(&sandbox_path)
        .bind(format!("Exported from Cloud sandbox path `{sandbox_path}`."))
        .bind(&owner_account_id)
        .bind(&message_id)
        .bind(&attachment_id)
        .bind(&content_type)
        .bind(size_bytes)
        .bind(&now)
        .execute(pool)
        .await
        .map_err(|_| ExportArtifactError { code: "server_error", message: "Could not record session artifact.", status: StatusCode::INTERNAL_SERVER_ERROR })?;

    Ok(ExportedArtifact { artifact_id, attachment_id, run_id, message_id, name, sandbox_path, content_type, size_bytes, sha256_hex, created_at: now })
}
```

- [ ] **Step 6: Export module and wire route**

Modify `bridges/cloud-server/src/cloud_agent_runtime/mod.rs`:

```rust
pub mod artifacts;
pub mod policy;
pub mod provider_auth;
pub mod routes;
pub mod runs;
pub mod sandboxes;
```

Modify imports in `routes.rs`:

```rust
use crate::cloud_agent_runtime::artifacts::{
    export_run_artifact, ExportArtifactEnvelope, ExportArtifactRequest,
};
```

Add runner route:

```rust
.route(
    "/v1/cloud/agent-runs/:run_id/artifacts",
    post(export_runner_artifact),
)
```

Add handler:

```rust
async fn export_runner_artifact(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<ExportArtifactRequest>,
) -> Response {
    if !runner_authorized(&headers) {
        return runner_unauthorized();
    }
    let Some(runner_id) = input.runner_id() else {
        return error_response(
            "invalid_runner_request",
            "runnerId is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some(s3) = state.s3() else {
        return error_response(
            "attachments_unavailable",
            "Object storage is not configured on this server.",
            StatusCode::SERVICE_UNAVAILABLE,
        );
    };
    match export_run_artifact(state.db_pool(), s3, &run_id, &runner_id, input).await {
        Ok(artifact) => (StatusCode::CREATED, Json(ExportArtifactEnvelope { artifact })).into_response(),
        Err(err) => error_response(err.code, err.message, err.status),
    }
}
```

- [ ] **Step 7: Make completion update the real response message**

Modify `complete_run` in `runs.rs`:

```rust
pub async fn complete_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    response_text: &str,
) -> Result<Option<RunnerRunResponse>, sqlx_core::Error> {
    let trimmed = response_text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let existing: Option<(String, String, String, String, Option<String>)> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, status, response_message_id \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner_account_id, requester_account_id, session_id, _status, _message_id)) = existing else {
        return Ok(None);
    };
    let response_message_id = crate::cloud_agent_runtime::artifacts::ensure_response_message(
        pool,
        run_id,
        &owner_account_id,
        &requester_account_id,
        &session_id,
        trimmed,
    )
    .await?;
    let now = Utc::now().to_rfc3339();
    let row: Option<RunnerRunRow> = query_as(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'completed', response_message_id = $3, \
             error_code = NULL, error_message = NULL, updated_at = $4, completed_at = $4 \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running') \
         RETURNING run_id, status, prompt, owner_account_id, requester_account_id, session_id, sandbox_id, response_message_id, error_code, error_message",
    )
    .bind(run_id)
    .bind(runner_id)
    .bind(response_message_id)
    .bind(now)
    .fetch_optional(pool)
    .await?;
    match row {
        Some(row) => runner_response_from_row(pool, row).await.map(Some),
        None => Ok(None),
    }
}
```

- [ ] **Step 8: Run server tests**

Run:

```bash
cargo fmt --all --check
DATABASE_URL=${DATABASE_URL:-postgresql://kordi:kordi@127.0.0.1:15432/kordi_cloud} \
KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY='test-provider-auth-key-that-is-long-enough' \
cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e artifact -- --nocapture --test-threads=1
cargo test -p kordi-cloud-server cloud_agent_runtime
```

Expected: artifact e2e tests pass; existing runtime tests remain passing.

- [ ] **Step 9: Commit server implementation**

```bash
git add bridges/cloud-server/migrations/0021_cloud_agent_run_artifacts.sql \
  bridges/cloud-server/src/cloud_agent_runtime/artifacts.rs \
  bridges/cloud-server/src/cloud_agent_runtime/mod.rs \
  bridges/cloud-server/src/cloud_agent_runtime/routes.rs \
  bridges/cloud-server/src/cloud_agent_runtime/runs.rs \
  bridges/cloud-server/tests/cloud_agent_runtime_e2e.rs
git commit -m "feat: export cloud sandbox artifacts to chat"
```

---

## Task 3: Runner explicit artifact export helper

**Files:**
- Create: `bridges/cloud-agent-runner/src/artifacts.rs`
- Create: `bridges/cloud-agent-runner/tests/cloud_artifact_export.rs`
- Modify: `bridges/cloud-agent-runner/src/client.rs`
- Modify: `bridges/cloud-agent-runner/src/lib.rs`
- Modify: `bridges/cloud-agent-runner/Cargo.toml`

- [ ] **Step 1: Write failing runner tests**

Create `bridges/cloud-agent-runner/tests/cloud_artifact_export.rs`:

```rust
use async_trait::async_trait;
use kordi_cloud_agent_runner::artifacts::export_sandbox_file;
use kordi_cloud_agent_runner::client::{ArtifactExportInput, ArtifactExportResponse, CloudAgentRun, CloudAgentRunClient, RunnerClientError};
use kordi_cloud_agent_runner::sandbox_client::LocalSandboxBackend;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
struct RecordingClient {
    exports: Arc<Mutex<Vec<ArtifactExportInput>>>,
}

#[async_trait]
impl CloudAgentRunClient for RecordingClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> { Ok(None) }
    async fn mark_running(&self, _run_id: &str) -> Result<(), RunnerClientError> { Ok(()) }
    async fn complete_run(&self, _run_id: &str, _response_text: &str) -> Result<(), RunnerClientError> { Ok(()) }
    async fn fail_run(&self, _run_id: &str, _error_code: &str, _message: &str) -> Result<(), RunnerClientError> { Ok(()) }
    async fn export_artifact(&self, run_id: &str, input: ArtifactExportInput) -> Result<ArtifactExportResponse, RunnerClientError> {
        self.exports.lock().unwrap().push(input.clone());
        Ok(ArtifactExportResponse {
            artifact_id: "carartifact_test".to_string(),
            attachment_id: "att_test".to_string(),
            run_id: run_id.to_string(),
            message_id: "cloudrunmsg_test".to_string(),
            name: input.name,
            sandbox_path: input.sandbox_path,
            content_type: input.content_type,
            size_bytes: 6,
            sha256_hex: Some(input.sha256_hex),
            created_at: "2026-05-24T00:00:00Z".to_string(),
        })
    }
}

#[tokio::test]
async fn export_sandbox_file_reads_bytes_and_posts_explicit_export() {
    let root = std::env::temp_dir().join(format!("kordi-artifact-export-{}", uuid::Uuid::new_v4().simple()));
    let sandbox = LocalSandboxBackend::new(root.clone());
    sandbox.write_text("report.md", "report").await.unwrap();
    let client = RecordingClient::default();

    let exported = export_sandbox_file(&client, &sandbox, "car_run", "report.md", "report.md", "text/markdown")
        .await
        .unwrap();

    assert_eq!(exported.attachment_id, "att_test");
    let calls = client.exports.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].sandbox_path, "report.md");
    assert_eq!(calls[0].name, "report.md");
    assert_eq!(calls[0].content_type, "text/markdown");
    assert!(!calls[0].bytes_base64.is_empty());
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn export_sandbox_file_blocks_paths_outside_sandbox_before_http() {
    let root = std::env::temp_dir().join(format!("kordi-artifact-export-block-{}", uuid::Uuid::new_v4().simple()));
    let sandbox = LocalSandboxBackend::new(root.clone());
    let client = RecordingClient::default();

    let result = export_sandbox_file(&client, &sandbox, "car_run", "../secret.md", "secret.md", "text/markdown").await;

    assert!(result.is_err());
    assert!(client.exports.lock().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(root);
}
```

- [ ] **Step 2: Run runner tests and verify red**

Run:

```bash
cargo test -p kordi-cloud-agent-runner --test cloud_artifact_export
```

Expected: fails because `artifacts` module and export client method do not exist.

- [ ] **Step 3: Add runner dependencies**

Modify `bridges/cloud-agent-runner/Cargo.toml` dependencies:

```toml
base64.workspace = true
sha2.workspace = true
```

- [ ] **Step 4: Extend client trait and HTTP client**

Modify `bridges/cloud-agent-runner/src/client.rs`.

Add types:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactExportInput {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    pub name: String,
    #[serde(rename = "sandboxPath")]
    pub sandbox_path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: String,
    #[serde(rename = "bytesBase64")]
    pub bytes_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactExportResponse {
    #[serde(rename = "artifactId")]
    pub artifact_id: String,
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub name: String,
    #[serde(rename = "sandboxPath")]
    pub sandbox_path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct ArtifactExportEnvelope {
    artifact: ArtifactExportResponse,
}
```

Add to `CloudAgentRunClient` trait:

```rust
async fn export_artifact(
    &self,
    run_id: &str,
    input: ArtifactExportInput,
) -> Result<ArtifactExportResponse, RunnerClientError>;
```

Add to `HttpCloudAgentRunClient` implementation:

```rust
async fn export_artifact(
    &self,
    run_id: &str,
    mut input: ArtifactExportInput,
) -> Result<ArtifactExportResponse, RunnerClientError> {
    input.runner_id = self.runner_id.clone();
    let envelope: ArtifactExportEnvelope = self
        .post_json(&format!("/v1/cloud/agent-runs/{run_id}/artifacts"), serde_json::to_value(input).map_err(|err| RunnerClientError::Request(err.to_string()))?)
        .await?;
    Ok(envelope.artifact)
}
```

- [ ] **Step 5: Add explicit export helper**

Create `bridges/cloud-agent-runner/src/artifacts.rs`:

```rust
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::client::{ArtifactExportInput, ArtifactExportResponse, CloudAgentRunClient, RunnerClientError};
use crate::sandbox_client::{LocalSandboxBackend, SandboxClientError};

#[derive(Debug, thiserror::Error)]
pub enum ArtifactExportError {
    #[error(transparent)]
    Sandbox(#[from] SandboxClientError),
    #[error(transparent)]
    Client(#[from] RunnerClientError),
}

pub async fn export_sandbox_file<C: CloudAgentRunClient + Sync>(
    client: &C,
    sandbox: &LocalSandboxBackend,
    run_id: &str,
    sandbox_path: &str,
    name: &str,
    content_type: &str,
) -> Result<ArtifactExportResponse, ArtifactExportError> {
    let path = sandbox.resolve_path(sandbox_path)?;
    let bytes = tokio::fs::read(path).await?;
    let sha256_hex = format!("{:x}", Sha256::digest(&bytes));
    let bytes_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let input = ArtifactExportInput {
        runner_id: String::new(),
        name: name.to_string(),
        sandbox_path: sandbox_path.to_string(),
        content_type: content_type.to_string(),
        sha256_hex,
        bytes_base64,
    };
    Ok(client.export_artifact(run_id, input).await?)
}
```

- [ ] **Step 6: Export module**

Modify `bridges/cloud-agent-runner/src/lib.rs`:

```rust
pub mod artifacts;
pub mod client;
pub mod prompt;
pub mod runtime;
pub mod sandbox_client;
pub mod tool_policy;
pub mod tools;
```

- [ ] **Step 7: Run runner tests**

Run:

```bash
cargo fmt --all --check
cargo test -p kordi-cloud-agent-runner --test cloud_artifact_export
cargo test -p kordi-cloud-agent-runner
```

Expected: runner export tests and existing runner tests pass.

- [ ] **Step 8: Commit runner implementation**

```bash
git add bridges/cloud-agent-runner/Cargo.toml \
  bridges/cloud-agent-runner/src/artifacts.rs \
  bridges/cloud-agent-runner/src/client.rs \
  bridges/cloud-agent-runner/src/lib.rs \
  bridges/cloud-agent-runner/tests/cloud_artifact_export.rs
git commit -m "feat: add cloud runner artifact export helper"
```

---

## Task 4: Full verification, remote e2e, and PR

**Files:**
- No new files unless PR body is saved under `/tmp/issue-504-artifact-export-pr.md`.

- [ ] **Step 1: Run local targeted verification**

Run:

```bash
cargo fmt --all --check
cargo test -p kordi-cloud-agent-runner
cargo test -p kordi-cloud-server cloud_agent_runtime
cargo test -p kordi-cloud-server presence
```

Expected: all pass.

- [ ] **Step 2: Sync/build on takotako**

Run from `/Users/shuyang/kordi/.worktrees/issue-504-cloud-artifact-export`:

```bash
bridges/cloud-server/deploy/sync-and-build.sh
```

Expected: sync completes and remote build succeeds.

- [ ] **Step 3: Run remote Postgres e2e on takotako VM-local port-forward**

Use background job to survive SSH drops:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command "cat > /tmp/run-issue504-e2e.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
cd /home/shu_yang/kordi-cloud-server-deploy
pkill -f 'kubectl -n kordi-cloud port-forward svc/postgres 15432:5432' 2>/dev/null || true
kubectl -n kordi-cloud port-forward svc/postgres 15432:5432 >/tmp/kordi-postgres-issue504-e2e-portforward.log 2>&1 &
PF_PID=$!
cleanup() { kill $PF_PID 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 30); do
  if (echo > /dev/tcp/127.0.0.1/15432) >/dev/null 2>&1; then break; fi
  sleep 1
done
(echo > /dev/tcp/127.0.0.1/15432) >/dev/null 2>&1
KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY='test-provider-auth-key-that-is-long-enough' DATABASE_URL='postgresql://kordi:kordi@127.0.0.1:15432/kordi_cloud' $HOME/.cargo/bin/cargo test -p kordi-cloud-server --test cloud_agent_runtime_e2e -- --nocapture --test-threads=1
EOS
chmod +x /tmp/run-issue504-e2e.sh
nohup /tmp/run-issue504-e2e.sh > /tmp/issue504-cloud-agent-runtime-e2e.log 2>&1 & echo $!"
```

Poll:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command "tail -80 /tmp/issue504-cloud-agent-runtime-e2e.log"
```

Expected: full `cloud_agent_runtime_e2e` passes.

- [ ] **Step 4: Health smoke**

Run:

```bash
gcloud compute ssh shu_yang@takotako --zone us-central1-c --command "kubectl -n kordi-cloud run hc-issue504-final -i --rm --restart=Never --image=curlimages/curl:8.10.1 --quiet -- -sS http://kordi-cloud-server.kordi-cloud.svc.cluster.local:17081/health"
```

Expected:

```json
{"ok":true,"server":"kordi-cloud"}
```

- [ ] **Step 5: Create stacked draft PR**

Create `/tmp/issue-504-artifact-export-pr.md`:

```markdown
## Summary

- adds explicit runner-auth artifact export endpoint for Cloud sandbox fallback runs
- stores exported bytes through server-owned object storage and links them to Cloud chat attachments
- adds runner helper for explicit sandbox file export without auto-sharing private sandbox files

## Testing

- [ ] cargo fmt --all --check
- [ ] cargo test -p kordi-cloud-agent-runner
- [ ] cargo test -p kordi-cloud-server cloud_agent_runtime
- [ ] cargo test -p kordi-cloud-server presence
- [ ] takotako cloud_agent_runtime_e2e
```

Run:

```bash
gh pr create --draft --base feature/issue-502-cloud-tool-policy --head feature/issue-504-cloud-artifact-export --title "feat: export cloud sandbox artifacts to chat" --body-file /tmp/issue-504-artifact-export-pr.md
```

Expected: draft stacked PR is created. Do not merge before user testing.

---

## Final verification checklist

- [ ] Export endpoint requires runner token and rejects user tokens.
- [ ] Export is explicit only; normal sandbox writes do not create Cloud attachment rows.
- [ ] Exported bytes are stored in object storage and retrievable through existing attachment content route.
- [ ] Requester can fetch exported content; unrelated account receives `404`.
- [ ] Bad sandbox paths and sha mismatches are rejected.
- [ ] Completion updates the stable response message used by artifact exports.
- [ ] `cargo test -p kordi-cloud-agent-runner` passes.
- [ ] `cargo test -p kordi-cloud-server cloud_agent_runtime` passes.
- [ ] Remote takotako `cloud_agent_runtime_e2e` passes.
