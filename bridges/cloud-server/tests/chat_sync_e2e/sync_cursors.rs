//! Sync cursors fail explicitly once retention or a client moves past them.

use super::*;

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
            client_session_id: direct_person_session_id(&owner, &peer),
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

    // Sweep only rows older than the retention window, so replay rows that
    // parallel tests write now keep their cursors.
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention::retention_days());
    let deleted = retention::sweep_expired_events(&pool, cutoff)
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
