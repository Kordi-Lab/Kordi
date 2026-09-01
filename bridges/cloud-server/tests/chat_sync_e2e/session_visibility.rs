use super::*;

#[tokio::test]
async fn only_frontend_visible_messages_restore_deleted_sessions() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping session visibility test");
        return;
    };
    let owner = account(&pool, "visibility-owner").await;
    let peer = account(&pool, "visibility-peer").await;
    connect_accounts(&pool, &owner, &peer).await;

    async fn create(pool: &PgPool, owner: &str, peer: &str, session_id: String) -> uuid::Uuid {
        store::create_conversation(
            pool,
            owner,
            CreateConversationRequest {
                client_operation_id: Uuid::now_v7(),
                kind: ConversationKind::Direct,
                shared_title: None,
                client_session_id: session_id,
                member_account_ids: vec![peer.to_string()],
            },
        )
        .await
        .expect("create conversation")
        .value
        .id
    }

    let first_session = format!("session:direct-person:{}", Uuid::now_v7());
    let second_session = format!("session:direct-person:{}", Uuid::now_v7());
    let first = create(&pool, &owner, &peer, first_session.clone()).await;
    let _second = create(&pool, &owner, &peer, second_session.clone()).await;
    let now = chrono::Utc::now().to_rfc3339();
    for (account_id, session_id) in [
        (&owner, &first_session),
        (&peer, &first_session),
        (&peer, &second_session),
    ] {
        query(
            "INSERT INTO cloud_account_session_visibility \
             (account_id, session_id, hidden_at, deleted_at, updated_at) \
             VALUES ($1, $2, NULL, $3, $3)",
        )
        .bind(account_id)
        .bind(session_id)
        .bind(&now)
        .execute(&pool)
        .await
        .expect("delete session for account");
    }

    let hidden = store::send_message(
        &pool,
        &owner,
        first,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "agent_control".to_string(),
            content: json!({ "schema": 1, "blocks": [] }),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send hidden control message")
    .value;

    let remaining: Vec<(String, String, Option<String>, Option<String>)> = query_as(
        "SELECT account_id, session_id, hidden_at, deleted_at \
         FROM cloud_account_session_visibility \
         WHERE account_id = ANY($1) ORDER BY account_id, session_id",
    )
    .bind(vec![owner.clone(), peer.clone()])
    .fetch_all(&pool)
    .await
    .expect("load visibility rows");
    assert!(remaining
        .iter()
        .any(|row| row.0 == owner && row.1 == first_session));
    assert!(remaining
        .iter()
        .any(|row| row.0 == peer && row.1 == second_session));
    assert!(remaining
        .iter()
        .any(|row| row.0 == peer && row.1 == first_session));

    let peer_events = store::sync_batch(&pool, &peer, 0, Some(100))
        .await
        .expect("load peer events")
        .events;
    assert!(!peer_events.iter().any(|event| {
        event.event_type == "session.unhidden" && event.payload["sessionId"] == first_session
    }));
    assert!(peer_events
        .iter()
        .any(|event| event.event_type == "message.created" && event.entity_id == Some(hidden.id)));

    let visible = store::send_message(
        &pool,
        &owner,
        first,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content("fresh visible activity"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send visible message")
    .value;

    let remaining: Vec<(String, String)> = query_as(
        "SELECT account_id, session_id FROM cloud_account_session_visibility \
         WHERE account_id = ANY($1) ORDER BY account_id, session_id",
    )
    .bind(vec![owner.clone(), peer.clone()])
    .fetch_all(&pool)
    .await
    .expect("load visibility rows after visible message");
    assert!(remaining
        .iter()
        .any(|row| row.0 == owner && row.1 == first_session));
    assert!(remaining
        .iter()
        .any(|row| row.0 == peer && row.1 == second_session));
    assert!(!remaining
        .iter()
        .any(|row| row.0 == peer && row.1 == first_session));

    let peer_events = store::sync_batch(&pool, &peer, 0, Some(100))
        .await
        .expect("load peer events after visible message")
        .events;
    let restored_index = peer_events
        .iter()
        .position(|event| {
            event.event_type == "session.unhidden" && event.payload["sessionId"] == first_session
        })
        .expect("restoration event");
    let message_index = peer_events
        .iter()
        .position(|event| {
            event.event_type == "message.created" && event.entity_id == Some(visible.id)
        })
        .expect("visible message event");
    assert!(restored_index < message_index);

    query(
        "UPDATE cloud_account_session_visibility \
         SET hidden_at = $3, deleted_at = NULL, updated_at = $3 \
         WHERE account_id = $1 AND session_id = $2",
    )
    .bind(&owner)
    .bind(&first_session)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .expect("archive owner session");
    store::send_message(
        &pool,
        &peer,
        first,
        SendMessageRequest {
            client_message_id: Uuid::now_v7(),
            kind: "text".to_string(),
            content: content("archive remains stable"),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send to archived session");
    let archived: (Option<String>, Option<String>) = query_as(
        "SELECT hidden_at, deleted_at FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND session_id = $2",
    )
    .bind(&owner)
    .bind(&first_session)
    .fetch_one(&pool)
    .await
    .expect("load archived visibility");
    assert!(archived.0.is_some());
    assert!(archived.1.is_none());
}
