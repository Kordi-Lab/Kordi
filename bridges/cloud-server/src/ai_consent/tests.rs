//! AI consent against a task-owned disposable PostgreSQL database at
//! `$DATABASE_URL`. Run with `--ignored`. Every account is synthetic.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tower::ServiceExt;

use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use crate::server::ServerState;

struct Harness {
    app: Router,
    pool: PgPool,
}

async fn harness() -> Harness {
    let url = std::env::var("DATABASE_URL").expect("a disposable database is required");
    let pool = crate::pg::init_pool(&url).await.unwrap();
    let state = Arc::new(ServerState::new(
        pool.clone(),
        crate::events::EventBus::noop(),
    ));
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    let app = crate::server::router_with_rate_limiter(state, limiter);
    Harness { app, pool }
}

struct Account {
    id: String,
    token: String,
}

impl Harness {
    async fn account(&self, consent: &str) -> Account {
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let id = format!("acct_consent_{suffix}");
        let device_id = format!("dev_consent_{suffix}");
        let now = Utc::now().to_rfc3339();
        query(
            "INSERT INTO cloud_accounts \
             (account_id, display_name, created_at, updated_at, avatar_source, avatar_style, \
              avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at, \
              ai_consent_status) \
             VALUES ($1, 'Consent tester', $2, $2, 'generated', 'lorelei', $1, 'fixture', 1, $2, $3)",
        )
        .bind(&id)
        .bind(&now)
        .bind(consent)
        .execute(&self.pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_devices \
             (device_id, account_id, device_name, device_public_key, device_key_algorithm, \
              device_platform, authorization_state, review_started_at, confirmed_at, \
              created_at, last_seen_at) \
             VALUES ($1, $2, 'Mac', $3, 'p256', 'macos', 'confirmed', $4, $4, $4, $4)",
        )
        .bind(&device_id)
        .bind(&id)
        .bind(format!("p256:{suffix}"))
        .bind(&now)
        .execute(&self.pool)
        .await
        .unwrap();
        let issued = crate::auth::session::issue_session(&self.pool, &id, &device_id, 30)
            .await
            .unwrap();
        Account {
            id,
            token: issued.plaintext_token,
        }
    }

