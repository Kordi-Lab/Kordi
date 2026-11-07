use super::*;

fn open_group(conn: &Connection) -> CanonicalSession {
    open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some("session:lifecycle".to_string()),
            kind: "group".to_string(),
            title: Some("Lifecycle".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: None,
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: Vec::new(),
            metadata: None,
        },
    )
    .expect("open lifecycle session")
}

fn agent_turn_request(session_id: &str, status: &str, text: &str) -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some("msg:cloud-agent-processing:request:one:account:agent".to_string()),
        session_id: session_id.to_string(),
        sender_identity_id: "agent:cloud:account:agent".to_string(),
        sender_role: "owned-agent".to_string(),
        message_kind: "agent-turn".to_string(),
        content_text: text.to_string(),
        content: Some(serde_json::json!({
            "deliveryState": status,
            "requestId": "request:one",
        })),
        parent_message_id: Some("request:one".to_string()),
        delegated_exchange_id: None,
        status: Some(status.to_string()),
        created_at_ms: Some(1_000),
        source_transport: Some("cloud-group-agent".to_string()),
        source_event_id: Some("cloud-group-agent:stable-slot".to_string()),
    }
}

#[test]
fn persisted_agent_turn_can_move_from_processing_to_complete() {
    let conn = test_conn();
    let session = open_group(&conn);
    append_message_in_db(
        &conn,
        agent_turn_request(&session.id, "processing", "processing..."),
    )
    .expect("append processing turn");

    let mut completion = agent_turn_request(&session.id, "complete", "Finished answer");
    completion.created_at_ms = Some(5_000);
    let complete = upsert_message_in_db(&conn, completion).expect("complete turn");

    assert_eq!(complete.status, "complete");
    assert_eq!(complete.content_text, "Finished answer");
    assert_eq!(complete.created_at_ms, 1_000);
}

#[test]
fn persisted_terminal_agent_turn_rejects_a_newer_processing_replay() {
    let conn = test_conn();
    let session = open_group(&conn);
    append_message_in_db(
        &conn,
        agent_turn_request(&session.id, "processing", "processing..."),
    )
    .expect("append processing turn");
    let terminal = upsert_message_in_db(
        &conn,
        agent_turn_request(&session.id, "complete", "Finished answer"),
    )
    .expect("complete turn");

    let replayed = upsert_message_in_db(
        &conn,
        agent_turn_request(&session.id, "processing", "processing..."),
    )
    .expect("replay processing turn");
    let persisted = select_message(&conn, &terminal.id)
        .expect("select terminal turn")
        .expect("terminal turn exists");

    assert_eq!(replayed.status, "complete");
    assert_eq!(replayed.content_text, "Finished answer");
    assert_eq!(persisted.status, "complete");
    assert_eq!(persisted.content_text, "Finished answer");
}

#[test]
fn persisted_failed_agent_turn_cannot_be_reopened_by_processing() {
    let conn = test_conn();
    let session = open_group(&conn);
    append_message_in_db(
        &conn,
        agent_turn_request(&session.id, "processing", "processing..."),
    )
    .expect("append processing turn");
    upsert_message_in_db(
        &conn,
        agent_turn_request(&session.id, "failed", "Provider unavailable"),
    )
    .expect("fail turn");

    let replayed = upsert_message_in_db(
        &conn,
        agent_turn_request(&session.id, "processing", "processing..."),
    )
    .expect("replay processing turn");

    assert_eq!(replayed.status, "failed");
    assert_eq!(replayed.content_text, "Provider unavailable");
}

#[test]
fn persisted_failed_agent_turn_can_be_repaired_by_a_complete_response() {
    let conn = test_conn();
    let session = open_group(&conn);
    append_message_in_db(
        &conn,
        agent_turn_request(&session.id, "failed", "Provider unavailable"),
    )
    .expect("fail turn");

    let repaired = upsert_message_in_db(
        &conn,
        agent_turn_request(&session.id, "complete", "Finished on owner device"),
    )
    .expect("repair failed turn");
    let replayed_failure = upsert_message_in_db(
        &conn,
        agent_turn_request(&session.id, "failed", "Stale fallback failure"),
    )
    .expect("replay stale failure");

    assert_eq!(repaired.status, "complete");
    assert_eq!(repaired.content_text, "Finished on owner device");
    assert_eq!(replayed_failure.status, "complete");
    assert_eq!(replayed_failure.content_text, "Finished on owner device");
}

#[test]
fn persisted_terminal_agent_turn_rejects_unknown_status_replay() {
    let conn = test_conn();
    let session = open_group(&conn);
    append_message_in_db(
        &conn,
        agent_turn_request(&session.id, "complete", "Finished answer"),
    )
    .expect("append complete turn");

    let replayed = upsert_message_in_db(&conn, agent_turn_request(&session.id, "sent", ""))
        .expect("replay malformed turn");

    assert_eq!(replayed.status, "complete");
    assert_eq!(replayed.content_text, "Finished answer");
}

fn self_agent_reply(session_id: &str, content: serde_json::Value) -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some("msg:cloud:self:response:entry-request".to_string()),
        session_id: session_id.to_string(),
        sender_identity_id: "agent:cloud-self:account".to_string(),
        sender_role: "owned-agent".to_string(),
        message_kind: "text".to_string(),
        content_text: "Here is the plan".to_string(),
        content: Some(content),
        parent_message_id: None,
        delegated_exchange_id: None,
        status: Some("sent".to_string()),
        created_at_ms: Some(1_000),
        source_transport: None,
        source_event_id: None,
    }
}

#[test]
fn upsert_keeps_desktop_entry_alias_unless_the_update_sets_one() {
    let conn = test_conn();
    let session = open_group(&conn);
    append_message_in_db(
        &conn,
        self_agent_reply(
            &session.id,
            serde_json::json!({
                "cloudRequestMessageId": "entry-request",
                "desktopEntryId": "entry-assistant",
            }),
        ),
    )
    .expect("append reply");

    let cloud_only = self_agent_reply(
        &session.id,
        serde_json::json!({
            "cloudRequestMessageId": "entry-request",
            "deliveryState": "complete",
        }),
    );
    let updated = upsert_message_in_db(&conn, cloud_only.clone()).expect("cloud update");
    let expected_content = serde_json::json!({
        "cloudRequestMessageId": "entry-request",
        "deliveryState": "complete",
        "desktopEntryId": "entry-assistant",
    });
    assert_eq!(updated.content, Some(expected_content.clone()));
    let expected_hash = hash_hex(
        &format!(
            "{}|{}",
            updated.content_text,
            json_to_db(&Some(expected_content)).unwrap().unwrap()
        ),
        16,
    );
    assert_eq!(
        updated.content_hash.as_deref(),
        Some(expected_hash.as_str())
    );

    let replayed = upsert_message_in_db(&conn, cloud_only).expect("identical replay");
    assert_eq!(replayed.updated_at_ms, updated.updated_at_ms);
    assert_eq!(replayed.content, updated.content);

    let relinked = upsert_message_in_db(
        &conn,
        self_agent_reply(
            &session.id,
            serde_json::json!({
                "cloudRequestMessageId": "entry-request",
                "desktopEntryId": "entry-newer",
            }),
        ),
    )
    .expect("relink update");
    assert_eq!(
        relinked.content.as_ref().unwrap()["desktopEntryId"],
        "entry-newer"
    );
}
