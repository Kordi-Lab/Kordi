use super::*;
use crate::bridge::DesktopBridgeOutreachMetadata;

fn memory_conversation_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory bridge conversation db");
    init_conversation_schema(&conn).expect("init bridge conversation schema");
    conn
}

fn test_inbox_event(id: &str, server_message_id: Option<&str>) -> BridgeInboxEventInsert {
    BridgeInboxEventInsert {
        id: id.to_string(),
        server_message_id: server_message_id.map(ToString::to_string),
        host_id: "host-1".to_string(),
        from_node_id: "sender-1".to_string(),
        request_id: Some("req-1".to_string()),
        message_type: "local_agent_ask".to_string(),
        chat_queue_key: "chat:group-1".to_string(),
        requesting_user_key: "user:sender-1".to_string(),
        payload_json: "{\"text\":\"hello\"}".to_string(),
        status: "received".to_string(),
        received_at_ms: 1_000,
    }
}

fn test_agent_job(id: &str, inbox_event_id: &str) -> BridgeAgentJobInsert {
    BridgeAgentJobInsert {
        id: id.to_string(),
        inbox_event_id: inbox_event_id.to_string(),
        request_id: Some("req-1".to_string()),
        requesting_user_key: "user:sender-1".to_string(),
        chat_queue_key: "chat:group-1".to_string(),
        status: "queued".to_string(),
        created_at_ms: 1_100,
    }
}

#[test]
fn inbox_event_insert_is_idempotent_by_server_message_id() {
    let conn = memory_conversation_db();
    let first = test_inbox_event("evt-1", Some("server-msg-1"));
    let first_id =
        insert_bridge_inbox_event_if_absent(&conn, &first).expect("insert first inbox event");

    let mut duplicate = test_inbox_event("evt-duplicate", Some("server-msg-1"));
    duplicate.payload_json = "{\"text\":\"duplicate delivery\"}".to_string();
    let duplicate_id = insert_bridge_inbox_event_if_absent(&conn, &duplicate)
        .expect("dedupe duplicate inbox event");

    assert_eq!(first_id, "evt-1");
    assert_eq!(duplicate_id, "evt-1");
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM bridge_inbox_events WHERE host_id = ?1",
            rusqlite::params!["host-1"],
            |row| row.get(0),
        )
        .expect("count inbox events");
    assert_eq!(count, 1);
}

#[test]
fn agent_job_tracks_queued_running_and_terminal_statuses() {
    let conn = memory_conversation_db();
    let event = test_inbox_event("evt-1", Some("server-msg-1"));
    insert_bridge_inbox_event_if_absent(&conn, &event).expect("insert inbox event");
    let job = test_agent_job("job-1", "evt-1");
    create_bridge_agent_job_if_absent(&conn, &job).expect("create agent job");

    let queued = load_bridge_agent_job(&conn, "job-1")
        .expect("load queued job")
        .expect("queued job exists");
    assert_eq!(queued.status, "queued");
    assert_eq!(queued.retry_count, 0);

    mark_bridge_agent_job_running(&conn, "job-1", 1_200).expect("mark job running");
    let running = load_bridge_agent_job(&conn, "job-1")
        .expect("load running job")
        .expect("running job exists");
    assert_eq!(running.status, "running");
    assert_eq!(running.started_at_ms, Some(1_200));

    mark_bridge_agent_job_terminal(&conn, "job-1", "responded", 1_500, None)
        .expect("mark job terminal");
    let responded = load_bridge_agent_job(&conn, "job-1")
        .expect("load responded job")
        .expect("responded job exists");
    assert_eq!(responded.status, "responded");
    assert_eq!(responded.completed_at_ms, Some(1_500));
    assert_eq!(responded.last_error, None);
}

