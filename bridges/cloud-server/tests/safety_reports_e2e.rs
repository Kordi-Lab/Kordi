//! Abuse reports against a real Postgres at `$DATABASE_URL` (skipped when it
//! is not set). Every test uses fresh synthetic accounts.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use kordi_cloud_server::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use kordi_cloud_server::chat_sync::models::SendMessageRequest;
use kordi_cloud_server::chat_sync::store as chat_store;
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::server::{router_with_rate_limiter, ServerState};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use tower::util::ServiceExt;
use uuid::Uuid;

#[path = "safety_reports_e2e/evidence.rs"]
mod evidence;
#[path = "safety_reports_e2e/operators.rs"]
mod operators;

#[derive(Clone)]
struct Account {
    id: String,
    token: String,
}

struct Harness {
    pool: PgPool,
    router: axum::Router,
}

async fn harness() -> Option<Harness> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let pool = init_pool(&url).await.expect("migrate test database");
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        per_ip_window: Duration::from_secs(60),
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
        per_email_global_failure_limit: 50,
    });
    let router = router_with_rate_limiter(
        Arc::new(ServerState::new(pool.clone(), EventBus::noop())),
        limiter,
    );
    Some(Harness { pool, router })
}

impl Harness {
    async fn send(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Value,
    ) -> (StatusCode, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let body = if body.is_null() {
            Body::empty()
        } else {
            Body::from(body.to_string())
        };
        let response = self
            .router
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    async fn signup(&self, label: &str) -> Account {
        let (status, body) = self
            .send(
                "POST",
                "/v1/cloud/auth/signup",
                None,
                json!({
                    "email": format!(
                        "report-{}-{}@example.test",
                        label.to_lowercase().replace(' ', "-"),
                        Uuid::new_v4().simple()
                    ),
                    "password": "correct horse battery",
                    "displayName": label,
                    "avatarSeed": "report_avatar",
                }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Account {
            id: body["account"]["accountId"].as_str().unwrap().to_string(),
            token: body["session"]["token"].as_str().unwrap().to_string(),
        }
    }

    /// `from` sends a contact request; `to` accepts when `accept` is set.
    async fn request_contact(&self, from: &Account, to: &Account, accept: bool) -> String {
        let (status, body) = self
            .send(
                "POST",
                "/v1/cloud/contacts/requests",
                Some(&from.token),
                json!({ "peerAccountId": to.id }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let request_id = body["request"]["requestId"].as_str().unwrap().to_string();
        if accept {
            let (status, body) = self
                .send(
                    "POST",
                    &format!("/v1/cloud/contacts/requests/{request_id}/accept"),
                    Some(&to.token),
                    Value::Null,
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{body}");
        }
        request_id
    }

    async fn direct_chat(&self, left: &Account, right: &Account) -> Uuid {
        let mut ids = [left.id.as_str(), right.id.as_str()];
        ids.sort_unstable();
        let session = format!("session:direct-person:{}:{}", ids[0], ids[1]);
        chat_store::conversation_id_for_session(&self.pool, &left.id, &session)
            .await
            .unwrap()
            .expect("the accepted request opened a direct chat")
    }

    async fn message(&self, sender: &Account, conversation: Uuid, text: &str) -> Uuid {
        self.message_with(
            sender,
            conversation,
            json!({"schema": 1, "blocks": [{"type": "text", "text": text}]}),
            Vec::new(),
        )
        .await
    }

    async fn message_with(
        &self,
        sender: &Account,
        conversation: Uuid,
        content: Value,
        attachment_ids: Vec<String>,
    ) -> Uuid {
        chat_store::send_message(
            &self.pool,
            &sender.id,
            conversation,
            SendMessageRequest {
                client_message_id: Uuid::now_v7(),
                kind: "text".to_string(),
                content,
                reply_to_message_id: None,
                attachment_ids,
            },
        )
        .await
        .expect("send test message")
        .value
        .id
    }

    async fn report(&self, reporter: &Account, body: Value) -> (StatusCode, Value) {
        self.send("POST", "/v1/cloud/reports", Some(&reporter.token), body)
            .await
    }
}

fn account_report(reported: &Account) -> Value {
    json!({ "clientReportId": Uuid::new_v4(), "reason": "spam", "reportedAccountId": reported.id })
}

#[tokio::test]
async fn account_reports_return_a_receipt_and_replays_are_idempotent() {
    let Some(h) = harness().await else { return };
    let reporter = h.signup("Reporter").await;
    let reported = h.signup("Reported").await;
    let mut body = account_report(&reported);
    body["details"] = json!("  Sends the same link to everyone.  ");
    let (status, created) = h.report(&reporter, body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let receipt = &created["report"];
    let report_id = receipt["reportId"].as_str().unwrap();
    assert!(report_id.starts_with("rpt_") && report_id.len() == 36);
    assert_eq!(
        receipt["reference"],
        format!("R-{}", report_id[4..12].to_uppercase())
    );
    assert_eq!(receipt["status"], "received");
    assert_eq!(receipt["reason"], "spam");
    assert_eq!(receipt["targetKind"], "account");
    assert_eq!(receipt["evidenceMessageCount"], 0);
    assert_eq!(receipt["reportedDisplayName"], "Reported");
    assert!(receipt["closedAt"].is_null());
    assert!(receipt.get("evidence").is_none());

    let (status, replay) = h.report(&reporter, body.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay, created);
    body["reason"] = json!("scam");
    let (status, conflict) = h.report(&reporter, body).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["errorCode"], "report_conflict");

    // The audit event names the report only.
    let (metadata,): (String,) = query_as(
        "SELECT metadata_json FROM cloud_audit_events \
         WHERE account_id = $1 AND event_type = 'safety.report.created'",
    )
    .bind(&reporter.id)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    let metadata: Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(
        metadata,
        json!({ "report_id": report_id, "reason": "spam", "target_kind": "account" })
    );

    let (status, body) = h.report(&reporter, account_report(&reporter)).await;
    assert_eq!(
        (status, body["errorCode"].clone()),
        (StatusCode::BAD_REQUEST, json!("self_report"))
    );
    let mut missing = account_report(&reported);
    missing["reportedAccountId"] = json!(format!("acct_missing_{}", Uuid::new_v4().simple()));
    let (status, body) = h.report(&reporter, missing).await;
    assert_eq!(
        (status, body["errorCode"].clone()),
        (StatusCode::NOT_FOUND, json!("account_missing"))
    );
    let mut unknown_reason = account_report(&reported);
    unknown_reason["reason"] = json!("annoying");
    let (status, body) = h.report(&reporter, unknown_reason).await;
    assert_eq!(
        (status, body["errorCode"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_report"))
    );
    let (status, body) = h
        .report(
            &reporter,
            json!({ "clientReportId": "not-a-uuid", "reason": "spam" }),
        )
        .await;
    assert_eq!(
        (status, body["errorCode"].clone()),
        (StatusCode::BAD_REQUEST, json!("invalid_report"))
    );
    let (status, _) = h
        .send("POST", "/v1/cloud/reports", None, account_report(&reported))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_daily_budget_stops_new_reports_but_not_replays() {
    let Some(h) = harness().await else { return };
    let reporter = h.signup("Busy reporter").await;
    let reported = h.signup("Reported").await;
    let first = account_report(&reported);
    let (status, receipt) = h.report(&reporter, first.clone()).await;
    assert_eq!(status, StatusCode::CREATED);
    for _ in 1..20 {
        let (status, body) = h.report(&reporter, account_report(&reported)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let (status, limited) = h.report(&reporter, account_report(&reported)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited["errorCode"], "rate_limited");
    let (status, replay) = h.report(&reporter, first).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replay, receipt);
}

#[tokio::test]
async fn people_list_only_their_own_reports_without_evidence() {
    let Some(h) = harness().await else { return };
    let reporter = h.signup("Lister").await;
    let reported = h.signup("Listed").await;
    let mut ids = Vec::new();
    for _ in 0..2 {
        let (_, body) = h.report(&reporter, account_report(&reported)).await;
        ids.push(body["report"]["reportId"].clone());
    }
    let (status, list) = h
        .send(
            "GET",
            "/v1/cloud/reports",
            Some(&reporter.token),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let reports = list["reports"].as_array().unwrap();
    assert_eq!(reports.len(), 2);
    let listed = reports
        .iter()
        .map(|r| r["reportId"].clone())
        .collect::<Vec<_>>();
    ids.reverse();
    assert_eq!(listed, ids, "newest first");
    assert!(reports.iter().all(|report| report.get("evidence").is_none()
        && report.get("resolution").is_none()
        && report.get("details").is_none()));
    let (_, theirs) = h
        .send(
            "GET",
            "/v1/cloud/reports",
            Some(&reported.token),
            Value::Null,
        )
        .await;
    assert_eq!(theirs["reports"], json!([]));
}

fn photo_content(attachment_id: &str) -> Value {
    let attachments = json!([{ "attachmentId": attachment_id, "name": "Photo.png", "kind": "image",
                               "mimeType": "image/png", "sizeBytes": 120 }]);
    let encoded = format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(
            json!({"schemaVersion": 1, "kind": "message", "text": "look", "attachments": attachments})
                .to_string()
        )
    );
    json!({"schema": 1, "blocks": [{"type": "text", "text": encoded}], "legacy_attachments": attachments})
}

async fn photo(pool: &PgPool, owner: &Account) -> String {
    let id = format!("att-{}", Uuid::new_v4());
    query("INSERT INTO cloud_attachments(attachment_id, owner_account_id, object_key, created_at, finalized_at, content_type, detected_content_type, size_bytes, sha256_hex) VALUES ($1, $2, $1, $3, $3, 'image/png', 'image/png', 120, $4)")
        .bind(&id)
        .bind(&owner.id)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind("ab".repeat(32))
        .execute(pool)
        .await
        .unwrap();
    id
}