    async fn send(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {token}"));
        let body = match body {
            Some(body) => {
                request = request.header("Content-Type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = self
            .app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

fn claim(owner: &str, requester: &str) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    json!({
        "requestMessageId": id,
        "sessionId": format!("session-{id}"),
        "ownerAccountId": owner,
        "requesterAccountId": requester,
        "prompt": "Summarize the plan.",
        "idempotencyKey": id,
        "claimId": uuid::Uuid::new_v4(),
    })
}

fn scheduled_task() -> Value {
    json!({"title": "Check", "prompt": "Check the plan.",
        "schedule": {"kind": "daily", "time": "09:00", "timezone": "UTC"},
        "targetRuntime": "localRequired"})
}

/// Every AI entry point the account can reach directly.
fn entry_points(account: &Account) -> Vec<(&'static str, String, Option<Value>)> {
    vec![
        (
            "POST",
            "/v1/cloud/agent-runs/claim".to_string(),
            Some(claim(&account.id, &account.id)),
        ),
        (
            "POST",
            "/v1/cloud/agent-runs/desktop/claim".to_string(),
            Some(claim(&account.id, &account.id)),
        ),
        (
            "POST",
            "/v1/cloud/agent-runs/desktop/tasks".to_string(),
            Some(json!({"kind": "memory_import", "claimId": uuid::Uuid::new_v4()})),
        ),
        (
            "POST",
            "/v1/cloud/scheduled-tasks".to_string(),
            Some(scheduled_task()),
        ),
        (
            "POST",
            "/v1/cloud/scheduled-tasks/st_missing/run-now".to_string(),
            None,
        ),
        ("POST", "/v1/cloud/digest/refresh".to_string(), None),
        (
            "POST",
            "/v1/cloud/common-ground/card/build".to_string(),
            Some(json!({})),
        ),
        (
            "PUT",
            format!("/v1/cloud/agents/cloud-agent:{}/proactive", account.id),
            Some(json!({"enabled": true})),
        ),
    ]
}

fn error_code(body: &Value) -> &str {
    body["errorCode"].as_str().unwrap_or_default()
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn declining_blocks_every_ai_entry_point() {
    let harness = harness().await;
    let declined = harness.account("declined").await;
    for (method, uri, body) in entry_points(&declined) {
        let (status, body) = harness.send(method, &uri, &declined.token, body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        assert_eq!(error_code(&body), "ai_consent_required", "{method} {uri}");
    }
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn unset_and_allowed_accounts_pass_the_gate() {
    let harness = harness().await;
    for consent in ["unset", "allowed"] {
        let account = harness.account(consent).await;
        for (method, uri, body) in entry_points(&account) {
            let (status, body) = harness.send(method, &uri, &account.token, body).await;
            assert_ne!(
                error_code(&body),
                "ai_consent_required",
                "{consent} {method} {uri}: {status} {body}"
            );
        }
    }
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn another_persons_agent_runs_only_when_its_owner_allowed_ai() {
    let harness = harness().await;
    let requester = harness.account("unset").await;
    for consent in ["declined", "unset"] {
        let owner = harness.account(consent).await;
        let (status, body) = harness
            .send(
                "POST",
                "/v1/cloud/agent-runs/claim",
                &requester.token,
                Some(claim(&owner.id, &requester.id)),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{consent}: {body}");
        assert_eq!(error_code(&body), "agent_owner_ai_consent_required");
    }
    let owner = harness.account("allowed").await;
    let (status, body) = harness
        .send(
            "POST",
            "/v1/cloud/agent-runs/claim",
            &requester.token,
            Some(claim(&owner.id, &requester.id)),
        )
        .await;
    assert!(!error_code(&body).contains("ai_consent"), "{status} {body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn the_decision_is_stored_and_reported() {
    let harness = harness().await;
    let account = harness.account("unset").await;
    let uri = "/v1/cloud/account/ai-consent";
    let (status, body) = harness.send("GET", uri, &account.token, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"status": "unset", "decidedAt": null}));
    let (_, me) = harness
        .send("GET", "/v1/cloud/auth/me", &account.token, None)
        .await;
    assert_eq!(me["aiConsent"]["status"], "unset", "{me}");

    let (status, body) = harness
        .send("PUT", uri, &account.token, Some(json!({"status": "maybe"})))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(error_code(&body), "invalid_ai_consent");

    let (status, body) = harness
        .send(
            "PUT",
            uri,
            &account.token,
            Some(json!({"status": "declined"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "declined");
    let decided_at = body["decidedAt"].clone();
    assert!(decided_at.is_string(), "{body}");
    let (status, body) = harness
        .send("POST", "/v1/cloud/digest/refresh", &account.token, None)
        .await;
    assert_eq!(
        (status, error_code(&body)),
        (StatusCode::FORBIDDEN, "ai_consent_required")
    );
    let (_, me) = harness
        .send("GET", "/v1/cloud/auth/me", &account.token, None)
        .await;
    assert_eq!(me["aiConsent"]["status"], "declined", "{me}");
    assert_eq!(me["aiConsent"]["decidedAt"], decided_at);

    let (status, body) = harness
        .send(
            "PUT",
            uri,
            &account.token,
            Some(json!({"status": "allowed"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "allowed");
    let (status, body) = harness
        .send("POST", "/v1/cloud/digest/refresh", &account.token, None)
        .await;
    assert_ne!(error_code(&body), "ai_consent_required", "{status} {body}");
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn due_scheduled_tasks_of_a_declined_owner_wait() {
    let harness = harness().await;
    let account = harness.account("allowed").await;
    let (status, body) = harness
        .send(
            "POST",
            "/v1/cloud/scheduled-tasks",
            &account.token,
            Some(scheduled_task()),
        )
        .await;
    assert!(status.is_success(), "{status} {body}");
    let task_id = body["task"]["taskId"].as_str().unwrap().to_string();
    let due = (Utc::now() - Duration::minutes(5)).to_rfc3339();
    query("UPDATE scheduled_tool_tasks SET next_run_at = $2 WHERE task_id = $1")
        .bind(&task_id)
        .bind(&due)
        .execute(&harness.pool)
        .await
        .unwrap();
    let set_consent = |status: &'static str| {
        query("UPDATE cloud_accounts SET ai_consent_status = $2 WHERE account_id = $1")
            .bind(account.id.clone())
            .bind(status)
    };
    let claim_due = || {
        crate::scheduled_tasks::store::claim_due_scheduled_task_runs(&harness.pool, Utc::now(), 50)
    };
    // Firing is background work: an undecided owner waits too.
    for consent in ["declined", "unset"] {
        set_consent(consent).execute(&harness.pool).await.unwrap();
        let claimed = claim_due().await.unwrap();
        assert!(
            claimed.iter().all(|run| run.task_id != task_id),
            "{consent}"
        );
    }

    set_consent("allowed").execute(&harness.pool).await.unwrap();
    let claimed = claim_due().await.unwrap();
    assert!(claimed.iter().any(|run| run.task_id == task_id));
}

#[tokio::test]
#[ignore = "Requires a task-owned disposable PostgreSQL database"]
async fn declining_ends_the_accounts_runs() {
    let harness = harness().await;
    let account = harness.account("allowed").await;
    let other = harness.account("allowed").await;
    let now = Utc::now().to_rfc3339();
    let lease = (Utc::now() + Duration::minutes(2)).to_rfc3339();
    let run = |label: &str| format!("car_consent_{label}_{}", uuid::Uuid::new_v4().simple());
    let (queued, leased, requested, others) = (
        run("queued"),
        run("leased"),
        run("requested"),
        run("others"),
    );
    for (run_id, owner, requester, status) in [
        (&queued, &account.id, &account.id, "queued"),
        (&leased, &account.id, &account.id, "leased"),
        (&requested, &other.id, &account.id, "queued"),
        (&others, &other.id, &other.id, "queued"),
    ] {
        query(
            "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
             session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
             updated_at, lease_expires_at) \
             VALUES ($1, $1, $1, $1, $2, $3, $4, 'Hi', $5, $5, $6)",
        )
        .bind(run_id)
        .bind(owner)
        .bind(requester)
        .bind(status)
        .bind(&now)
        .bind((status == "leased").then(|| lease.clone()))
        .execute(&harness.pool)
        .await
        .unwrap();
    }
    let (status, body) = harness
        .send(
            "PUT",
            "/v1/cloud/account/ai-consent",
            &account.token,
            Some(json!({"status": "declined"})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let state = |run_id: String| {
        let pool = harness.pool.clone();
        async move {
            let row: (String, bool) = sqlx_core::query_as::query_as(
                "SELECT status, cancel_requested_at IS NOT NULL \
                 FROM cloud_agent_fallback_runs WHERE run_id = $1",
            )
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            row
        }
    };
    assert_eq!(state(queued).await, ("cancelled".into(), true));
    assert_eq!(state(requested).await, ("cancelled".into(), true));
    assert_eq!(state(leased).await, ("leased".into(), true));
    assert_eq!(state(others).await, ("queued".into(), false));
}