#[test]
fn queued_agent_jobs_resume_after_reopening_database() {
    let db_path = std::env::temp_dir().join(format!(
        "kordi-bridge-agent-jobs-{}.db",
        uuid::Uuid::new_v4()
    ));
    {
        let conn = Connection::open(&db_path).expect("open temporary conversation db");
        init_conversation_schema(&conn).expect("init conversation schema");
        let event = test_inbox_event("evt-1", Some("server-msg-1"));
        insert_bridge_inbox_event_if_absent(&conn, &event).expect("insert inbox event");
        let job = test_agent_job("job-1", "evt-1");
        create_bridge_agent_job_if_absent(&conn, &job).expect("create queued job");
    }

    let reopened = Connection::open(&db_path).expect("reopen temporary conversation db");
    init_conversation_schema(&reopened).expect("re-init conversation schema");
    let queued =
        list_runnable_bridge_agent_jobs(&reopened, 2_000, 10).expect("list runnable queued jobs");
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].id, "job-1");
    assert_eq!(queued[0].status, "queued");

    let _ = std::fs::remove_file(db_path);
}

fn test_conversation(
    messages: Vec<DesktopBridgeConversationMessageRecord>,
) -> DesktopBridgeConversationRecord {
    DesktopBridgeConversationRecord {
        id: "bridge:host-1:peer-1".to_string(),
        host_id: "host-1".to_string(),
        peer_node_id: "peer-1".to_string(),
        peer_display_name: Some("Peer".to_string()),
        peer_owner_name: Some("Owner".to_string()),
        peer_runtime: "person".to_string(),
        project_id: None,
        project_name: None,
        unread_count: 0,
        updated_at_ms: 1_000,
        peer_last_typing_at_ms: None,
        peer_last_heartbeat_at_ms: None,
        outreach: None,
        identity: None,
        messages,
    }
}

fn test_message(
    id: &str,
    direction: &str,
    text: &str,
    timestamp_ms: i64,
    request_id: Option<&str>,
    delivery_state: Option<&str>,
) -> DesktopBridgeConversationMessageRecord {
    DesktopBridgeConversationMessageRecord {
        id: id.to_string(),
        direction: direction.to_string(),
        sender: Some("sender".to_string()),
        text: text.to_string(),
        timestamp_ms,
        request_id: request_id.map(ToString::to_string),
        delivery_state: delivery_state.map(ToString::to_string),
        outreach: None,
        attachments: Vec::new(),
    }
}

fn test_outreach(request_id: &str, delivery_state: Option<&str>) -> DesktopBridgeOutreachMetadata {
    DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some("session:bridge:humans:test".to_string()),
        parent_session_title: Some("Humans".to_string()),
        parent_session_kind: None,
        parent_group_space_id: None,
        parent_session_participants: Vec::new(),
        parent_session_messages: Vec::new(),
        parent_turn_id: Some("turn-1".to_string()),
        parent_message_id: Some("parent-message-1".to_string()),
        bridge_host_id: "host-1".to_string(),
        bridge_conversation_id: Some("bridge:host-1:peer-1".to_string()),
        bridge_request_id: Some(request_id.to_string()),
        delivery_state: delivery_state.map(ToString::to_string),
        target_node_id: "peer-1".to_string(),
        target_human_id: Some("human-1".to_string()),
        target_agent_id: None,
        target_display_name: "Peer".to_string(),
        target_owner_name: Some("Owner".to_string()),
        target_runtime: Some("person".to_string()),
        request_text: "processing...".to_string(),
        trigger_text: None,
        context_text: None,
        context_policy: Some("session-relay".to_string()),
        project_id: None,
        project_name: None,
        status: "completed".to_string(),
        created_at_ms: 1_000,
        updated_at_ms: 1_000,
        completed_at_ms: Some(1_000),
        error: None,
    }
}

