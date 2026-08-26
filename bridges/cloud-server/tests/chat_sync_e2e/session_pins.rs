use super::*;

#[tokio::test]
async fn bootstrap_resolves_session_pins_for_the_viewer() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping chat sync pin bootstrap test");
        return;
    };
    let owner = account(&pool, "pin-bootstrap-owner").await;
    let peer = account(&pool, "pin-bootstrap-peer").await;
    connect_accounts(&pool, &owner, &peer).await;
    let session_id = format!("session:group:{}", Uuid::now_v7());
    store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("Pinned group".to_string()),
            client_session_id: session_id.clone(),
            member_account_ids: vec![peer.clone()],
        },
    )
    .await
    .expect("create pinned group");
    query(
        "INSERT INTO cloud_session_shared_pins \
         (session_id, message_id, updated_by_account_id, updated_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(&session_id)
    .bind("message-shared")
    .bind(&owner)
    .bind("2026-08-26T10:00:00Z")
    .execute(&pool)
    .await
    .expect("insert shared pin");
    query(
        "INSERT INTO cloud_account_session_pins \
         (account_id, session_id, message_id, updated_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(&owner)
    .bind(&session_id)
    .bind("message-private")
    .bind("2026-08-26T10:01:00Z")
    .execute(&pool)
    .await
    .expect("insert private pin");

    let owner_bootstrap = store::bootstrap(&pool, &owner)
        .await
        .expect("bootstrap pin owner");
    let owner_pin = owner_bootstrap
        .session_pins
        .iter()
        .find(|pin| pin.session_id == session_id)
        .expect("owner pin snapshot");
    assert_eq!(
        owner_pin.shared_message_id.as_deref(),
        Some("message-shared")
    );
    assert_eq!(
        owner_pin.private_message_id.as_deref(),
        Some("message-private")
    );
    assert_eq!(
        owner_pin.effective_message_id.as_deref(),
        Some("message-private")
    );

    let peer_bootstrap = store::bootstrap(&pool, &peer)
        .await
        .expect("bootstrap pin peer");
    let peer_pin = peer_bootstrap
        .session_pins
        .iter()
        .find(|pin| pin.session_id == session_id)
        .expect("peer pin snapshot");
    assert_eq!(
        peer_pin.shared_message_id.as_deref(),
        Some("message-shared")
    );
    assert_eq!(peer_pin.private_message_id, None);
    assert_eq!(
        peer_pin.effective_message_id.as_deref(),
        Some("message-shared")
    );

    query("DELETE FROM cloud_session_shared_pins WHERE session_id = $1")
        .bind(&session_id)
        .execute(&pool)
        .await
        .expect("delete shared pin");
    query("DELETE FROM cloud_account_session_pins WHERE account_id = $1 AND session_id = $2")
        .bind(&owner)
        .bind(&session_id)
        .execute(&pool)
        .await
        .expect("delete private pin");
    let unpinned = store::bootstrap(&pool, &owner)
        .await
        .expect("bootstrap unpinned owner");
    let pin = unpinned
        .session_pins
        .iter()
        .find(|pin| pin.session_id == session_id)
        .expect("empty pin snapshot");
    assert_eq!(pin.effective_message_id, None);
}
