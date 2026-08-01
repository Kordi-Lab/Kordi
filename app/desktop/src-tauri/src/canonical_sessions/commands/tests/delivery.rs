use super::*;

#[test]
fn restored_delivery_updates_an_old_message_by_id_with_a_bounded_delta() {
    let mut conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:restored', 'group', 'Restored', 'active', 'human:me', 1, 202, 202)",
        [],
    )
    .expect("seed session");
    let large_text = "t".repeat(512 * 1024);
    let large_content = serde_json::json!({
        "deliveryState": "sending",
        "deliveredRecipientIds": [],
        "pendingRecipientIds": ["acct:a", "acct:b"],
        "exhaustedRecipientIds": [],
        "unrelated": { "keep": true, "large": "x".repeat(512 * 1024) },
    })
    .to_string();
    conn.execute(
        "INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, content_json, status, sequence_num,
            created_at_ms, updated_at_ms, content_hash
         ) VALUES ('message:restored-old', 'session:restored', 'human:me', 'user', 'text',
                   ?1, ?2, 'sending', 1, 1, 1, 'old-hash')",
        params![large_text, large_content],
    )
    .expect("seed old restored target");
    let tx = conn.transaction().expect("begin newer-message seed");
    for sequence_num in 2..=202 {
        tx.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, content_json, status, sequence_num,
                created_at_ms, updated_at_ms, content_hash
             ) VALUES (?1, 'session:restored', 'human:me', 'user', 'text',
                       ?1, '{\"newer\":true}', 'sent', ?2, ?2, ?2, 'newer-hash')",
            params![format!("message:newer:{sequence_num}"), sequence_num],
        )
        .expect("seed newer message");
    }
    tx.commit().expect("commit newer-message seed");

    let delta = update_canonical_message_delivery_in_db(
        &mut conn,
        UpdateCanonicalMessageDeliveryRequest {
            message_id: "message:restored-old".to_string(),
            session_id: "session:restored".to_string(),
            status: "delivered".to_string(),
            delivery_state: "partial".to_string(),
            delivered_recipient_ids: vec!["acct:a".to_string()],
            pending_recipient_ids: Vec::new(),
            exhausted_recipient_ids: vec!["acct:b".to_string()],
        },
    )
    .expect("update restored delivery")
    .expect("old target still exists");

    assert_eq!(delta.message_id, "message:restored-old");
    assert_eq!(delta.session_id, "session:restored");
    assert_eq!(delta.status, "delivered");
    assert_eq!(delta.delivery_state, "partial");
    assert_ne!(delta.content_hash, "old-hash");
    assert_eq!(delta.session_updated_at_ms, delta.updated_at_ms);
    assert_eq!(delta.session_last_message_at_ms, Some(202));
    let serialized = serde_json::to_value(&delta).expect("serialize bounded delivery delta");
    let object = serialized.as_object().expect("delivery delta object");
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "contentHash",
            "deliveredRecipientIds",
            "deliveryState",
            "exhaustedRecipientIds",
            "messageId",
            "pendingRecipientIds",
            "sessionId",
            "sessionLastMessageAtMs",
            "sessionUpdatedAtMs",
            "status",
            "updatedAtMs",
        ]
    );
    assert!(serde_json::to_vec(&delta).expect("encode delta").len() < 512);

    let (status, content_json, content_hash, updated_at_ms): (String, String, String, i64) = conn
        .query_row(
            "SELECT status, content_json, content_hash, updated_at_ms
             FROM session_messages WHERE id = 'message:restored-old'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("load updated old target");
    assert_eq!(status, "delivered");
    assert_eq!(updated_at_ms, delta.updated_at_ms);
    assert_eq!(content_hash, delta.content_hash);
    let content: serde_json::Value = serde_json::from_str(&content_json).expect("parse content");
    assert_eq!(content["unrelated"]["keep"], true);
    assert_eq!(
        content["unrelated"]["large"].as_str().map(str::len),
        Some(512 * 1024)
    );
    assert_eq!(content["deliveryState"], "partial");
    assert_eq!(
        content["deliveredRecipientIds"],
        serde_json::json!(["acct:a"])
    );
    assert_eq!(content["pendingRecipientIds"], serde_json::json!([]));
    assert_eq!(
        content["exhaustedRecipientIds"],
        serde_json::json!(["acct:b"])
    );

    let unchanged_newer_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages
             WHERE session_id = 'session:restored' AND sequence_num > 1
               AND status = 'sent' AND content_json = '{\"newer\":true}'
               AND content_hash = 'newer-hash' AND updated_at_ms = sequence_num",
            [],
            |row| row.get(0),
        )
        .expect("count unchanged newer rows");
    assert_eq!(unchanged_newer_count, 201);
    let (session_updated_at_ms, last_message_at_ms): (i64, i64) = conn
        .query_row(
            "SELECT updated_at_ms, last_message_at_ms FROM sessions WHERE id = 'session:restored'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("load session timestamps");
    assert_eq!(session_updated_at_ms, delta.updated_at_ms);
    assert_eq!(last_message_at_ms, 202);
}

#[test]
fn delivery_update_validates_ids_and_states_and_distinguishes_missing_from_wrong_session() {
    let mut conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id, created_at_ms, updated_at_ms
         ) VALUES ('session:one', 'group', 'One', 'active', 'human:me', 1, 1)",
        [],
    )
    .expect("seed session");
    conn.execute(
        "INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, content_json, status, sequence_num, created_at_ms, updated_at_ms
         ) VALUES ('message:one', 'session:one', 'human:me', 'user', 'text',
                   'one', '{}', 'sending', 1, 1, 1)",
        [],
    )
    .expect("seed message");
    let request = |message_id: &str, session_id: &str, status: &str, delivery_state: &str| {
        UpdateCanonicalMessageDeliveryRequest {
            message_id: message_id.to_string(),
            session_id: session_id.to_string(),
            status: status.to_string(),
            delivery_state: delivery_state.to_string(),
            delivered_recipient_ids: Vec::new(),
            pending_recipient_ids: vec!["acct:a".to_string()],
            exhausted_recipient_ids: Vec::new(),
        }
    };

    assert!(update_canonical_message_delivery_in_db(
        &mut conn,
        request("message:missing", "session:one", "sending", "sending"),
    )
    .expect("missing rows are not errors")
    .is_none());
    assert!(update_canonical_message_delivery_in_db(
        &mut conn,
        request("message:one", "session:other", "sending", "sending"),
    )
    .expect_err("wrong session must error")
    .contains("session"));
    for invalid in [
        request(" ", "session:one", "sending", "sending"),
        request("message:one", " ", "sending", "sending"),
        request("message:one", "session:one", "sent", "sending"),
        request("message:one", "session:one", "sending", "pending"),
    ] {
        assert!(update_canonical_message_delivery_in_db(&mut conn, invalid).is_err());
    }
}
