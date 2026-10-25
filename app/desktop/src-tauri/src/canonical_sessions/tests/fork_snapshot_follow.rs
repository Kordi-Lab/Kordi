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

#[test]
fn a_fork_copy_of_a_running_reply_follows_its_source_until_it_finishes() {
    let _environment = crate::test_support::lock_process_environment();
    let conn = test_conn();
    append_message_in_db(
        &conn,
        reply("source-reply", "source-session", "processing", "", None),
    )
    .unwrap();
    let source = Some("fork-snapshot:session:fork:a:source-session:source-reply");
    append_message_in_db(
        &conn,
        reply("copy-running", "session:fork:a", "processing", "", source),
    )
    .unwrap();
    let finished_source = Some("fork-snapshot:session:fork:b:source-session:source-reply");
    append_message_in_db(
        &conn,
        reply(
            "copy-finished",
            "session:fork:b",
            "complete",
            "Kept answer",
            finished_source,
        ),
    )
    .unwrap();
    let other_source = Some("fork-snapshot:session:fork:c:source-session:other-reply");
    append_message_in_db(
        &conn,
        reply(
            "copy-other",
            "session:fork:c",
            "processing",
            "",
            other_source,
        ),
    )
    .unwrap();

    upsert_message_in_db(
        &conn,
        reply(
            "source-reply",
            "source-session",
            "complete",
            "Hey! What can I help with?",
            None,
        ),
    )
    .unwrap();

    let running = select_message(&conn, "copy-running").unwrap().unwrap();
    assert_eq!(running.status, "complete");
    assert_eq!(running.content_text, "Hey! What can I help with?");
    assert_eq!(
        running.content,
        Some(serde_json::json!({ "deliveryState": "complete" }))
    );
    assert_eq!(running.session_id, "session:fork:a");
    assert_eq!(running.source_event_id.as_deref(), source);
    let finished = select_message(&conn, "copy-finished").unwrap().unwrap();
    assert_eq!(finished.content_text, "Kept answer");
    let other = select_message(&conn, "copy-other").unwrap().unwrap();
    assert_eq!(other.status, "processing");
}
