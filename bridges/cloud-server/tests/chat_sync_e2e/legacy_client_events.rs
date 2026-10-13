use super::*;

#[tokio::test]
async fn unknown_event_types_are_stored_non_critical_for_released_clients() {
    let Some(pool) = try_pool().await else {
        return;
    };
    let recipient = account(&pool, "legacy-events").await;
    let mut transaction = pool.begin().await.unwrap();
    for event_type in ["session.pinned", "transition.unknown_event"] {
        store::append_user_sync_events_in_transaction(
            &mut transaction,
            std::slice::from_ref(&recipient),
            event_type,
            None,
            &json!({ "sessionId": "session:legacy-events" }),
        )
        .await
        .unwrap();
    }
    transaction.commit().await.unwrap();

    let stored: Vec<(String, bool)> = query_as(
        "SELECT event_type, critical FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 ORDER BY stream_seq ASC",
    )
    .bind(&recipient)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        stored,
        vec![
            ("session.pinned".to_string(), true),
            ("transition.unknown_event".to_string(), false),
        ]
    );
}
