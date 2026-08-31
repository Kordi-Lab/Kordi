use kordi_cloud_server::chat_sync::models::{
    AddConversationMembersRequest, AdvanceConversationCursorRequest, ConversationKind,
    CreateConversationRequest, SendMessageRequest, UpdateConversationTitleRequest,
    UpdateMessageRequest, UpdatePersonalTitleRequest,
};
use kordi_cloud_server::chat_sync::store::{self, StoreError};
use kordi_cloud_server::{chat_sync::retention, pg::init_pool};
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;
#[path = "chat_sync_e2e/default_self_agent.rs"]
mod default_self_agent;
#[path = "chat_sync_e2e/membership.rs"]
mod membership;
#[path = "chat_sync_e2e/message_mutations.rs"]
mod message_mutations;
#[path = "chat_sync_e2e/reactions.rs"]
mod reactions;
#[path = "chat_sync_e2e/session_pins.rs"]
mod session_pins;
#[path = "chat_sync_e2e/support_migration.rs"]
mod support_migration;
async fn try_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    match init_pool(&url).await {
        Ok(pool) => Some(pool),
        Err(error) => {
            eprintln!("[chat_sync_e2e] init_pool failed, skipping: {error}");
            None
        }
    }
}

async fn account(pool: &PgPool, label: &str) -> String {
    let account_id = format!("chat-{label}-{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts(account_id, display_name, avatar_url, created_at, updated_at, avatar_source,
             avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) VALUES ($1, $2, $3, $4, $4, 'uploaded', 'lorelei', $1,
             'dicebear-rust-10.6.0-styles-10.5.0', 1, $4)",
    )
    .bind(&account_id)
    .bind(label)
    .bind(format!("https://avatars.example/{label}.png"))
    .bind(now)
    .execute(pool)
    .await
    .expect("create test account");
    account_id
}
async fn connect_accounts(pool: &PgPool, left: &str, right: &str) {
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_contacts(account_id, peer_account_id, created_at) \
         VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(left)
    .bind(right)
    .bind(now)
    .execute(pool)
    .await
    .expect("connect test accounts");
}
fn content(text: &str) -> serde_json::Value {
    json!({
        "schema": 1,
        "blocks": [{ "type": "text", "text": text }]
    })
}
async fn sync_head(pool: &PgPool, account_id: &str) -> (i64, i64) {
    query_as("SELECT last_seq, min_seq FROM cloud_chat_user_sync_heads WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .expect("load sync head")
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn message_sync_is_idempotent_ordered_and_convergent_across_members() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping chat sync e2e test");
        return;
    };
    let owner = account(&pool, "owner").await;
    let peer = account(&pool, "peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let create_request = CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: ConversationKind::Direct,
        shared_title: Some("Initial title".to_string()),
        client_session_id: format!("session:direct-person:{owner}:{peer}"),
        member_account_ids: vec![peer.clone()],
    };
    let created = store::create_conversation(&pool, &owner, create_request.clone())
        .await
        .expect("create direct conversation");
    assert!(created.inserted);
    let conversation_id = created.value.id;
    let peer_snapshot = created
        .value
        .members
        .iter()
        .find(|member| member.account_id == peer)
        .expect("peer member snapshot");
    assert_eq!(peer_snapshot.display_name.as_deref(), Some("peer"));
    assert_eq!(
        peer_snapshot.avatar_url.as_deref(),
        Some("https://avatars.example/peer.png")
    );
    let fork_session_id = created.value.legacy_session_id.clone().unwrap();
    let fork_created_at = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_session_forks \
         (fork_session_id, parent_session_id, parent_message_id, created_by_account_id, created_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&fork_session_id)
    .bind("session:self-agent:parent")
    .bind("msg:parent")
    .bind(&owner)
    .bind(fork_created_at)
    .execute(&pool)
    .await
    .expect("record fork lineage");
    let bootstrapped = store::bootstrap(&pool, &owner)
        .await
        .expect("bootstrap fork lineage");
    let fork_snapshot = bootstrapped
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)
        .expect("fork conversation snapshot");
    assert_eq!(
        fork_snapshot.forked_from_session_id.as_deref(),
        Some("session:self-agent:parent")
    );
    assert_eq!(
        fork_snapshot.forked_from_message_id.as_deref(),
        Some("msg:parent")
    );
    let duplicate = store::create_conversation(&pool, &owner, create_request)
        .await
        .expect("retry conversation creation");
    assert!(!duplicate.inserted);
    assert_eq!(duplicate.value.id, conversation_id);
    let peer_open = store::create_conversation(
        &pool,
        &peer,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: Some("Initial title".to_string()),
            client_session_id: created.value.legacy_session_id.clone().unwrap(),
            member_account_ids: vec![owner.clone()],
        },
    )
    .await
    .expect("other member opens the same direct session");
    assert!(!peer_open.inserted);
    assert_eq!(peer_open.value.id, conversation_id);
    let send_request = SendMessageRequest {
        client_message_id: Uuid::now_v7(),
        kind: "text".to_string(),
        content: content("sent once"),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    let mut tasks = Vec::new();
    for _ in 0..50 {
        let pool = pool.clone();
        let owner = owner.clone();
        let request = send_request.clone();
        tasks.push(tokio::spawn(async move {
            store::send_message(&pool, &owner, conversation_id, request).await
        }));
    }
    let mut ids = Vec::new();
    let mut inserted = 0;
    for task in tasks {
        let outcome = task
            .await
            .expect("send task joined")
            .expect("send succeeded");
        inserted += usize::from(outcome.inserted);
        ids.push(outcome.value.id);
        assert_eq!(outcome.value.conversation_sequence, 1);
    }
    assert_eq!(inserted, 1, "exactly one concurrent send must insert");
    assert!(ids.iter().all(|message_id| *message_id == ids[0]));
    let message_count: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_messages \
         WHERE sender_account_id = $1 AND client_message_id = $2",
    )
    .bind(&owner)
    .bind(send_request.client_message_id)
    .fetch_one(&pool)
    .await
    .expect("count canonical messages");
    assert_eq!(message_count.0, 1);

    let mismatched = SendMessageRequest {
        content: content("different input"),
        ..send_request
    };
    assert!(matches!(
        store::send_message(&pool, &owner, conversation_id, mismatched).await,
        Err(StoreError::IdempotencyKeyReused)
    ));

    for account_id in [&owner, &peer] {
        let batch = store::sync_batch(&pool, account_id, 0, Some(500))
            .await
            .expect("load initial sync stream");
        assert_eq!(batch.events.len(), 2);
        assert_eq!(batch.events[0].stream_seq, 1);
        assert_eq!(batch.events[1].stream_seq, 2);
        assert_eq!(batch.events[0].event_type, "conversation.created");
        assert_eq!(batch.events[1].event_type, "message.created");
        assert!(!batch.has_more);
    }

    let shared_title_operation = Uuid::now_v7();
    let shared_title_request = UpdateConversationTitleRequest {
        client_operation_id: shared_title_operation,
        expected_version: 2,
        shared_title: Some("Synced title".to_string()),
    };
    let titled =
        store::update_shared_title(&pool, &owner, conversation_id, shared_title_request.clone())
            .await
            .expect("update shared title");
    assert_eq!(titled.version, 3);
    assert_eq!(titled.shared_title.as_deref(), Some("Synced title"));
    let title_retry =
        store::update_shared_title(&pool, &owner, conversation_id, shared_title_request)
            .await
            .expect("retry shared title update");
    assert_eq!(title_retry.version, titled.version);
    assert!(matches!(
        store::update_shared_title(
            &pool,
            &owner,
            conversation_id,
            UpdateConversationTitleRequest {
                client_operation_id: Uuid::now_v7(),
                expected_version: 2,
                shared_title: Some("stale device".to_string()),
            },
        )
        .await,
        Err(StoreError::VersionConflict(_))
    ));

    let personal = store::update_personal_title(
        &pool,
        &owner,
        conversation_id,
        UpdatePersonalTitleRequest {
            client_operation_id: Uuid::now_v7(),
            expected_preferences_version: 1,
            personal_title: Some("My private title".to_string()),
        },
    )
    .await
    .expect("update personal title");
    assert_eq!(personal.version, 2);
    assert_eq!(personal.personal_title.as_deref(), Some("My private title"));
    assert_eq!(sync_head(&pool, &owner).await.0, 4);
    assert_eq!(sync_head(&pool, &peer).await.0, 3);

    let delivered = store::advance_delivery_cursor(
        &pool,
        &owner,
        conversation_id,
        AdvanceConversationCursorRequest {
            client_operation_id: Uuid::now_v7(),
            sequence: 1,
        },
    )
    .await
    .expect("advance delivery cursor");
    assert_eq!(delivered.last_delivered_sequence, 1);
    assert_eq!(delivered.last_read_sequence, 0);

    let read = store::advance_read_cursor(
        &pool,
        &peer,
        conversation_id,
        AdvanceConversationCursorRequest {
            client_operation_id: Uuid::now_v7(),
            sequence: 1,
        },
    )
    .await
    .expect("advance read cursor");
    assert_eq!(read.last_delivered_sequence, 1);
    assert_eq!(read.last_read_sequence, 1);
    let stale = store::advance_delivery_cursor(
        &pool,
        &peer,
        conversation_id,
        AdvanceConversationCursorRequest {
            client_operation_id: Uuid::now_v7(),
            sequence: 0,
        },
    )
    .await
    .expect("stale cursor is a successful no-op");
    assert_eq!(stale.last_delivered_sequence, 1);
    assert_eq!(stale.last_read_sequence, 1);

    assert_eq!(sync_head(&pool, &owner).await.0, 6);
    assert_eq!(sync_head(&pool, &peer).await.0, 5);
    let bootstrap = store::bootstrap(&pool, &peer)
        .await
        .expect("bootstrap peer state");
    assert_eq!(bootstrap.stream_seq, 5);
    assert_eq!(bootstrap.conversations.len(), 1);
    assert_eq!(bootstrap.latest_messages.len(), 1);
    assert_eq!(
        bootstrap.conversations[0].shared_title.as_deref(),
        Some("Synced title")
    );
    assert_eq!(bootstrap.conversations[0].preferences.account_id, peer);
    assert_eq!(bootstrap.conversations[0].preferences.personal_title, None);
    let peer_member = bootstrap.conversations[0]
        .members
        .iter()
        .find(|member| member.account_id == peer)
        .expect("peer membership in bootstrap");
    assert_eq!(peer_member.last_read_sequence, 1);

    let owner_bootstrap = store::bootstrap(&pool, &owner)
        .await
        .expect("bootstrap owner state");
    assert_eq!(
        owner_bootstrap.conversations[0]
            .preferences
            .personal_title
            .as_deref(),
        Some("My private title")
    );
}