fn test_outreach_for_conversation(
    request_id: &str,
    conversation_id: &str,
    parent_turn_id: Option<&str>,
    delivery_state: Option<&str>,
) -> DesktopBridgeOutreachMetadata {
    let mut outreach = test_outreach(request_id, delivery_state);
    outreach.bridge_conversation_id = Some(conversation_id.to_string());
    outreach.parent_turn_id = parent_turn_id.map(ToString::to_string);
    outreach.context_policy = Some("session-relay".to_string());
    outreach.parent_session_id = Some("session:bridge:humans:test".to_string());
    outreach.target_kind = "bridge-person".to_string();
    outreach
}

fn bridge_person_conversation_id() -> &'static str {
    "bridge:host-1:peer-1:person"
}

fn bridge_base_conversation_id() -> &'static str {
    "bridge:host-1:peer-1"
}

#[test]
fn targeted_append_keeps_person_and_agent_threads_separate_for_same_node() {
    let conn = memory_conversation_db();
    let mut person = test_conversation(vec![test_message(
        "msg-person",
        "inbound",
        "human hello",
        1_000,
        Some("req-person"),
        None,
    )]);
    person.id = "bridge:host-1:peer-1:person".to_string();
    upsert_conversation_record(&conn, &person).expect("insert person conversation");

    append_conversation_message_to_db_for_test(
        &conn,
        "host-1",
        "peer-1",
        "kordi-desktop".to_string(),
        "agent hello".to_string(),
    )
    .expect("append agent conversation");

    let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
    assert_eq!(loaded.conversations.len(), 2);
    assert!(loaded.conversations.iter().any(|conversation| {
        conversation.id.ends_with(":person")
            && conversation
                .messages
                .iter()
                .any(|message| message.text == "human hello")
    }));
    assert!(loaded.conversations.iter().any(|conversation| {
        !conversation.id.ends_with(":person")
            && conversation.peer_runtime == "kordi-desktop"
            && conversation
                .messages
                .iter()
                .any(|message| message.text == "agent hello")
    }));
}

fn append_conversation_message_to_db_for_test(
    conn: &Connection,
    host_id: &str,
    peer_node_id: &str,
    peer_runtime: String,
    text: String,
) -> Result<(), String> {
    let timestamp_ms = now_ms();
    let mut conversation =
        find_conversation_for_peer(conn, host_id, peer_node_id, None, &peer_runtime)?
            .unwrap_or_else(|| DesktopBridgeConversationRecord {
                id: scoped_conversation_id(host_id, peer_node_id, None, &peer_runtime),
                host_id: host_id.to_string(),
                peer_node_id: peer_node_id.to_string(),
                peer_display_name: None,
                peer_owner_name: None,
                peer_runtime,
                project_id: None,
                project_name: None,
                unread_count: 0,
                updated_at_ms: timestamp_ms,
                peer_last_typing_at_ms: None,
                peer_last_heartbeat_at_ms: None,
                outreach: None,
                identity: None,
                messages: Vec::new(),
            });
    conversation
        .messages
        .push(DesktopBridgeConversationMessageRecord {
            id: "msg-agent".to_string(),
            direction: "inbound-response".to_string(),
            sender: Some("agent".to_string()),
            text,
            timestamp_ms,
            request_id: Some("req-agent".to_string()),
            delivery_state: Some("responded".to_string()),
            outreach: None,
            attachments: Vec::new(),
        });
    upsert_conversation_record(conn, &conversation)
}

#[test]
fn sqlite_upsert_preserves_messages_from_independent_writes() {
    let conn = memory_conversation_db();
    let first = test_conversation(vec![test_message(
        "msg-1",
        "outbound",
        "hello",
        1_000,
        Some("req-1"),
        Some("sent"),
    )]);
    let mut second = test_conversation(vec![test_message(
        "msg-2",
        "inbound-response",
        "hi back",
        1_100,
        Some("req-2"),
        Some("responded"),
    )]);
    second.updated_at_ms = 1_100;

    upsert_conversation_record(&conn, &first).expect("insert first write");
    upsert_conversation_record(&conn, &second).expect("merge second write");

    let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
    let messages = &loaded.conversations[0].messages;
    assert_eq!(messages.len(), 2);
    assert!(messages.iter().any(|message| message.text == "hello"));
    assert!(messages.iter().any(|message| message.text == "hi back"));
}

