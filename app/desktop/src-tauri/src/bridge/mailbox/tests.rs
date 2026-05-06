use super::*;
use crate::bridge::constants::BRIDGE_MESSAGE_TYPE_RAW;
use crate::bridge::DesktopBridgeAgentConfig;

fn test_mailbox_target() -> LocalBridgeMailboxTarget {
    LocalBridgeMailboxTarget {
        host: DesktopBridgeHostConfig {
            id: "bridge-host".to_string(),
            coordination: "https://bridge.test".to_string(),
            node_id: "local-agent-node".to_string(),
            api_key: "api-key".to_string(),
            display_name: Some("Local Kordi".to_string()),
            owner: Some("Local".to_string()),
            human_id: Some("human-local".to_string()),
            discovery_mode: "open".to_string(),
            human_visibility_policy: "server-approval".to_string(),
            contact_approval_policy: "approval-required".to_string(),
            active_agent_id: Some("agent-local".to_string()),
            agents: vec![],
            api_style: "serve".to_string(),
        },
        sender_runtime: "kordi-desktop".to_string(),
        sender_agent_id: Some("agent-local".to_string()),
        owner_node_id: Some("owner-node".to_string()),
        model_routing: None,
        should_process_agent_asks: true,
    }
}

fn parsed_event(
    message_type: &str,
    from_runtime: Option<&str>,
    parent_turn_id: Option<&str>,
) -> ParsedMailboxEvent {
    let mut session_thread = serde_json::json!({
        "parentSessionId": "session-1",
        "targetKind": "bridge-person",
        "targetDisplayName": "Peer",
    });
    if let Some(parent_turn_id) = parent_turn_id {
        session_thread["parentTurnId"] = serde_json::json!(parent_turn_id);
    }

    ParsedMailboxEvent {
        from_node_id: "peer-node".to_string(),
        from_display_name: Some("Peer's Kordi".to_string()),
        from_owner_name: Some("Peer".to_string()),
        from_runtime: from_runtime.map(ToString::to_string),
        from_human_id: Some("human-peer".to_string()),
        from_agent_id: Some("agent-peer".to_string()),
        message_type: message_type.to_string(),
        payload: serde_json::json!({
            "message": "agent reply",
            "sessionThread": session_thread,
        }),
        request_id: Some("bridge_req_1".to_string()),
        project_id: None,
        sent_at_ms: None,
    }
}

#[tokio::test]
async fn inbound_mailbox_messages_keep_sender_timestamp() {
    let storage =
        crate::test_support::ScopedKordiStorageRoot::new("kordi-mailbox-sender-time-test");

    let target = test_mailbox_target();
    let mut event = parsed_event(BRIDGE_MESSAGE_TYPE_RAW, Some("person"), None);
    event.payload["message"] = serde_json::json!("hello from peer");
    event.sent_at_ms = Some(1_777_000_001_234);

    apply_bridge_event_to_storage(&target.host, event, false)
        .await
        .expect("apply event");

    let store = load_conversation_store();
    let message = store.conversations[0]
        .messages
        .iter()
        .find(|message| message.text == "hello from peer")
        .expect("stored message");
    assert_eq!(message.timestamp_ms, 1_777_000_001_234);

    drop(storage);
}

#[test]
fn mailbox_agent_ask_queue_records_use_server_message_and_chat_keys() {
    let target = test_mailbox_target();
    let event = parsed_event(BRIDGE_MESSAGE_TYPE_ASK, Some("person"), None);

    let (inbox, job) =
        bridge_agent_queue_records_for_event(&target.host.id, &event, Some("server-msg-1"), 1_000);
    assert_eq!(inbox.server_message_id.as_deref(), Some("server-msg-1"));
    assert_eq!(inbox.host_id, "bridge-host");
    assert_eq!(inbox.from_node_id, "peer-node");
    assert_eq!(inbox.request_id.as_deref(), Some("bridge_req_1"));
    assert_eq!(inbox.message_type, BRIDGE_MESSAGE_TYPE_ASK);
    assert_eq!(inbox.chat_queue_key, "session:session-1");
    assert_eq!(inbox.requesting_user_key, "human:human-peer");
    assert_eq!(inbox.status, "received");

    assert_eq!(job.inbox_event_id, inbox.id);
    assert_eq!(job.request_id.as_deref(), Some("bridge_req_1"));
    assert_eq!(job.chat_queue_key, "session:session-1");
    assert_eq!(job.requesting_user_key, "human:human-peer");
    assert_eq!(job.status, "queued");
}

#[test]
fn session_relay_parent_turn_stays_in_person_thread_as_agent_response() {
    let event = parsed_event(
        BRIDGE_MESSAGE_TYPE_RAW,
        Some("kordi-desktop"),
        Some("turn-1"),
    );

    assert_eq!(
        storage_peer_runtime_for_inbound_event(&event, None),
        "person"
    );
    assert_eq!(
        sender_runtime_for_inbound_event(&event, "person"),
        "kordi-desktop"
    );
    assert_eq!(
        direction_for_inbound_event(&event),
        BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
    );
}

#[test]
fn session_relay_human_message_stays_in_person_thread_as_human_message() {
    let event = parsed_event(BRIDGE_MESSAGE_TYPE_RAW, Some("person"), None);

    assert_eq!(
        storage_peer_runtime_for_inbound_event(&event, None),
        "person"
    );
    assert_eq!(sender_runtime_for_inbound_event(&event, "person"), "person");
    assert_eq!(
        direction_for_inbound_event(&event),
        BRIDGE_MESSAGE_DIRECTION_INBOUND
    );
}

