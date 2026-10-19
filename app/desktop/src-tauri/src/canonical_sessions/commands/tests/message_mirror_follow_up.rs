use super::*;

/// The Cloud copy of a background follow-up reply has no canonical parent; its
/// request is the runtime notice. Refusing the pair stopped every later Cloud
/// self-agent sync batch for the account.
#[test]
fn a_background_follow_up_reply_reconciles_with_its_cloud_copy() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (id, kind, title, status, created_by_identity_id, created_at_ms, updated_at_ms)
         VALUES ('session:self', 'self-agent', 'Self', 'active', 'human:me', 1, 3)",
        [],
    )
    .expect("seed session");
    let notice = "background-result:child:done";
    for (id, role, kind, parent, transport, content) in [
        (
            "message:notice",
            "system",
            "system",
            None,
            "desktop-chat",
            serde_json::json!({ "desktopEntryId": notice }),
        ),
        (
            "message:local-reply",
            "owned-agent",
            "agent-turn",
            Some("message:notice"),
            "desktop-chat",
            serde_json::json!({ "desktopEntryId": "entry:reply" }),
        ),
        (
            "message:cloud-reply",
            "owned-agent",
            "agent-turn",
            None,
            "cloud-self-agent",
            serde_json::json!({ "cloudRequestMessageId": notice, "deliveryState": "failed" }),
        ),
    ] {
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind, content_text,
                content_json, parent_message_id, status, sequence_num, created_at_ms, updated_at_ms,
                source_transport, source_event_id
             ) VALUES (?1, 'session:self', 'human:me', ?2, ?3, 'Synthetic reply', ?4, ?5, 'sent', 1, 2, 2, ?6, ?1)",
            params![id, role, kind, content.to_string(), parent, transport],
        )
        .expect("seed message");
    }

    assert!(reconcile_canonical_message_mirror_in_db(
        &conn,
        "message:local-reply",
        "message:cloud-reply",
    )
    .expect("the follow-up pair reconciles"));
    let remaining: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE sender_role='owned-agent'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 1);
}

#[test]
fn an_unrelated_parentless_cloud_reply_still_does_not_reconcile() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (id, kind, title, status, created_by_identity_id, created_at_ms, updated_at_ms)
         VALUES ('session:self', 'self-agent', 'Self', 'active', 'human:me', 1, 3)",
        [],
    )
    .expect("seed session");
    for (id, role, kind, parent, transport, content) in [
        (
            "message:notice",
            "system",
            "system",
            None,
            "desktop-chat",
            serde_json::json!({ "desktopEntryId": "background-result:child:done" }),
        ),
        (
            "message:local-reply",
            "owned-agent",
            "agent-turn",
            Some("message:notice"),
            "desktop-chat",
            serde_json::json!({}),
        ),
        (
            "message:cloud-reply",
            "owned-agent",
            "agent-turn",
            None,
            "cloud-self-agent",
            serde_json::json!({ "cloudRequestMessageId": "background-result:other:done" }),
        ),
    ] {
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind, content_text,
                content_json, parent_message_id, status, sequence_num, created_at_ms, updated_at_ms,
                source_transport, source_event_id
             ) VALUES (?1, 'session:self', 'human:me', ?2, ?3, 'Synthetic reply', ?4, ?5, 'sent', 1, 2, 2, ?6, ?1)",
            params![id, role, kind, content.to_string(), parent, transport],
        )
        .expect("seed message");
    }
    assert!(reconcile_canonical_message_mirror_in_db(
        &conn,
        "message:local-reply",
        "message:cloud-reply",
    )
    .is_err());
}
