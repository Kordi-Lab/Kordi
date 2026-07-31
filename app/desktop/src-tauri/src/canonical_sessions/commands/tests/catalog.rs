use super::*;

#[test]
fn catalog_and_first_page_stay_bounded_with_twenty_thousand_messages() {
    let mut conn = test_conn();
    seed_identity(&conn);
    let padding = "x".repeat(512);
    let content_json = format!(r#"{{"padding":"{padding}"}}"#);
    let tx = conn.transaction().expect("begin seed transaction");
    for session_index in 0..200 {
        let session_id = format!("session:scale:{session_index:04}");
        tx.execute(
            "INSERT INTO sessions (
                id, kind, title, status, created_by_identity_id,
                created_at_ms, updated_at_ms, last_message_at_ms
             ) VALUES (?1, 'group', ?2, 'active', 'human:me', ?3, ?4, ?4)",
            params![
                session_id,
                format!("Scale session {session_index}"),
                session_index as i64,
                (session_index * 100 + 100) as i64,
            ],
        )
        .expect("seed session");
        for sequence_num in 1..=100 {
            let message_number = session_index * 100 + sequence_num;
            tx.execute(
                "INSERT INTO session_messages (
                    id, session_id, sender_identity_id, sender_role, message_kind,
                    content_text, content_json, status, sequence_num,
                    created_at_ms, updated_at_ms
                 ) VALUES (?1, ?2, 'human:me', 'user', 'text', ?3, ?4, 'sent', ?5, ?6, ?6)",
                params![
                    format!("message:{message_number:05}"),
                    session_id,
                    format!("Scale message {message_number}"),
                    content_json,
                    sequence_num as i64,
                    message_number as i64,
                ],
            )
            .expect("seed message");
        }
    }
    tx.commit().expect("commit scale fixture");

    let catalog = load_catalog_from_db(&conn).expect("load catalog");
    let catalog_bytes = serde_json::to_vec(&catalog)
        .expect("serialize catalog")
        .len();
    assert_eq!(catalog.sessions.len(), 200);
    assert_eq!(catalog.summaries.len(), 200);
    assert_eq!(
        catalog
            .summaries
            .iter()
            .map(|summary| summary.message_count)
            .sum::<i64>(),
        20_000
    );
    assert!(
        catalog_bytes < 1024 * 1024,
        "catalog payload was {catalog_bytes} bytes"
    );

    let page = load_message_page_from_db(&conn, "session:scale:0199", None, Some(100))
        .expect("load latest page");
    let page_bytes = serde_json::to_vec(&page).expect("serialize page").len();
    assert_eq!(page.messages.len(), 100);
    assert!(page.messages.len() <= 150);
    assert!(!page.has_older);
    assert_eq!(page.oldest_sequence_num, Some(1));
    assert_eq!(page.newest_sequence_num, Some(100));
    assert!(
        page_bytes < 512 * 1024,
        "page payload was {page_bytes} bytes"
    );
}

#[test]
fn catalog_summaries_exclude_non_chat_rows_while_pages_keep_them() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:one', 'group', 'One', 'active', 'human:me', 1, 3, 3)",
        [],
    )
    .expect("seed session");
    for (id, status, sequence_num, source_transport) in [
        ("m1", "sent", 1, None),
        ("m2", "sending", 2, None),
        ("m3", "sent", 3, Some("canonical-fork-snapshot")),
    ] {
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, status, sequence_num, created_at_ms, updated_at_ms, source_transport
             ) VALUES (?1, 'session:one', 'human:me', 'user', 'text', ?1, ?2, ?3, ?3, ?3, ?4)",
            params![id, status, sequence_num, source_transport],
        )
        .expect("seed message");
    }
    conn.execute(
        "INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, content_json, status, sequence_num, created_at_ms, updated_at_ms,
            source_transport
         ) VALUES (
            'm4', 'session:one', 'human:relay', 'system', 'status',
            'Relay changed the session name to New chat',
            '{\"kind\":\"session-title-update\",\"scope\":\"session\",\"title\":\"New chat\"}',
            'complete', 4, 4, 4, 'cloud-group-session-title-update'
         )",
        [],
    )
    .expect("seed false placeholder rename notice");
    conn.execute(
        "INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:empty', 'group', 'New chat', 'active', 'human:me', 1, 4, 4)",
        [],
    )
    .expect("seed status-only session");
    conn.execute(
        "INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, content_json, status, sequence_num, created_at_ms, updated_at_ms,
            source_transport
         ) VALUES (
            'empty-notice', 'session:empty', 'human:relay', 'system', 'status',
            'Relay changed the session name to # New chat',
            '{\"kind\":\"session-title-update\",\"scope\":\"session\",\"title\":\"# New chat\"}',
            'complete', 1, 4, 4, 'cloud-group-session-title-update'
         )",
        [],
    )
    .expect("seed status-only false notice");

    let catalog = load_catalog_from_db(&conn).expect("load catalog");
    let populated_summary = catalog
        .summaries
        .iter()
        .find(|summary| summary.session_id == "session:one")
        .expect("populated summary");
    assert_eq!(populated_summary.message_count, 1);
    assert_eq!(
        populated_summary
            .latest_message
            .as_ref()
            .map(|message| message.id.as_str()),
        Some("m1")
    );
    let empty_summary = catalog
        .summaries
        .iter()
        .find(|summary| summary.session_id == "session:empty")
        .expect("status-only summary");
    assert_eq!(empty_summary.message_count, 0);
    assert!(empty_summary.latest_message.is_none());
    let page = load_message_page_from_db(&conn, "session:one", None, Some(25)).expect("load page");
    assert_eq!(
        page.messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        vec!["m1", "m2", "m3", "m4"]
    );
}