#[test]
fn sqlite_upsert_merges_streamed_response_by_request_and_direction() {
    let conn = memory_conversation_db();
    let partial = test_conversation(vec![test_message(
        "msg-partial",
        "outbound-response",
        "Hel",
        1_000,
        Some("req-stream"),
        Some("processing"),
    )]);
    let mut final_response = test_conversation(vec![test_message(
        "msg-final",
        "outbound-response",
        "Hello world",
        1_200,
        Some("req-stream"),
        Some("responded"),
    )]);
    final_response.updated_at_ms = 1_200;

    upsert_conversation_record(&conn, &partial).expect("insert partial response");
    upsert_conversation_record(&conn, &final_response).expect("upsert final response");

    let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
    let messages = &loaded.conversations[0].messages;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text, "Hello world");
    assert_eq!(messages[0].delivery_state.as_deref(), Some("responded"));
}

#[test]
fn sqlite_upsert_reconciles_message_outreach_delivery_state_with_final_response() {
    let conn = memory_conversation_db();
    let mut partial_message = test_message(
        "msg-partial",
        "outbound-response",
        "processing...",
        1_000,
        Some("req-stream"),
        Some("processing"),
    );
    partial_message.outreach = Some(test_outreach("req-stream", Some("processing")));
    let partial = test_conversation(vec![partial_message]);

    let mut final_response = test_conversation(vec![test_message(
        "msg-final",
        "outbound-response",
        "Hello world",
        1_200,
        Some("req-stream"),
        Some("responded"),
    )]);
    final_response.updated_at_ms = 1_200;

    upsert_conversation_record(&conn, &partial).expect("insert processing response");
    upsert_conversation_record(&conn, &final_response).expect("upsert final response");

    let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
    let message = &loaded.conversations[0].messages[0];
    let outreach = message.outreach.as_ref().expect("message outreach");
    assert_eq!(message.text, "Hello world");
    assert_eq!(message.delivery_state.as_deref(), Some("responded"));
    assert_eq!(outreach.delivery_state.as_deref(), Some("responded"));
    assert_eq!(outreach.status, "completed");
    assert!(outreach.request_text.is_empty());
}

#[test]
fn sqlite_upsert_keeps_delivery_state_monotonic() {
    let conn = memory_conversation_db();
    let responded = test_conversation(vec![test_message(
        "msg-1",
        "outbound",
        "hello",
        1_000,
        Some("req-1"),
        Some("responded"),
    )]);
    let mut later_read = test_conversation(vec![test_message(
        "msg-later",
        "outbound",
        "hello",
        1_100,
        Some("req-1"),
        Some("read"),
    )]);
    later_read.updated_at_ms = 1_100;

    upsert_conversation_record(&conn, &responded).expect("insert responded message");
    upsert_conversation_record(&conn, &later_read).expect("merge lower-ranked read state");

    let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
    let message = &loaded.conversations[0].messages[0];
    assert_eq!(message.delivery_state.as_deref(), Some("responded"));
}

#[test]
fn delivery_ack_does_not_turn_processing_response_into_plain_read_message() {
    let mut conn = memory_conversation_db();
    let conversation = test_conversation(vec![
        test_message(
            "msg-request",
            "inbound",
            "@MyKordi what do you think?",
            1_000,
            Some("req-agent"),
            Some("processing"),
        ),
        test_message(
            "msg-processing-response",
            "outbound-response",
            "processing...",
            1_100,
            Some("req-agent"),
            Some("processing"),
        ),
    ]);
    upsert_conversation_record(&conn, &conversation)
        .expect("insert processing request and response");

    update_message_delivery_state_in_db_for_test(&mut conn, "req-agent", "read")
        .expect("apply read delivery ack");

    let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
    let messages = &loaded.conversations[0].messages;
    let request = messages
        .iter()
        .find(|message| message.id == "msg-request")
        .expect("request row");
    let response = messages
        .iter()
        .find(|message| message.id == "msg-processing-response")
        .expect("response row");
    assert_eq!(request.delivery_state.as_deref(), Some("read"));
    assert_eq!(response.delivery_state.as_deref(), Some("processing"));
}

