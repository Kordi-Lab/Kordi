use super::*;

fn reply(
    id: &str,
    session_id: &str,
    status: &str,
    text: &str,
    source: Option<&str>,
) -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some(id.into()),
        session_id: session_id.into(),
        sender_identity_id: "agent:self".into(),
        sender_role: "owned-agent".into(),
        message_kind: "agent-turn".into(),
        content_text: text.into(),
        content: Some(serde_json::json!({ "deliveryState": status })),
        parent_message_id: None,
        delegated_exchange_id: None,
        status: Some(status.into()),
        created_at_ms: Some(1_000),
        source_transport: source.map(|_| "canonical-fork-snapshot".into()),
        source_event_id: source.map(Into::into),
    }
}

fn fork_session(conn: &Connection, id: &str, parent: &str) {
    conn.execute(
        "INSERT INTO sessions(id, kind, title, created_by_identity_id, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?1, 'self-agent', 'Fork', 'human:me', ?2, 1, 1)",
        params![id, serde_json::json!({ "fork": { "forkedFromSessionId": parent } }).to_string()],
    )
    .unwrap();
}

#[test]
fn a_fork_copy_of_a_running_reply_follows_its_source_until_it_finishes() {
    let _environment = crate::test_support::lock_process_environment();
    let conn = test_conn();
    for (fork, parent) in [
        ("session:fork:a", "source-session"),
        ("session:fork:b", "source-session"),
        ("session:fork:c", "source-session"),
        ("session:fork:a2", "session:fork:a"),
    ] {
        fork_session(&conn, fork, parent);
    }
    append_message_in_db(
        &conn,
        reply("source-reply", "source-session", "processing", "", None),
    )
    .unwrap();
    let running = Some("fork-snapshot:session:fork:a:source-session:source-reply");
    append_message_in_db(
        &conn,
        reply("copy-running", "session:fork:a", "processing", "", running),
    )
    .unwrap();
    let nested = Some("fork-snapshot:session:fork:a2:session:fork:a:copy-running");
    append_message_in_db(
        &conn,
        reply("copy-nested", "session:fork:a2", "processing", "", nested),
    )
    .unwrap();
    let finished = Some("fork-snapshot:session:fork:b:source-session:source-reply");
    append_message_in_db(
        &conn,
        reply(
            "copy-finished",
            "session:fork:b",
            "complete",
            "Kept answer",
            finished,
        ),
    )
    .unwrap();
    let other = Some("fork-snapshot:session:fork:c:source-session:other-reply");
    append_message_in_db(
        &conn,
        reply("copy-other", "session:fork:c", "processing", "", other),
    )
    .unwrap();

    let answer = "Hey! What can I help with?";
    upsert_message_in_db(
        &conn,
        reply("source-reply", "source-session", "complete", answer, None),
    )
    .unwrap();

    for id in ["copy-running", "copy-nested"] {
        let copy = select_message(&conn, id).unwrap().unwrap();
        assert_eq!(copy.status, "complete", "{id}");
        assert_eq!(copy.content_text, answer, "{id}");
        assert_eq!(
            copy.content,
            Some(serde_json::json!({ "deliveryState": "complete" }))
        );
    }
    let copy = select_message(&conn, "copy-running").unwrap().unwrap();
    assert_eq!(copy.session_id, "session:fork:a");
    assert_eq!(copy.source_event_id.as_deref(), running);
    assert_eq!(
        select_message(&conn, "copy-finished")
            .unwrap()
            .unwrap()
            .content_text,
        "Kept answer"
    );
    assert_eq!(
        select_message(&conn, "copy-other").unwrap().unwrap().status,
        "processing"
    );
}
