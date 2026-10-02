use super::session_list_fixtures::seed_stale_group;
use super::*;
use kordi_cloud_server::chat_sync::store;
use sqlx_core::{query::query, query_as::query_as};

#[tokio::test]
async fn pin_stacks_limit_concurrent_adds_and_unpin_one_without_leaking_private_state() {
    if std::env::var("DATABASE_URL").is_err() {
        return;
    }
    let pool = try_pool()
        .await
        .expect("configured test database must initialize");
    let router = fast_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let (owner_token, owner) = signup_account(&router, "pin-stack-owner").await;
    let (peer_token, peer) = signup_account(&router, "pin-stack-peer").await;
    let session_id = format!("session:group:{}", uuid::Uuid::now_v7());
    let conversation = seed_stale_group(&pool, &owner, Some(&session_id), None, "active").await;
    query("INSERT INTO cloud_chat_conversation_members(conversation_id, account_id, membership_state) VALUES ($1,$2,'active')")
        .bind(conversation).bind(&peer).execute(&pool).await.unwrap();
    let path = format!("/v1/cloud/sessions/{session_id}/pin");
    for (id, scope) in [
        ("personal", "private"),
        ("one", "shared"),
        ("two", "shared"),
        ("three", "shared"),
    ] {
        let response = router
            .clone()
            .oneshot(put_json_with_token(
                &path,
                &owner_token,
                json!({"messageId":id,"scope":scope,"action":"pin"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let add = |id: &str| {
        router.clone().oneshot(put_json_with_token(
            &path,
            &owner_token,
            json!({"messageId":id,"scope":"shared","action":"pin"}),
        ))
    };
    let (left, right) = tokio::join!(add("four"), add("five"));
    let statuses = [left.unwrap().status(), right.unwrap().status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|status| **status == StatusCode::CONFLICT)
            .count(),
        1
    );
    let before = read_json(
        router
            .clone()
            .oneshot(get_with_token(&path, &owner_token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        before["pin"]["sharedMessageIds"].as_array().unwrap().len(),
        4
    );
    assert_eq!(before["pin"]["privateMessageIds"], json!(["personal"]));
    let peer_state = read_json(
        router
            .clone()
            .oneshot(get_with_token(&path, &peer_token))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(peer_state["pin"]["privateMessageIds"], json!([]));
    assert_eq!(
        peer_state["pin"]["sharedMessageIds"],
        before["pin"]["sharedMessageIds"]
    );
    let bootstrap = store::bootstrap(&pool, &owner).await.unwrap();
    let restored = bootstrap
        .session_pins
        .iter()
        .find(|pin| pin.session_id == session_id)
        .unwrap();
    assert_eq!(restored.shared_message_ids.len(), 4);
    assert_eq!(restored.private_message_ids, vec!["personal"]);
    for _ in 0..2 {
        let response = router
            .clone()
            .oneshot(put_json_with_token(
                &path,
                &owner_token,
                json!({"messageId":"two","scope":"shared","action":"unpin"}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let after = read_json(
        router
            .clone()
            .oneshot(get_with_token(&path, &owner_token))
            .await
            .unwrap(),
    )
    .await;
    let remaining = after["pin"]["sharedMessageIds"].as_array().unwrap();
    assert_eq!(remaining.len(), 3);
    assert!(!remaining.contains(&json!("two")));
    assert_eq!(after["pin"]["privateMessageIds"], json!(["personal"]));
    let events: Vec<(String, serde_json::Value)> = query_as("SELECT account_id,payload FROM cloud_chat_user_sync_events WHERE conversation_id=$1 AND event_type='session.pin.updated'")
        .bind(conversation).fetch_all(&pool).await.unwrap();
    assert_eq!(
        events.len(),
        11,
        "one private add and five shared mutations fan out exactly once"
    );
    for (recipient, event) in events {
        if recipient == peer {
            assert_eq!(event["scope"], "shared");
        }
        if event["kind"] == "unpinned" {
            assert_eq!(event["pinHistoryEvent"]["kind"], "unpinned");
            assert_eq!(event["pinHistoryEvent"]["messageId"], "two");
            assert_eq!(event["messageIds"], after["pin"]["sharedMessageIds"]);
            assert_ne!(
                event["messageId"], "two",
                "legacy projection keeps the remaining latest pin"
            );
        }
        assert!(event.get("privateMessageIds").is_none());
    }
    let history: (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_session_pin_history WHERE conversation_id=$1")
            .bind(conversation)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        history.0, 6,
        "failed sixth pin and repeated unpin cannot create history"
    );
    // A legacy client still replaces its scalar projection during a rolling upgrade.
    let legacy = read_json(
        router
            .oneshot(put_json_with_token(
                &path,
                &owner_token,
                json!({"messageId":"legacy","scope":"shared"}),
            ))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(legacy["pin"]["sharedMessageIds"], json!(["legacy"]));
}