#[test]
fn sqlite_upsert_allows_newer_final_response_to_clear_typing() {
    let conn = memory_conversation_db();
    let mut processing = test_conversation(vec![test_message(
        "msg-1",
        "inbound-response",
        "Working",
        1_000,
        Some("req-1"),
        Some("processing"),
    )]);
    processing.peer_last_typing_at_ms = Some(1_000);
    let mut responded = test_conversation(vec![test_message(
        "msg-final",
        "inbound-response",
        "Done",
        1_200,
        Some("req-1"),
        Some("responded"),
    )]);
    responded.updated_at_ms = 1_200;
    responded.peer_last_typing_at_ms = None;

    upsert_conversation_record(&conn, &processing).expect("insert processing state");
    upsert_conversation_record(&conn, &responded).expect("merge final state");

    let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
    let conversation = &loaded.conversations[0];
    assert_eq!(conversation.peer_last_typing_at_ms, None);
    assert_eq!(
        conversation.messages[0].delivery_state.as_deref(),
        Some("responded")
    );
}

#[test]
fn repair_moves_inbound_session_relay_agent_response_into_person_thread() {
    let mut conn = memory_conversation_db();

    let mut person = test_conversation(vec![test_message(
        "msg-request",
        "inbound",
        "@MyKordi check my disk usage",
        1_000,
        Some("req-user"),
        None,
    )]);
    person.id = bridge_person_conversation_id().to_string();
    person.peer_runtime = "person".to_string();
    upsert_conversation_record(&conn, &person).expect("insert person thread");

    let mut response = test_message(
        "msg-response-wrong-thread",
        "inbound",
        "I tried to check disk usage with `df -h`.",
        1_200,
        Some("req-agent"),
        Some("responded"),
    );
    response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_base_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut base = test_conversation(vec![response]);
    base.id = bridge_base_conversation_id().to_string();
    base.peer_runtime = "kordi-desktop".to_string();
    upsert_conversation_record(&conn, &base).expect("insert wrong base thread");

    repair_split_bridge_person_session_relay_rows(&mut conn).expect("repair split rows");

    let loaded = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person conversation exists");
    assert!(person.messages.iter().any(|message| {
        message.id == "msg-response-wrong-thread"
            && message.direction == "inbound-response"
            && message
                .outreach
                .as_ref()
                .and_then(|outreach| outreach.bridge_conversation_id.as_deref())
                == Some(bridge_person_conversation_id())
    }));

    let base = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_base_conversation_id())
        .expect("base conversation preserved");
    assert!(!base
        .messages
        .iter()
        .any(|message| message.id == "msg-response-wrong-thread"));
}

#[test]
fn repair_moves_outbound_session_relay_agent_response_as_outbound_response() {
    let mut conn = memory_conversation_db();

    let mut response = test_message(
        "msg-outbound-response-wrong-thread",
        "outbound",
        "Final local answer",
        1_200,
        Some("req-agent"),
        Some("responded"),
    );
    response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_base_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut base = test_conversation(vec![response]);
    base.id = bridge_base_conversation_id().to_string();
    base.peer_runtime = "kordi-desktop".to_string();
    upsert_conversation_record(&conn, &base).expect("insert wrong base thread");

    repair_split_bridge_person_session_relay_rows(&mut conn).expect("repair split rows");

    let loaded = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person conversation created");
    assert_eq!(person.peer_runtime, "person");
    assert!(person.messages.iter().any(|message| {
        message.id == "msg-outbound-response-wrong-thread"
            && message.direction == "outbound-response"
            && message.text == "Final local answer"
    }));
}

