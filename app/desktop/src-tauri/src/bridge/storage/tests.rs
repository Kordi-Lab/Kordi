use super::*;
use crate::bridge::DesktopBridgeOutreachMetadata;

fn memory_conversation_db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory bridge conversation db");
    init_conversation_schema(&conn).expect("init bridge conversation schema");
    conn
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
    }
}

fn test_outreach(request_id: &str, delivery_state: Option<&str>) -> DesktopBridgeOutreachMetadata {
    DesktopBridgeOutreachMetadata {
        target_kind: "bridge-person".to_string(),
        parent_session_id: Some("session:bridge:humans:test".to_string()),
        parent_session_title: Some("Humans".to_string()),
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
fn bridge_store_export_redacts_api_keys() {
    let store = DesktopBridgeStore {
        active_host_id: Some("host-1".to_string()),
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
    assert!(host.get("apiKey").is_none());
    assert!(agent.get("apiKey").is_none());
}

#[test]
fn hydrate_bridge_store_secrets_restores_redacted_config() {
    let mut store = DesktopBridgeStore {
        active_host_id: Some("host-1".to_string()),
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
