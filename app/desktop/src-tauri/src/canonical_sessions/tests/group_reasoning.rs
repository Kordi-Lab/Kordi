use super::*;

fn group_reasoning_request(parent: &str, thinking: Option<&str>) -> AppendCanonicalMessageRequest {
    AppendCanonicalMessageRequest {
        id: Some("group-response".into()),
        session_id: "group-session".into(),
        sender_identity_id: "group-agent".into(),
        sender_role: "owned-agent".into(),
        message_kind: "agent-turn".into(),
        content_text: "Public reply".into(),
        content: Some(
            serde_json::json!({ "thinkingText": thinking, "deliveryState": "processing" }),
        ),
        parent_message_id: Some(parent.into()),
        delegated_exchange_id: None,
        status: Some("processing".into()),
        created_at_ms: Some(1_000),
        source_transport: Some("cloud-group-agent".into()),
        source_event_id: Some("group-response-event".into()),
    }
}

fn owner_connection(owner: bool) -> Connection {
    let conn = test_conn();
    seed_identity(&conn, "human:viewer", "Viewer", "human");
    seed_identity(&conn, "human:peer", "Peer", "human");
    conn.execute(
        "UPDATE local_profile SET human_identity_id='human:viewer'",
        [],
    )
    .unwrap();
    seed_identity_with_source(
        &conn,
        "group-agent",
        "Synthetic Agent",
        "agent",
        "cloud",
        Some(if owner { "human:viewer" } else { "human:peer" }),
    );
    conn
}

#[test]
fn group_owner_reasoning_survives_public_progress_completion_and_reload() {
    let conn = owner_connection(true);
    append_message_in_db(
        &conn,
        group_reasoning_request("request-a", Some("Synthetic private reasoning")),
    )
    .unwrap();
    for status in ["processing", "complete", "received"] {
        let mut request = group_reasoning_request("request-a", None);
        request.status = Some(status.into());
        request.content = Some(
            serde_json::json!({ "deliveryState": if status == "received" { "complete" } else { status } }),
        );
        upsert_message_in_db(&conn, request).unwrap();
        let stored = select_message(&conn, "group-response").unwrap().unwrap();
        assert_eq!(
            stored.content.unwrap()["thinkingText"],
            "Synthetic private reasoning"
        );
    }
}

#[test]
fn group_non_owner_never_stores_reasoning_even_with_an_owned_role_hint() {
    let conn = owner_connection(false);
    let mut request = group_reasoning_request("request-a", Some("Synthetic private reasoning"));
    request.content.as_mut().unwrap()["execution"] = serde_json::json!({
        "thinkingText": "Nested private reasoning", "steps": [{"id":"analysis","label":"Private detail"}],
    });
    let stored = append_message_in_db(&conn, request.clone()).unwrap();
    assert!(!stored
        .content
        .unwrap()
        .to_string()
        .contains("private reasoning"));
    request.status = Some("complete".into());
    let updated = upsert_message_in_db(&conn, request).unwrap();
    assert!(!updated
        .content
        .unwrap()
        .to_string()
        .contains("Private detail"));
}

#[test]
fn group_reasoning_does_not_move_to_another_request() {
    let conn = owner_connection(true);
    append_message_in_db(
        &conn,
        group_reasoning_request("request-a", Some("Earlier private reasoning")),
    )
    .unwrap();
    let stored = upsert_message_in_db(&conn, group_reasoning_request("request-b", None)).unwrap();
    assert!(stored.content.unwrap()["thinkingText"].is_null());
}