#[test]
fn repair_normalizes_split_response_already_in_person_thread() {
    let mut conn = memory_conversation_db();

    let mut response = test_message(
        "msg-response-person-thread",
        "inbound",
        "Already in the person thread, but not marked as a response.",
        1_200,
        Some("req-agent"),
        Some("responded"),
    );
    response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_person_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut person = test_conversation(vec![response]);
    person.id = bridge_person_conversation_id().to_string();
    person.peer_runtime = "person".to_string();
    upsert_conversation_record(&conn, &person).expect("insert person response");

    repair_split_bridge_person_session_relay_rows(&mut conn).expect("repair split rows");

    let loaded = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person conversation exists");
    assert_eq!(person.messages.len(), 1);
    assert_eq!(person.messages[0].id, "msg-response-person-thread");
    assert_eq!(person.messages[0].direction, "inbound-response");
}

#[test]
fn repair_is_idempotent_and_merges_duplicate_target_response() {
    let mut conn = memory_conversation_db();

    let mut target_response = test_message(
        "msg-target-processing",
        "inbound-response",
        "processing...",
        1_000,
        Some("req-agent"),
        Some("processing"),
    );
    target_response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_person_conversation_id(),
        Some("turn-agent"),
        Some("processing"),
    ));
    let mut person = test_conversation(vec![target_response]);
    person.id = bridge_person_conversation_id().to_string();
    upsert_conversation_record(&conn, &person).expect("insert target processing row");

    let mut source_response = test_message(
        "msg-source-final",
        "inbound",
        "Final answer",
        1_500,
        Some("req-agent"),
        Some("responded"),
    );
    source_response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_base_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut base = test_conversation(vec![source_response]);
    base.id = bridge_base_conversation_id().to_string();
    base.peer_runtime = "kordi-desktop".to_string();
    upsert_conversation_record(&conn, &base).expect("insert source final row");

    repair_split_bridge_person_session_relay_rows(&mut conn).expect("first repair");
    repair_split_bridge_person_session_relay_rows(&mut conn).expect("second repair");

    let loaded = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = loaded
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person conversation exists");
    let responses = person
        .messages
        .iter()
        .filter(|message| {
            message.request_id.as_deref() == Some("req-agent")
                && message.direction == "inbound-response"
        })
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].text, "Final answer");
    assert_eq!(responses[0].delivery_state.as_deref(), Some("responded"));
}

#[test]
fn persisted_row_reconcile_path_repairs_split_session_relay_rows() {
    let mut conn = memory_conversation_db();

    let mut response = test_message(
        "msg-response-wrong-thread",
        "inbound",
        "Final answer",
        1_200,
        Some("req-agent"),
        Some("responded"),
    );
    response.outreach = Some(test_outreach_for_conversation(
        "req-agent",
        bridge_base_conversation_id(),
        Some("turn-agent"),
        Some("responded"),
    ));
    let mut base = test_conversation(vec![response]);
    base.id = bridge_base_conversation_id().to_string();
    base.peer_runtime = "kordi-desktop".to_string();
    upsert_conversation_record(&conn, &base).expect("insert split source row");

    reconcile_and_repair_persisted_conversation_rows(&mut conn)
        .expect("persisted row reconcile path repairs split row");

    let repaired = load_conversation_store_from_db(&conn).expect("load repaired store");
    let person = repaired
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_person_conversation_id())
        .expect("person thread exists after repair");
    assert_eq!(person.messages.len(), 1);
    assert_eq!(person.messages[0].direction, "inbound-response");
    assert_eq!(person.messages[0].text, "Final answer");

    let base = repaired
        .conversations
        .iter()
        .find(|conversation| conversation.id == bridge_base_conversation_id())
        .expect("base conversation preserved");
    assert!(base.messages.is_empty());
}

