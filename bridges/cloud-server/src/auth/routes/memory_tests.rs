//! Account memory and replay state routes against a real Postgres at
//! `$DATABASE_URL`. Skipped when `DATABASE_URL` is unset.

use super::*;
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::util::ServiceExt;

mod dedup;
mod isolation;
mod runs;

const RUNNER_TOKEN: &str = "memory-tests-runner-token";

struct Fixture {
    pool: PgPool,
    router: Router,
    account_id: String,
    token: String,
}

async fn fixture() -> Option<Fixture> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let pool = crate::pg::init_pool(&url).await.expect("init test pool");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_memory_{suffix}");
    let device_id = format!("dev_memory_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Memory', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, 'Memory device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    let session = crate::auth::session::issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let state = Arc::new(ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let router = routes(state.clone()).merge(crate::cloud_agent_runtime::routes::routes(state));
    Some(Fixture {
        pool,
        router,
        account_id,
        token: session.plaintext_token,
    })
}

impl Fixture {
    async fn send(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        self.send_with_auth(method, uri, body, &format!("Bearer {}", self.token))
            .await
    }

    async fn send_with_auth(
        &self,
        method: &str,
        uri: &str,
        body: Option<Value>,
        authorization: &str,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", authorization);
        let body = match body {
            Some(body) => {
                request = request.header("content-type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .router
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn audit_count(&self, event_type: &str) -> i64 {
        let (count,): (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_audit_events WHERE account_id = $1 AND event_type = $2",
        )
        .bind(&self.account_id)
        .bind(event_type)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        count
    }

    async fn audit_metadata(&self, event_type: &str) -> Vec<Value> {
        let rows: Vec<(String,)> = query_as(
            "SELECT metadata_json FROM cloud_audit_events WHERE account_id = $1 AND event_type = $2 \
             ORDER BY created_at",
        )
        .bind(&self.account_id)
        .bind(event_type)
        .fetch_all(&self.pool)
        .await
        .unwrap();
        rows.into_iter()
            .map(|(raw,)| serde_json::from_str(&raw).unwrap())
            .collect()
    }

    /// Inserts a cloud run leased by `runner_id` and owned by this account.
    async fn leased_run(&self, runner_id: &str) -> String {
        let run_id = format!("run_memory_{}", uuid::Uuid::new_v4().simple());
        let now = Utc::now();
        query(
            "INSERT INTO cloud_agent_fallback_runs \
             (run_id, idempotency_key, request_message_id, session_id, owner_account_id, \
              requester_account_id, status, prompt, claimed_by, lease_expires_at, created_at, updated_at) \
             VALUES ($1, $1, $1, 'memory-test-session', $2, $2, 'leased', 'hello', $3, $4, $5, $5)",
        )
        .bind(&run_id)
        .bind(&self.account_id)
        .bind(runner_id)
        .bind((now + ChronoDuration::minutes(10)).to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await
        .unwrap();
        run_id
    }
}

fn memory_body(text: &str) -> Value {
    json!({
        "scope": "conversation",
        "scopeId": "session-1",
        "scopeLabel": "Launch planning",
        "source": "user_correction",
        "text": text,
    })
}

#[tokio::test]
async fn memory_list_starts_empty_with_default_settings() {
    let Some(fx) = fixture().await else { return };
    let (status, body) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "memories": [], "settings": { "memoryEnabled": true, "excludeSensitive": true } })
    );
    let (status, body) = fx.send("GET", "/v1/cloud/memory/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "memoryEnabled": true, "excludeSensitive": true })
    );
}

#[tokio::test]
async fn memory_save_edit_delete_and_forget_all() {
    let Some(fx) = fixture().await else { return };
    let (status, body) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body("  Prefer   short status updates ")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let memory = &body["memory"];
    let memory_id = memory["memoryId"].as_str().unwrap().to_string();
    assert!(memory_id.starts_with("mem_"));
    assert_eq!(memory["text"], "Prefer short status updates");
    assert_eq!(memory["scope"], "conversation");
    assert_eq!(memory["scopeId"], "session-1");
    assert_eq!(memory["scopeLabel"], "Launch planning");
    assert_eq!(memory["source"], "user_correction");
    assert!(chrono::DateTime::parse_from_rfc3339(memory["createdAt"].as_str().unwrap()).is_ok());
    assert!(chrono::DateTime::parse_from_rfc3339(memory["updatedAt"].as_str().unwrap()).is_ok());

    let (status, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["memories"].as_array().unwrap().len(), 1);
    assert_eq!(list["memories"][0], *memory);

    let (status, edited) = fx
        .send(
            "PATCH",
            &format!("/v1/cloud/memory/{memory_id}"),
            Some(json!({ "text": "Prefer bullet status updates" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["memory"]["text"], "Prefer bullet status updates");
    assert_eq!(edited["memory"]["memoryId"], memory_id.as_str());

    let (status, missing) = fx
        .send(
            "PATCH",
            "/v1/cloud/memory/mem_missing",
            Some(json!({ "text": "Anything" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(missing["errorCode"], "memory_not_found");

    let (status, _) = fx
        .send("DELETE", &format!("/v1/cloud/memory/{memory_id}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = fx
        .send("DELETE", &format!("/v1/cloud/memory/{memory_id}"), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "already archived");
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"], json!([]));

    for text in ["Use the staging bucket", "Ship on Fridays"] {
        let (status, _) = fx
            .send("POST", "/v1/cloud/memory", Some(memory_body(text)))
            .await;
        assert_eq!(status, StatusCode::CREATED);
    }
    let (status, forgotten) = fx.send("DELETE", "/v1/cloud/memory", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(forgotten, json!({ "archived": 2, "clearedRuns": 0 }));
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"], json!([]));

    // One audit row per write.
    assert_eq!(fx.audit_count("memory_saved").await, 3);
    assert_eq!(fx.audit_count("memory_updated").await, 1);
    assert_eq!(fx.audit_count("memory_deleted").await, 1);
    assert_eq!(fx.audit_count("memory_forget_all").await, 1);
    assert_eq!(
        fx.audit_metadata("memory_forget_all").await,
        vec![json!({ "archived": 2 })]
    );
    assert_eq!(
        fx.audit_metadata("memory_saved").await[0],
        json!({ "memoryId": memory_id, "scope": "conversation", "source": "user_correction" })
    );
}

#[tokio::test]
async fn memory_client_id_retry_returns_the_same_row() {
    let Some(fx) = fixture().await else { return };
    let client_id = format!("client_{}", uuid::Uuid::new_v4().simple());
    let mut body = memory_body("Keep replies under five lines");
    body["clientMemoryId"] = json!(client_id);
    let (status, first) = fx
        .send("POST", "/v1/cloud/memory", Some(body.clone()))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(first["memory"]["memoryId"], client_id.as_str());
    let (status, retry) = fx.send("POST", "/v1/cloud/memory", Some(body)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retry, first);
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(list["memories"].as_array().unwrap().len(), 1);
    assert_eq!(fx.audit_count("memory_saved").await, 1);

    let mut invalid = memory_body("Anything");
    invalid["clientMemoryId"] = json!("has spaces");
    let (status, error) = fx.send("POST", "/v1/cloud/memory", Some(invalid)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["errorCode"], "invalid_client_memory_id");
}

#[tokio::test]
async fn memory_requests_are_validated() {
    let Some(fx) = fixture().await else { return };
    let mut bad_scope = memory_body("Anything");
    bad_scope["scope"] = json!("workspace");
    let (status, error) = fx.send("POST", "/v1/cloud/memory", Some(bad_scope)).await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_scope"))
    );
    let mut bad_source = memory_body("Anything");
    bad_source["source"] = json!("guess");
    let (status, error) = fx.send("POST", "/v1/cloud/memory", Some(bad_source)).await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_source"))
    );
    let mut bad_scope_id = memory_body("Anything");
    bad_scope_id["scopeId"] = json!(" ");
    let (status, error) = fx
        .send("POST", "/v1/cloud/memory", Some(bad_scope_id))
        .await;
    assert_eq!(
        (status, error["errorCode"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_scope_id"))
    );
    let (status, error) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body(&"a".repeat(501))),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["message"], "Memories are 500 characters or fewer.");
}

#[tokio::test]
async fn memory_settings_round_trip_and_guard_behaviour() {
    let Some(fx) = fixture().await else { return };
    let sensitive = "Remember my password is hunter2";
    let (status, error) = fx
        .send("POST", "/v1/cloud/memory", Some(memory_body(sensitive)))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["errorCode"], "memory_rejected");
    assert_eq!(
        error["message"],
        "This memory looks like it records credentials. Save a memory about the task instead."
    );

    let (status, settings) = fx
        .send(
            "PUT",
            "/v1/cloud/memory/settings",
            Some(json!({ "excludeSensitive": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        settings,
        json!({ "memoryEnabled": true, "excludeSensitive": false })
    );
    let (status, saved) = fx
        .send("POST", "/v1/cloud/memory", Some(memory_body(sensitive)))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let saved_id = saved["memory"]["memoryId"].as_str().unwrap().to_string();

    // Turning the sensitive guard back on also guards edits.
    fx.send(
        "PUT",
        "/v1/cloud/memory/settings",
        Some(json!({ "excludeSensitive": true })),
    )
    .await;
    let (status, error) = fx
        .send(
            "PATCH",
            &format!("/v1/cloud/memory/{saved_id}"),
            Some(json!({ "text": "Priya was diagnosed with asthma" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error["errorCode"], "memory_rejected");

    let (status, settings) = fx
        .send(
            "PUT",
            "/v1/cloud/memory/settings",
            Some(json!({ "memoryEnabled": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        settings,
        json!({ "memoryEnabled": false, "excludeSensitive": true })
    );
    let (_, settings) = fx.send("GET", "/v1/cloud/memory/settings", None).await;
    assert_eq!(
        settings,
        json!({ "memoryEnabled": false, "excludeSensitive": true })
    );
    let (status, error) = fx
        .send(
            "POST",
            "/v1/cloud/memory",
            Some(memory_body("Use the staging bucket")),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["errorCode"], "memory_disabled");
    assert_eq!(error["message"], "Memory is off for this account.");
    let (_, list) = fx.send("GET", "/v1/cloud/memory", None).await;
    assert_eq!(
        list["memories"].as_array().unwrap().len(),
        1,
        "off keeps memories stored"
    );
    assert_eq!(list["settings"]["memoryEnabled"], false);

    assert_eq!(fx.audit_count("memory_settings_updated").await, 3);
    assert_eq!(
        fx.audit_metadata("memory_settings_updated").await[2],
        json!({ "memoryEnabled": false, "excludeSensitive": true })
    );
    assert_eq!(fx.audit_count("memory_saved").await, 1);
    assert_eq!(fx.audit_count("memory_updated").await, 0);
}

#[test]
fn capabilities_report_memory_version() {
    let value = serde_json::to_value(AuthCapabilitiesResponse {
        password: true,
        oauth_providers: Vec::new(),
        connectors_version: None,
        memory_version: 1,
    })
    .unwrap();
    assert_eq!(value["memoryVersion"], 1);
}
