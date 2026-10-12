//! Fixtures for the shared document database tests. They run against `$DATABASE_URL`;
//! outside CI they return early when it is unset, and in CI a missing
//! `DATABASE_URL` fails them unless `KORDI_CONNECTOR_DB_TESTS=skip`, the
//! same rule as the connector tests. Object storage is a local stub that
//! serves one Markdown document.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use chrono::Utc;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use crate::attachments::S3Config;
use crate::events::EventBus;
use crate::server::ServerState;

pub(super) const DOCUMENT: &str = "# Field notes\n\nFirst paragraph.\n\nSecond paragraph.\n";

pub(super) async fn pool() -> Option<PgPool> {
    let skip_requested = std::env::var("KORDI_CONNECTOR_DB_TESTS").as_deref() == Ok("skip");
    let url = match std::env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ if skip_requested => return None,
        _ if std::env::var_os("CI").is_some() => panic!(
            "document share database tests need DATABASE_URL in CI. Run them through \
             scripts/test-cloud-migrations.sh, or set KORDI_CONNECTOR_DB_TESTS=skip \
             in a job that has no database."
        ),
        _ => return None,
    };
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

/// A stand-in for object storage that answers every GET with [`DOCUMENT`].
pub(super) async fn storage_stub() -> String {
    let app = Router::new().fallback(|| async { DOCUMENT });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    base
}

pub(super) async fn app(pool: &PgPool) -> Router {
    let s3 = S3Config {
        endpoint: url::Url::parse(&storage_stub().await).unwrap(),
        region: "us-east-1".into(),
        bucket: "documents".into(),
        access_key: "test-access".into(),
        secret_key: "test-secret".into(),
    };
    crate::server::router(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_s3(s3),
    ))
}

/// Creates an account with a device and returns (account_id, session token).
pub(super) async fn signed_in_account(pool: &PgPool, label: &str) -> (String, String) {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_doc_{label}_{suffix}");
    let device_id = format!("dev_doc_{label}_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $3, $4, $4, 'generated', 'lorelei', $1, 'fixture', 1, $4)",
    )
    .bind(&account_id)
    .bind(label)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
         created_at, last_seen_at) VALUES ($1, $2, 'Document device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    let session = crate::auth::session::issue_session(pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    (account_id, session.plaintext_token)
}

pub(super) struct Fixture {
    pub(super) app: Router,
    pub(super) pool: PgPool,
    pub(super) attachment_id: String,
    pub(super) owner: String,
    pub(super) owner_token: String,
    pub(super) member: String,
    pub(super) member_token: String,
    pub(super) outsider: String,
    pub(super) outsider_token: String,
}

/// An owner who sent a finalized Markdown attachment into a group with a
/// member, and an outsider who is in no conversation.
pub(super) async fn fixture() -> Option<Fixture> {
    let pool = pool().await?;
    let (owner, owner_token) = signed_in_account(&pool, "owner").await;
    let (member, member_token) = signed_in_account(&pool, "member").await;
    let (outsider, outsider_token) = signed_in_account(&pool, "outsider").await;
    let attachment_id = format!("att_doc_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, \
         content_type, size_bytes, created_at, finalized_at) \
         VALUES ($1, $2, $3, 'text/markdown', $4, $5, $5)",
    )
    .bind(&attachment_id)
    .bind(&owner)
    .bind(format!("attachments/{owner}/{attachment_id}"))
    .bind(DOCUMENT.len() as i64)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();
    let conversation = Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, shared_title, \
         created_by_account_id, client_operation_id, creation_fingerprint, legacy_session_id, \
         next_message_sequence, latest_message_sequence) \
         VALUES ($1, 'group', 'Research', $2, $3, 'fixture', $4, 2, 1)",
    )
    .bind(conversation)
    .bind(&owner)
    .bind(Uuid::new_v4())
    .bind(format!("group-doc-{}", Uuid::new_v4().simple()))
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_conversation_members (conversation_id, account_id, role) \
         VALUES ($1, $2, 'owner'), ($1, $3, 'member')",
    )
    .bind(conversation)
    .bind(&owner)
    .bind(&member)
    .execute(&pool)
    .await
    .unwrap();
    let message = Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_messages (message_id, conversation_id, conversation_sequence, \
         sender_account_id, client_message_id, request_fingerprint, content) \
         VALUES ($1, $2, 1, $3, $4, 'fixture', $5)",
    )
    .bind(message)
    .bind(conversation)
    .bind(&owner)
    .bind(Uuid::new_v4())
    .bind(
        json!({"schema": 1, "blocks": [{"type": "text", "text": "Notes"}],
        "legacy_attachments": [{"attachmentId": attachment_id, "name": "field-notes.md"}]}),
    )
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_message_attachments (message_id, attachment_id, position) \
         VALUES ($1, $2, 0)",
    )
    .bind(message)
    .bind(&attachment_id)
    .execute(&pool)
    .await
    .unwrap();
    Some(Fixture {
        app: app(&pool).await,
        pool,
        attachment_id,
        owner,
        owner_token,
        member,
        member_token,
        outsider,
        outsider_token,
    })
}

pub(super) async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// GET a public page; returns status, CSP header, and body text.
pub(super) async fn page(app: &Router, uri: &str) -> (StatusCode, String, String) {
    let request = Request::builder().uri(uri).body(Body::empty()).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let csp = response
        .headers()
        .get("content-security-policy")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, csp, String::from_utf8_lossy(&bytes).into_owned())
}

pub(super) fn token_of(share: &Value) -> String {
    share["shareUrl"]
        .as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string()
}

pub(super) async fn create_share(f: &Fixture) -> Value {
    let uri = format!("/v1/cloud/documents/{}/shares", f.attachment_id);
    let (status, share) = send(&f.app, "POST", &uri, Some(&f.owner_token), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{share}");
    share
}

pub(super) const READER_KEY: &str = "reader-key-0123456789";