#[test]
fn bridge_store_export_redacts_api_keys() {
    let store = DesktopBridgeStore {
        active_host_id: Some("host-1".to_string()),
        local_agent_routing: Default::default(),
        hosts: vec![DesktopBridgeHostConfig {
            id: "host-1".to_string(),
            coordination: "https://bridge.example.com".to_string(),
            node_id: "node-1".to_string(),
            api_key: "test-host-key".to_string(),
            display_name: Some("Kordi".to_string()),
            owner: Some("User".to_string()),
            human_id: Some("kh_123".to_string()),
            discovery_mode: "contacts".to_string(),
            active_agent_id: Some("agent-1".to_string()),
            agents: vec![super::DesktopBridgeAgentConfig {
                id: "agent-1".to_string(),
                label: "Kordi".to_string(),
                node_id: "node-1".to_string(),
                api_key: "test-agent-key".to_string(),
                runtime: super::default_bridge_agent_runtime(),
                is_default: true,
                default_model: Some("openai/gpt-5.4".to_string()),
                default_auth_provider: Some("openai".to_string()),
                default_auth_choice: Some("env:api-key".to_string()),
                fallback_model: Some("anthropic/claude-sonnet-4.5".to_string()),
                fallback_auth_provider: Some("anthropic".to_string()),
                fallback_auth_choice: Some("profile:claude".to_string()),
                thinking: Some("high".to_string()),
            }],
            api_style: "serve".to_string(),
        }],
    };

    let exported = bridge_store_export(&store);
    let host = exported["hosts"]
        .as_array()
        .and_then(|hosts| hosts.first())
        .expect("host entry");
    let agent = host["agents"]
        .as_array()
        .and_then(|agents| agents.first())
        .expect("agent entry");

    assert_eq!(exported["credentialsRedacted"], serde_json::json!(true));
    assert_eq!(agent["defaultAuthProvider"], serde_json::json!("openai"));
    assert_eq!(agent["defaultAuthChoice"], serde_json::json!("env:api-key"));
    assert_eq!(
        agent["fallbackAuthProvider"],
        serde_json::json!("anthropic")
    );
    assert_eq!(
        agent["fallbackAuthChoice"],
        serde_json::json!("profile:claude")
    );
    assert!(host.get("apiKey").is_none());
    assert!(agent.get("apiKey").is_none());
}

#[test]
fn hydrate_bridge_store_secrets_restores_redacted_config() {
    let mut store = DesktopBridgeStore {
        active_host_id: Some("host-1".to_string()),
        local_agent_routing: Default::default(),
        hosts: vec![DesktopBridgeHostConfig {
            id: "host-1".to_string(),
            coordination: "https://bridge.example.com".to_string(),
            node_id: "node-1".to_string(),
            api_key: String::new(),
            display_name: Some("Kordi".to_string()),
            owner: Some("User".to_string()),
            human_id: Some("kh_123".to_string()),
            discovery_mode: "contacts".to_string(),
            active_agent_id: Some("agent-1".to_string()),
            agents: vec![super::DesktopBridgeAgentConfig {
                id: "agent-1".to_string(),
                label: "Kordi".to_string(),
                node_id: "node-1".to_string(),
                api_key: String::new(),
                runtime: super::default_bridge_agent_runtime(),
                is_default: true,
                default_model: None,
                default_auth_provider: None,
                default_auth_choice: None,
                fallback_model: None,
                fallback_auth_provider: None,
                fallback_auth_choice: None,
                thinking: None,
            }],
            api_style: "serve".to_string(),
        }],
    };
    let secrets = DesktopBridgeSecretsStore {
        host_api_keys: std::collections::HashMap::from([(
            "host-1".to_string(),
            "test-host-key".to_string(),
        )]),
        agent_api_keys: std::collections::HashMap::from([(
            "agent-1".to_string(),
            "test-agent-key".to_string(),
        )]),
    };

    assert!(!hydrate_bridge_store_secrets(&mut store, &secrets));
    assert_eq!(store.hosts[0].api_key, "test-host-key");
    assert_eq!(store.hosts[0].agents[0].api_key, "test-agent-key");
}
