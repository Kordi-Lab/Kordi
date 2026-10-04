//! Push notifications respect blocks: a blocker gets no message push for a
//! blocked sender and no ring for calls the blocked account starts or rings.

use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::{ConversationKind, CreateConversationRequest, SendMessageRequest};
use crate::chat_sync::store;

const ENVIRONMENT: &str = "development";

async fn test_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

/// An account with one signed-in device that has message and VoIP tokens.
async fn account_with_device(pool: &PgPool, label: &str) -> String {
    let suffix = Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_push_{label}_{suffix}");
    let device_id = format!("dev_push_{label}_{suffix}");
    let now = chrono::Utc::now();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $1 || '@example.test', $3, $3, 'generated', 'lorelei', $1, 'test', 1, $3)",
    )
    .bind(&account_id)
    .bind(label)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, \
                                    created_at, last_seen_at) \
         VALUES ($1, $2, 'Phone', $1, $3, $3)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_refresh_tokens (token_id, account_id, device_id, token_hash, \
                                           created_at, expires_at) \
         VALUES ($1, $2, $3, $1, $4, $5)",
    )
    .bind(format!("cs_{suffix}"))
    .bind(&account_id)
    .bind(&device_id)
    .bind(now.to_rfc3339())
    .bind((now + chrono::Duration::days(30)).to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
    for table in ["cloud_apns_push_tokens", "cloud_voip_push_tokens"] {
        query(&format!(
            "INSERT INTO {table} (device_id, account_id, device_token, apns_environment) \
             VALUES ($1, $2, $3, $4)"
        ))
        .bind(&device_id)
        .bind(&account_id)
        .bind(format!("token-{table}-{suffix}"))
        .bind(ENVIRONMENT)
        .execute(pool)
        .await
        .unwrap();
    }
    account_id
}

async fn connect(pool: &PgPool, left: &str, right: &str) {
    query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
         VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(left)
    .bind(right)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
}

async fn block(pool: &PgPool, blocker: &str, blocked: &str) {
    query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) VALUES ($1, $2)",
    )
    .bind(blocker)
    .bind(blocked)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn group_messages_from_a_blocked_sender_do_not_notify_the_blocker() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let sender = account_with_device(&pool, "sender").await;
    let blocker = account_with_device(&pool, "blocker").await;
    let other = account_with_device(&pool, "other").await;
    connect(&pool, &sender, &blocker).await;
    connect(&pool, &sender, &other).await;
    let group = store::create_conversation(
        &pool,
        &sender,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Push".to_string()),
            client_session_id: format!("session:group:push-{}", Uuid::new_v4().simple()),
            member_account_ids: vec![blocker.clone(), other.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    // Blocking does not remove anyone from a shared group.
    block(&pool, &blocker, &sender).await;
    let message = store::send_message(
        &pool,
        &sender,
        group.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: serde_json::json!({ "schema": 1, "blocks": [{ "type": "text", "text": "hi" }] }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .unwrap()
    .value;

    let recipients = super::register_message_notification_events(&pool, &message, ENVIRONMENT)
        .await
        .unwrap();
    assert_eq!(recipients, vec![other.clone()]);
    let events: Vec<(String, bool, i64)> = query_as(
        "SELECT event.recipient_account_id, event.accepted_at IS NOT NULL, \
                (SELECT COUNT(*) FROM cloud_message_notification_deliveries delivery \
                 WHERE delivery.recipient_account_id = event.recipient_account_id \
                   AND delivery.message_id = event.message_id) \
         FROM cloud_message_notification_events event \
         WHERE event.message_id = $1 ORDER BY event.recipient_account_id",
    )
    .bind(message.id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut expected = vec![(blocker.clone(), true, 0), (other.clone(), false, 1)];
    expected.sort();
    assert_eq!(events, expected);
}

#[tokio::test]
async fn incoming_calls_do_not_ring_accounts_that_blocked_the_actor() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let actor = account_with_device(&pool, "caller").await;
    let blocker = account_with_device(&pool, "blocker").await;
    let other = account_with_device(&pool, "other").await;
    block(&pool, &blocker, &actor).await;
    let recipients = vec![blocker.clone(), other.clone()];
    let owners = |tokens: Vec<(String,)>| {
        let mut owners = tokens.into_iter().map(|(token,)| token).collect::<Vec<_>>();
        owners.sort();
        owners
    };
    let token_of = |account: &str| {
        let suffix = account.rsplit('_').next().unwrap().to_string();
        format!("token-cloud_voip_push_tokens-{suffix}")
    };

    // Starting and inviting are both checked against the acting account.
    let rung = crate::notifications::calls::incoming_call_device_tokens(
        &pool,
        &recipients,
        ENVIRONMENT,
        &actor,
    )
    .await
    .unwrap();
    assert_eq!(owners(rung), vec![token_of(&other)]);

    let rung = crate::notifications::calls::incoming_call_device_tokens(
        &pool,
        &recipients,
        ENVIRONMENT,
        &other,
    )
    .await
    .unwrap();
    let mut expected = vec![token_of(&blocker), token_of(&other)];
    expected.sort();
    assert_eq!(owners(rung), expected);
}
