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
    let _environment = crate::test_support::lock_process_environment();
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
    let _environment = crate::test_support::lock_process_environment();
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
    let _environment = crate::test_support::lock_process_environment();
    let conn = owner_connection(true);
    append_message_in_db(
        &conn,
        group_reasoning_request("request-a", Some("Earlier private reasoning")),
    )
    .unwrap();
    let stored = upsert_message_in_db(&conn, group_reasoning_request("request-b", None)).unwrap();
    assert!(stored.content.unwrap()["thinkingText"].is_null());
}

#[test]
fn group_owner_tool_only_trace_survives_answer_only_public_sync() {
    let _environment = crate::test_support::lock_process_environment();
    let conn = owner_connection(true);
    let tools = serde_json::json!([
        {"id":"read-1","name":"read","status":"complete","arguments":"example.md","liveOutput":"First local result","isError":false},
        {"id":"read-2","name":"read","status":"complete","arguments":"notes.md","liveOutput":"Second local result","isError":false}
    ]);
    let mut local = group_reasoning_request("request-a", None);
    local.status = Some("complete".into());
    local.content = Some(serde_json::json!({"deliveryState":"complete","tools":tools}));
    append_message_in_db(&conn, local).unwrap();
    for version in 1..=3 {
        let mut public = group_reasoning_request("request-a", None);
        public.status = Some("received".into());
        public.content = Some(
            serde_json::json!({"deliveryState":"complete","cloudMessageVersion":version,"tools":[]}),
        );
        let stored = upsert_message_in_db(&conn, public).unwrap();
        assert_eq!(stored.content.unwrap()["tools"], tools);
    }
}

#[test]
fn group_peer_keeps_only_explicit_public_background_task_tools() {
    let _environment = crate::test_support::lock_process_environment();
    let conn = owner_connection(false);
    let mut request = group_reasoning_request("request-a", None);
    request.content = Some(serde_json::json!({"tools":[
        {"id":"private-read","name":"read","arguments":"Synthetic private input"},
        {"id":"background-session:public-task","name":"task_operator","arguments":"Public task"}
    ]}));
    let stored = append_message_in_db(&conn, request).unwrap();
    let content = stored.content.unwrap();
    let tools = content["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["id"], "background-session:public-task");
    assert!(!content.to_string().contains("Synthetic private input"));
}

#[test]
fn group_public_task_summary_does_not_replace_the_owners_full_trace() {
    let _environment = crate::test_support::lock_process_environment();
    let conn = owner_connection(true);
    let private_tools =
        serde_json::json!([{"id":"native-task","name":"task_operator","arguments":"Owner detail"}]);
    let mut local = group_reasoning_request("request-a", None);
    local.content = Some(serde_json::json!({"tools":private_tools}));
    append_message_in_db(&conn, local).unwrap();
    let mut public = group_reasoning_request("request-a", None);
    public.content = Some(
        serde_json::json!({"cloudMessageVersion":2,"tools":[{"id":"background-session:public-task","name":"task_operator"}]}),
    );
    let stored = upsert_message_in_db(&conn, public).unwrap();
    assert_eq!(stored.content.unwrap()["tools"], private_tools);
}

#[test]
fn group_tool_trace_does_not_move_to_another_request() {
    let _environment = crate::test_support::lock_process_environment();
    let conn = owner_connection(true);
    let mut local = group_reasoning_request("request-a", None);
    local.content = Some(serde_json::json!({"tools":[{"id":"private-read","name":"read"}]}));
    append_message_in_db(&conn, local).unwrap();
    let stored = upsert_message_in_db(&conn, group_reasoning_request("request-b", None)).unwrap();
    assert!(stored.content.unwrap()["tools"].is_null());
}