#[test]
fn response_events_remain_agent_responses() {
    let event = parsed_event(BRIDGE_MESSAGE_TYPE_RESPONSE, Some("kordi-desktop"), None);

    assert_eq!(
        direction_for_inbound_event(&event),
        BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
    );
}

#[test]
fn response_outreach_metadata_uses_session_thread_context_policy() {
    let mut event = parsed_event(BRIDGE_MESSAGE_TYPE_RESPONSE, Some("kordi-desktop"), None);
    event.payload["sessionThread"]["contextPolicy"] = serde_json::json!("session-message");
    event.payload["sessionThread"]["targetKind"] = serde_json::json!("bridge-agent");
    event.payload["sessionThread"]["targetDisplayName"] = serde_json::json!("Peer's Kordi");

    let host = DesktopBridgeHostConfig {
        id: "bridge-host".to_string(),
        coordination: "https://bridge.test".to_string(),
        node_id: "local-node".to_string(),
        api_key: "api-key".to_string(),
        display_name: Some("Local Kordi".to_string()),
        owner: Some("Local".to_string()),
        human_id: Some("human-local".to_string()),
        discovery_mode: "open".to_string(),
        human_visibility_policy: "server-approval".to_string(),
        contact_approval_policy: "approval-required".to_string(),
        active_agent_id: Some("agent-local".to_string()),
        agents: vec![DesktopBridgeAgentConfig {
            id: "agent-local".to_string(),
            label: "Local Kordi".to_string(),
            node_id: "local-node".to_string(),
            api_key: "agent-key".to_string(),
            runtime: "kordi-desktop".to_string(),
            is_default: true,
            default_model: None,
            default_auth_provider: None,
            default_auth_choice: None,
            fallback_model: None,
            fallback_auth_provider: None,
            fallback_auth_choice: None,
            thinking: None,
            reachability_policy: "contacts".to_string(),
        }],
        api_style: "serve".to_string(),
    };

    let outreach =
        outreach_metadata_for_event(&host, &event, "kordi-desktop").expect("outreach metadata");

    assert_eq!(outreach.context_policy.as_deref(), Some("session-message"));
}

#[test]
fn mailbox_poll_uses_legacy_drain_only_when_ack_endpoint_is_missing() {
    assert!(should_fallback_to_legacy_mailbox_fetch(
        "Unable to poll bridge mailbox: HTTP 404 Not Found"
    ));
    assert!(should_fallback_to_legacy_mailbox_fetch(
        "Unable to poll bridge mailbox: HTTP 405 Method Not Allowed"
    ));
    assert!(should_fallback_to_legacy_mailbox_fetch(
        "Unable to poll bridge mailbox: HTTP 501 Not Implemented"
    ));
    assert!(!should_fallback_to_legacy_mailbox_fetch(
        "Unable to poll bridge mailbox: HTTP 500 Internal Server Error"
    ));
    assert!(!should_fallback_to_legacy_mailbox_fetch(
        "Unable to poll bridge mailbox: connection reset"
    ));
}

#[test]
fn group_processing_response_is_not_buffered_as_typing_only() {
    let mut event = parsed_event(BRIDGE_MESSAGE_TYPE_RESPONSE, Some("kordi-desktop"), None);
    event.payload["message"] = serde_json::json!("processing...");
    event.payload["done"] = serde_json::json!(false);
    event.payload["sessionThread"]["parentSessionKind"] = serde_json::json!("group");
    event.payload["sessionThread"]["parentGroupSpaceId"] = serde_json::json!("session:group:root");

    assert!(!should_buffer_partial_agent_response(&event));
}

fn group_agent_ask_event() -> ParsedMailboxEvent {
    let mut event = parsed_event(BRIDGE_MESSAGE_TYPE_ASK, Some("person"), None);
    event.payload["sessionThread"]["parentSessionKind"] = serde_json::json!("group");
    event.payload["sessionThread"]["parentGroupSpaceId"] = serde_json::json!("session:group:root");
    event.payload["sessionThread"]["participants"] = serde_json::json!([
        { "displayName": "Requester", "bridgeNodeId": "peer-node" },
        { "displayName": "Agent owner", "bridgeNodeId": "owner-node" },
        { "displayName": "Other", "bridgeNodeId": "node-other" }
    ]);
    event
}

#[test]
fn mailbox_group_agent_response_targets_other_group_members() {
    let event = group_agent_ask_event();

    assert_eq!(
        group_session_thread_relay_targets(
            &event,
            "local-agent-node",
            Some("owner-node"),
            "peer-node"
        ),
        vec!["node-other".to_string()]
    );
}

#[test]
fn mailbox_group_agent_response_delivery_targets_include_requester_and_other_members() {
    let target = test_mailbox_target();
    let event = group_agent_ask_event();

    assert_eq!(
        group_agent_response_delivery_targets(&target, &event),
        vec!["peer-node".to_string(), "node-other".to_string()]
    );
}

#[test]
fn mailbox_group_agent_response_delivery_targets_skip_self_requester() {
    let target = test_mailbox_target();
    let mut event = group_agent_ask_event();
    event.from_node_id = target.host.node_id.clone();
    event.payload["sessionThread"]["participants"] = serde_json::json!([
        { "displayName": "Self", "bridgeNodeId": target.host.node_id.clone() },
        { "displayName": "Other", "bridgeNodeId": "node-other" }
    ]);

    assert_eq!(
        group_agent_response_delivery_targets(&target, &event),
        vec!["node-other".to_string()]
    );
}
