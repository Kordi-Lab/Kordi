use serde_json::json;
use uuid::Uuid;

use super::{
    require_cursor_codec, validate_message_request, ChatSyncRuntime, MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_MESSAGE_CONTENT_BYTES,
};
use crate::chat_sync::models::SendMessageRequest;

#[test]
fn signed_cursor_configuration_is_required() {
    let runtime = ChatSyncRuntime { cursor_codec: None };
    assert!(require_cursor_codec(&runtime).is_err());
}

#[test]
fn request_limits_are_bounded() {
    assert_eq!(MAX_MESSAGE_CONTENT_BYTES, 256 * 1024);
    assert_eq!(MAX_ATTACHMENTS_PER_MESSAGE, 32);
}

#[test]
fn durable_message_content_requires_schema_and_blocks() {
    let request = |content| SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content,
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };

    assert!(validate_message_request(&request(json!({
        "schema": 1,
        "blocks": [{ "type": "text", "text": "hello" }]
    })))
    .is_ok());
    assert!(validate_message_request(&request(json!({ "blocks": [] }))).is_err());
    assert!(validate_message_request(&request(json!({ "schema": 1 }))).is_err());
    assert!(validate_message_request(&request(json!({
        "schema": 0,
        "blocks": []
    })))
    .is_err());
}

#[test]
fn retired_meme_attachments_stay_valid_without_rules_of_their_own() {
    let attachment_id = "att_meme".to_string();
    let request = |attachment| SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [],
            "legacy_attachments": [attachment]
        }),
        reply_to_message_id: None,
        attachment_ids: vec![attachment_id.clone()],
    };
    let valid = json!({
        "attachmentId": attachment_id,
        "name": "reaction.png",
        "kind": "image",
        "subtype": "meme",
        "altText": "Surprised cat says: when the tests pass on the first try.",
        "mimeType": "image/png"
    });

    assert!(validate_message_request(&request(valid.clone())).is_ok());

    // Alt text was the one meme-only rule; stored messages that lost it stay editable.
    let mut missing_alt = valid.clone();
    missing_alt["altText"] = json!("  ");
    assert!(validate_message_request(&request(missing_alt)).is_ok());

    let mut unsupported_type = valid;
    unsupported_type["mimeType"] = json!("image/svg+xml");
    assert!(validate_message_request(&request(unsupported_type)).is_err());
}

#[test]
fn sticker_attachments_ride_the_image_pipeline_without_alt_text() {
    let attachment_id = "att_sticker".to_string();
    let request = |attachment| SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [],
            "legacy_attachments": [attachment]
        }),
        reply_to_message_id: None,
        attachment_ids: vec![attachment_id.clone()],
    };
    let valid = json!({
        "attachmentId": attachment_id,
        "name": "wave.webp",
        "kind": "image",
        "subtype": "sticker",
        "mimeType": "image/webp"
    });

    assert!(validate_message_request(&request(valid.clone())).is_ok());

    let mut animated = valid.clone();
    animated["mimeType"] = json!("image/gif");
    assert!(validate_message_request(&request(animated)).is_ok());

    let mut unknown_attachment = valid.clone();
    unknown_attachment["attachmentId"] = json!("att_other");
    assert!(validate_message_request(&request(unknown_attachment)).is_err());

    let mut unsupported_type = valid.clone();
    unsupported_type["mimeType"] = json!("image/svg+xml");
    assert!(validate_message_request(&request(unsupported_type)).is_err());

    let mut as_file = valid;
    as_file["kind"] = json!("file");
    assert!(validate_message_request(&request(as_file)).is_err());
}

#[test]
fn unknown_attachment_subtypes_stay_rejected() {
    let attachment_id = "att_image".to_string();
    let request = SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [],
            "legacy_attachments": [{
                "attachmentId": attachment_id,
                "name": "clip.png",
                "kind": "image",
                "subtype": "collage",
                "mimeType": "image/png"
            }]
        }),
        reply_to_message_id: None,
        attachment_ids: vec![attachment_id.clone()],
    };

    assert!(validate_message_request(&request).is_err());
}

async fn signed_in_account(pool: &sqlx_postgres::PgPool, label: &str) -> (String, String) {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_send_{label}_{suffix}");
    let device_id = format!("dev_send_{label}_{suffix}");
    let now = chrono::Utc::now().to_rfc3339();
    sqlx_core::query::query(
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
    sqlx_core::query::query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, 'Send device', $3, $4, $4)",
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

async fn own_conversation(pool: &sqlx_postgres::PgPool, account_id: &str) -> Uuid {
    crate::chat_sync::store::create_conversation(
        pool,
        account_id,
        crate::chat_sync::models::CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: crate::chat_sync::models::ConversationKind::Ai,
            shared_title: None,
            client_session_id: format!("session:send-budget:{}", Uuid::new_v4().simple()),
            member_account_ids: Vec::new(),
        },
    )
    .await
    .unwrap()
    .value
    .id
}

fn send_request(conversation_id: Uuid, token: &str) -> axum::http::Request<axum::body::Body> {
    axum::http::Request::builder()
        .method("POST")
        .uri(format!("/v2/chat/conversations/{conversation_id}/messages"))
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(axum::body::Body::from(
            json!({
                "client_message_id": Uuid::now_v7(),
                "kind": "text",
                "content": { "schema": 1, "blocks": [{ "type": "text", "text": "hello" }] },
                "reply_to_message_id": null
            })
            .to_string(),
        ))
        .unwrap()
}

#[tokio::test]
async fn message_sends_are_budgeted_per_account() {
    use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter, MESSAGE_SEND_LIMIT};
    use axum::http::StatusCode;
    use tower::util::ServiceExt;

    let Ok(url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let pool = crate::pg::init_pool(&url).await.unwrap();
    let (sender, sender_token) = signed_in_account(&pool, "sender").await;
    let (other, other_token) = signed_in_account(&pool, "other").await;
    let sender_conversation = own_conversation(&pool, &sender).await;
    let other_conversation = own_conversation(&pool, &other).await;
    let limiter = std::sync::Arc::new(CloudRateLimiter::memory(CloudRateLimitConfig::default()));
    let state = std::sync::Arc::new(crate::server::ServerState::new(
        pool,
        crate::events::EventBus::noop(),
    ));
    let router = super::routes_with_runtime(state, ChatSyncRuntime { cursor_codec: None })
        .layer(axum::Extension(limiter.clone()));

    let first = router
        .clone()
        .oneshot(send_request(sender_conversation, &sender_token))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::CREATED);
    for _ in 1..MESSAGE_SEND_LIMIT.limit {
        limiter
            .observe_account_limit(MESSAGE_SEND_LIMIT, &sender)
            .await;
    }

    let limited = router
        .clone()
        .oneshot(send_request(sender_conversation, &sender_token))
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));

    let other_send = router
        .clone()
        .oneshot(send_request(other_conversation, &other_token))
        .await
        .unwrap();
    assert_eq!(
        other_send.status(),
        StatusCode::CREATED,
        "one account's budget does not affect another"
    );
}