#[tokio::test]
async fn cursor_expiry_and_ahead_positions_fail_explicitly() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping chat sync cursor e2e test");
        return;
    };
    let user = account(&pool, "cursor").await;
    query(
        "INSERT INTO cloud_chat_user_sync_heads(account_id, last_seq, min_seq) \
         VALUES ($1, 10, 4)",
    )
    .bind(&user)
    .execute(&pool)
    .await
    .expect("create retained cursor window");

    assert!(matches!(
        store::sync_batch(&pool, &user, 3, Some(10)).await,
        Err(StoreError::CursorExpired)
    ));
    assert!(matches!(
        store::sync_batch(&pool, &user, 11, Some(10)).await,
        Err(StoreError::CursorAhead)
    ));
}

#[tokio::test]
async fn retention_advances_the_cursor_floor_before_replay_rows_are_deleted() {
    let Some(pool) = try_pool().await else { return };
    let owner = account(&pool, "retention-owner").await;
    let peer = account(&pool, "retention-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let conversation = store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: format!("session:retention:{}", Uuid::now_v7()),
            member_account_ids: vec![peer.clone()],
        },
    )
    .await
    .expect("create retained conversation")
    .value;
    store::send_message(
        &pool,
        &owner,
        conversation.id,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content("still canonical after replay retention"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send retained message");
    query(
        "UPDATE cloud_chat_user_sync_events SET occurred_at = now() - interval '100 days' \
         WHERE account_id = $1",
    )
    .bind(&peer)
    .execute(&pool)
    .await
    .expect("age replay rows");

    let deleted = retention::sweep_expired_events(&pool, chrono::Utc::now())
        .await
        .expect("sweep replay rows");
    assert!(deleted >= 2);
    assert!(matches!(
        store::sync_batch(&pool, &peer, 0, Some(10)).await,
        Err(StoreError::CursorExpired)
    ));
    let bootstrap = store::bootstrap(&pool, &peer)
        .await
        .expect("bootstrap remains canonical");
    assert_eq!(bootstrap.conversations.len(), 1);
    assert_eq!(bootstrap.latest_messages.len(), 1);
}
