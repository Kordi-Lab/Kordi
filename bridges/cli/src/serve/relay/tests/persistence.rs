//! Durable mailbox restart, drain, deduplication, and retention scenarios.

use super::*;

#[tokio::test]
async fn mailbox_survives_state_restart_until_fetched() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_project_members(&state, "proj_1", &["sender", "receiver"]);

    let _ = relay_message(
        State(state.clone()),
        Extension(AuthNode("sender".to_string())),
        Json(RelayReq {
            target_node_id: "receiver".to_string(),
            blob: "hello".to_string(),
            project_id: Some("proj_1".to_string()),
            target_kind: None,
            client_message_id: None,
        }),
    )
    .await
    .unwrap();

    let restarted_state = Arc::new(ServerState::new(db_path.clone()));
    let messages = fetch_mailbox(
        State(restarted_state),
        Extension(AuthNode("receiver".to_string())),
    )
    .await
    .unwrap()
    .0;

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].from, "sender");
    assert_eq!(messages[0].blob, "hello");
    assert_eq!(messages[0].project_id, None);
}

#[tokio::test]
async fn mailbox_fetch_drains_only_once() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    seed_registered_node(&state, "sender", "sender-key");
    seed_registered_node(&state, "receiver", "receiver-key");
    seed_contact(&state, "sender", "receiver");

    for blob in ["one", "two"] {
        let _ = relay_message(
            State(state.clone()),
            Extension(AuthNode("sender".to_string())),
            Json(RelayReq {
                target_node_id: "receiver".to_string(),
                blob: blob.to_string(),
                project_id: None,
                target_kind: None,
                client_message_id: None,
            }),
        )
        .await
        .unwrap();
    }

    let first = fetch_mailbox(
        State(state.clone()),
        Extension(AuthNode("receiver".to_string())),
    )
    .await
    .unwrap()
    .0;
    let second = fetch_mailbox(State(state), Extension(AuthNode("receiver".to_string())))
        .await
        .unwrap()
        .0;

    assert_eq!(first.len(), 2);
    assert!(second.is_empty());
    assert_eq!(first[0].blob, "one");
    assert_eq!(first[1].blob, "two");
}

#[test]
fn enqueue_with_same_client_message_id_returns_original_message() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    let mut conn = state.open_connection().unwrap();
    let entry = MailboxEntry {
        from: "sender".to_string(),
        blob: "first-payload".to_string(),
        project_id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let first = enqueue_mailbox_entry(&mut conn, "receiver", &entry, Some("client-key-1")).unwrap();
    let inserted_id = match first {
        EnqueueOutcome::Inserted { ref message_id } => message_id.clone(),
        _ => panic!("first send should produce a fresh row, got {first:?}"),
    };

    // Retry with the same key but a different blob — should NOT update or
    // duplicate; original row stays intact.
    let entry_retry = MailboxEntry {
        from: "sender".to_string(),
        blob: "second-payload".to_string(),
        project_id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let second =
        enqueue_mailbox_entry(&mut conn, "receiver", &entry_retry, Some("client-key-1")).unwrap();
    match second {
        EnqueueOutcome::Duplicate { ref message_id } => {
            assert_eq!(message_id, &inserted_id, "duplicate must echo original id");
        }
        _ => panic!("retry with same client_message_id must be Duplicate, got {second:?}"),
    }

    // Exactly one row remains and it carries the original payload.
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT message_id, blob FROM server_mailbox WHERE target_node_id = 'receiver'")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].0, inserted_id);
    assert_eq!(rows[0].1, "first-payload");
}

#[test]
fn enqueue_with_different_client_message_ids_produces_separate_rows() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    let mut conn = state.open_connection().unwrap();
    let make_entry = |blob: &str| MailboxEntry {
        from: "sender".to_string(),
        blob: blob.to_string(),
        project_id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let first = enqueue_mailbox_entry(&mut conn, "receiver", &make_entry("a"), Some("k1")).unwrap();
    let second =
        enqueue_mailbox_entry(&mut conn, "receiver", &make_entry("b"), Some("k2")).unwrap();
    assert!(matches!(first, EnqueueOutcome::Inserted { .. }));
    assert!(matches!(second, EnqueueOutcome::Inserted { .. }));
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = 'receiver'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn enqueue_without_client_message_id_does_not_dedupe() {
    // Legacy behaviour: clients that don't pass a key keep at-least-once
    // semantics. Two sends produce two rows even with identical payload.
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    let mut conn = state.open_connection().unwrap();
    let entry = MailboxEntry {
        from: "sender".to_string(),
        blob: "same-blob".to_string(),
        project_id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    enqueue_mailbox_entry(&mut conn, "receiver", &entry, None).unwrap();
    enqueue_mailbox_entry(&mut conn, "receiver", &entry, None).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM server_mailbox WHERE target_node_id = 'receiver'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn gc_mailbox_retention_only_prunes_rows_older_than_threshold() {
    let db_path = test_db_path();
    let state = test_state_for_path(&db_path);
    let conn = state.open_connection().unwrap();

    // Helper: insert a row with an explicit created_at timestamp.
    let insert_aged = |id: &str, days_old: i64| {
        let aged_at = (chrono::Utc::now() - chrono::Duration::days(days_old)).to_rfc3339();
        conn.execute(
            "INSERT INTO server_mailbox (message_id, target_node_id, from_node_id, blob, project_id, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            params![id, "receiver", "sender", "blob", &aged_at],
        )
        .expect("insert aged row");
    };

    insert_aged("ancient-1", 60); // pruned
    insert_aged("old-1", 31); // pruned (just past 30 day boundary)
    insert_aged("recent-1", 29); // kept
    insert_aged("fresh-1", 0); // kept

    let pruned = gc_mailbox_retention(&conn, MAILBOX_RETENTION_DAYS).expect("gc");
    assert_eq!(
        pruned, 2,
        "only the two rows older than 30 days should be pruned"
    );

    let remaining_ids: Vec<String> = conn
        .prepare("SELECT message_id FROM server_mailbox WHERE target_node_id = 'receiver' ORDER BY created_at")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| row.unwrap())
        .collect();
    assert_eq!(
        remaining_ids,
        vec!["recent-1".to_string(), "fresh-1".to_string()]
    );
}
