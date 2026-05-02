use serde_json::Value;
use tauri::Manager;

use crate::chat::DesktopChatManager;

use super::super::agent_jobs::bridge_agent_queue_records_for_event;

use super::super::constants::{
    BRIDGE_DELIVERY_STATE_DELIVERED, BRIDGE_DELIVERY_STATE_RESPONDED,
    BRIDGE_MESSAGE_DIRECTION_INBOUND, BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
    BRIDGE_MESSAGE_TYPE_ASK, BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_RESPONSE,
    DEFAULT_BRIDGE_RUNTIME,
};
use super::super::events::{
    identity_snapshot_for_event, mailbox_payload_attachments, mailbox_payload_text,
    outreach_metadata_for_event, parse_bridge_event_payload, sender_name_for_runtime,
    ParsedMailboxEvent,
};
use super::super::mailbox::apply_bridge_event_to_storage;
use super::super::{
    append_conversation_message_to_storage, decrypt_bridge_payload_for_host, load_bridge_store,
    now_ms, record_bridge_inbox_event_and_agent_job, update_message_delivery_state_in_storage,
    BridgeAgentJobInsert, BridgeInboxEventInsert, DesktopBridgeConversationStore,
    DesktopBridgeManager, DesktopBridgeMessageAttachment, LocalBridgeServerRuntime,
};
use super::{
    emit_after_storage_write, emit_bridge_state, send_realtime_or_relay, LocalRealtimeTarget,
};

fn realtime_delivery_ack_payload(
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
) -> Option<Value> {
    if event.message_type == BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT
        || event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE
    {
        return None;
    }

    let request_id = event
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    Some(serde_json::json!({
        "from": target.host.node_id,
        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
        "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_DELIVERED },
    }))
}

fn event_session_thread(event: &ParsedMailboxEvent) -> Option<&Value> {
    event.payload.get("sessionThread")
}

fn event_targets_group_session(event: &ParsedMailboxEvent) -> bool {
    let Some(thread) = event_session_thread(event) else {
        return false;
    };
    thread
        .get("parentSessionKind")
        .and_then(|value| value.as_str())
        .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
        || thread
            .get("parentGroupSpaceId")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
}

fn should_store_local_agent_processing_placeholder(_event: &ParsedMailboxEvent) -> bool {
    // The agent owner also needs a local copy so their group transcript shows the
    // shared in-flight turn while their Kordi is processing. Storage reconciliation
    // keys this row by request id + outbound response direction, so the final agent
    // answer replaces it instead of creating another visible row.
    true
}

fn group_session_thread_relay_targets(
    event: &ParsedMailboxEvent,
    local_node_id: &str,
    local_owner_node_id: Option<&str>,
    requester_node_id: &str,
) -> Vec<String> {
    if !event_targets_group_session(event) {
        return Vec::new();
    }
    let local_node_id = local_node_id.trim();
    let local_owner_node_id = local_owner_node_id.map(str::trim).unwrap_or("");
    let requester_node_id = requester_node_id.trim();
    let mut targets = Vec::new();
    if let Some(participants) = event_session_thread(event)
        .and_then(|thread| thread.get("participants"))
        .and_then(|value| value.as_array())
    {
        for participant in participants {
            let Some(node_id) = participant
                .get("bridgeNodeId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            if node_id == local_node_id
                || node_id == local_owner_node_id
                || node_id == requester_node_id
            {
                continue;
            }
            if !targets.iter().any(|existing| existing == node_id) {
                targets.push(node_id.to_string());
            }
        }
    }
    targets
}

fn bridge_response_payload(event: &ParsedMailboxEvent, message: &str, done: bool) -> Value {
    let mut payload = serde_json::json!({ "message": message, "done": done });
    if let Some(thread) = event_session_thread(event) {
        payload["sessionThread"] = thread.clone();
    }
    payload
}

async fn fanout_group_agent_response(
    manager: &DesktopBridgeManager,
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
    message: &str,
    done: bool,
) {
    let relay_targets = group_session_thread_relay_targets(
        event,
        target.host.node_id.as_str(),
        target.owner_node_id.as_deref(),
        event.from_node_id.as_str(),
    );
    if relay_targets.is_empty() {
        return;
    }
    let response = serde_json::json!({
        "from": target.host.node_id,
        "fromDisplayName": target.host.display_name,
        "fromOwnerName": target.host.owner,
        "fromRuntime": target.sender_runtime,
        "fromHumanId": target.host.human_id,
        "fromAgentId": target.sender_agent_id,
        "projectId": event.project_id,
        "messageType": BRIDGE_MESSAGE_TYPE_RESPONSE,
        "requestId": event.request_id,
        "payload": bridge_response_payload(event, message, done),
    });
    for relay_target in relay_targets {
        send_realtime_or_relay(
            manager,
            &target.host,
            &relay_target,
            event.project_id.as_deref(),
            &response,
        )
        .await;
    }
}

fn append_local_agent_inbound_message(
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
    text: String,
    attachments: Vec<DesktopBridgeMessageAttachment>,
) -> Result<DesktopBridgeConversationStore, String> {
    let peer_display_name = event.from_display_name.clone();
    let peer_owner_name = event.from_owner_name.clone();
    let peer_runtime = event
        .from_runtime
        .clone()
        .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string());
    let sender_name = sender_name_for_runtime(
        &peer_runtime,
        peer_display_name.as_deref(),
        peer_owner_name.as_deref(),
        &event.from_node_id,
    );

    append_conversation_message_to_storage(
        &target.host.id,
        &event.from_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime.clone(),
        event.project_id.clone(),
        None,
        Some(identity_snapshot_for_event(
            &target.host,
            event,
            &peer_runtime,
        )),
        outreach_metadata_for_event(&target.host, event, &peer_runtime),
        BRIDGE_MESSAGE_DIRECTION_INBOUND,
        Some(sender_name),
        text,
        event.request_id.clone(),
        Some("processing".to_string()),
        attachments,
        true,
    )
}

fn append_local_agent_outbound_response(
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
    response_text: String,
    delivery_state: &str,
    mark_complete: bool,
) -> Result<DesktopBridgeConversationStore, String> {
    if mark_complete {
        if let Some(request_id) = event.request_id.as_deref() {
            let _ = update_message_delivery_state_in_storage(
                request_id,
                BRIDGE_DELIVERY_STATE_RESPONDED,
            )?;
        }
    }
    let peer_display_name = event.from_display_name.clone();
    let peer_owner_name = event.from_owner_name.clone();
    let peer_runtime = event
        .from_runtime
        .clone()
        .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string());
    let sender_name = sender_name_for_runtime(
        &target.sender_runtime,
        target.host.display_name.as_deref(),
        target.host.owner.as_deref(),
        &target.host.node_id,
    );

    append_conversation_message_to_storage(
        &target.host.id,
        &event.from_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime.clone(),
        event.project_id.clone(),
        None,
        Some(identity_snapshot_for_event(
            &target.host,
            event,
            &peer_runtime,
        )),
        outreach_metadata_for_event(&target.host, event, &peer_runtime),
        BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
        Some(sender_name),
        response_text,
        event.request_id.clone(),
        Some(delivery_state.to_string()),
        Vec::new(),
        false,
    )
}

fn realtime_agent_queue_records(
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
    now_ms: i64,
) -> (BridgeInboxEventInsert, BridgeAgentJobInsert) {
    bridge_agent_queue_records_for_event(&target.host.id, event, None, now_ms)
}

pub(super) async fn handle_incoming_payload(
    manager: &DesktopBridgeManager,
    app: &tauri::AppHandle,
    local_server: &std::sync::Arc<tokio::sync::Mutex<LocalBridgeServerRuntime>>,
    target: &LocalRealtimeTarget,
    payload: Value,
) -> Result<(), String> {
    let payload = decrypt_bridge_payload_for_host(&target.host, payload)?;
    let Some(event) = parse_bridge_event_payload(&payload) else {
        return Ok(());
    };

    if target.should_process_agent_asks && event.message_type == BRIDGE_MESSAGE_TYPE_ASK {
        let text = mailbox_payload_text(&event.payload);
        let attachments = mailbox_payload_attachments(&event.payload)?;
        if text.trim().is_empty() && attachments.is_empty() {
            return Ok(());
        }

        let (inbox, job) = realtime_agent_queue_records(target, &event, now_ms());
        record_bridge_inbox_event_and_agent_job(&inbox, &job)?;

        emit_after_storage_write(
            app,
            local_server,
            append_local_agent_inbound_message(target, &event, text.clone(), attachments),
        )
        .await?;

        if should_store_local_agent_processing_placeholder(&event) {
            emit_after_storage_write(
                app,
                local_server,
                append_local_agent_outbound_response(
                    target,
                    &event,
                    "processing...".to_string(),
                    "queued",
                    false,
                ),
            )
            .await?;
        }

        if let Some(request_id) = event.request_id.as_deref() {
            let processing = serde_json::json!({
                "from": target.host.node_id,
                "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                "payload": { "requestId": request_id, "state": "processing" },
            });
            send_realtime_or_relay(
                manager,
                &target.host,
                &event.from_node_id,
                event.project_id.as_deref(),
                &processing,
            )
            .await;
        }

        if event_targets_group_session(&event) {
            let response = serde_json::json!({
                "from": target.host.node_id,
                "fromDisplayName": target.host.display_name,
                "fromOwnerName": target.host.owner,
                "fromRuntime": target.sender_runtime,
                "fromHumanId": target.host.human_id,
                "fromAgentId": target.sender_agent_id,
                "projectId": event.project_id,
                "messageType": BRIDGE_MESSAGE_TYPE_RESPONSE,
                "requestId": event.request_id,
                "payload": bridge_response_payload(&event, "processing...", false),
            });
            send_realtime_or_relay(
                manager,
                &target.host,
                &event.from_node_id,
                event.project_id.as_deref(),
                &response,
            )
            .await;
        }
        fanout_group_agent_response(manager, target, &event, "processing...", false).await;

        let chat_manager = app.state::<DesktopChatManager>().inner().clone();
        let store = load_bridge_store();
        let _ = super::super::mailbox::run_queued_agent_jobs_once(&chat_manager, &store).await?;
        return emit_bridge_state(app, local_server).await;
    }

    let delivery_ack = realtime_delivery_ack_payload(target, &event);
    let delivery_ack_target_node_id = event.from_node_id.clone();
    let delivery_ack_project_id = event.project_id.clone();

    apply_bridge_event_to_storage(&target.host, event, false).await?;
    if let Some(delivery_ack) = delivery_ack {
        send_realtime_or_relay(
            manager,
            &target.host,
            &delivery_ack_target_node_id,
            delivery_ack_project_id.as_deref(),
            &delivery_ack,
        )
        .await;
    }
    emit_bridge_state(app, local_server).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::constants::{
        BRIDGE_DELIVERY_STATE_DELIVERED, BRIDGE_MESSAGE_TYPE_ASK, BRIDGE_MESSAGE_TYPE_RAW,
    };

    fn test_target() -> LocalRealtimeTarget {
        LocalRealtimeTarget {
            host: super::super::super::DesktopBridgeHostConfig {
                id: "host-1".to_string(),
                coordination: "https://bridge.test".to_string(),
                node_id: "node-me".to_string(),
                api_key: "key".to_string(),
                display_name: Some("Me".to_string()),
                owner: Some("Me".to_string()),
                human_id: Some("human-me".to_string()),
                discovery_mode: "ask".to_string(),
                active_agent_id: None,
                agents: vec![],
                api_style: "serve".to_string(),
            },
            sender_runtime: "person".to_string(),
            sender_agent_id: None,
            owner_node_id: Some("node-me".to_string()),
            should_process_agent_asks: false,
        }
    }

    fn test_event(message_type: &str) -> ParsedMailboxEvent {
        ParsedMailboxEvent {
            from_node_id: "node-peer".to_string(),
            from_display_name: Some("Peer".to_string()),
            from_owner_name: Some("Peer".to_string()),
            from_runtime: Some("person".to_string()),
            from_human_id: Some("human-peer".to_string()),
            from_agent_id: None,
            message_type: message_type.to_string(),
            payload: serde_json::json!({ "message": "hello" }),
            request_id: Some("bridge_req_1".to_string()),
            project_id: None,
        }
    }

    fn test_group_event() -> ParsedMailboxEvent {
        let mut event = test_event(BRIDGE_MESSAGE_TYPE_ASK);
        event.payload = serde_json::json!({
            "message": "@AlicesKordi help the group",
            "sessionThread": {
                "parentSessionId": "session:group:child",
                "parentSessionKind": "group",
                "parentGroupSpaceId": "session:group:root",
                "participants": [
                    { "displayName": "Requester", "bridgeNodeId": "node-peer" },
                    { "displayName": "Agent owner", "bridgeNodeId": "node-me" },
                    { "displayName": "Other", "bridgeNodeId": "node-other" }
                ]
            }
        });
        event
    }

    #[test]
    fn realtime_agent_ask_uses_same_inbox_job_path_as_mailbox() {
        let mut target = test_target();
        target.should_process_agent_asks = true;
        target.sender_runtime = "kordi-desktop".to_string();
        target.sender_agent_id = Some("agent-local".to_string());
        let mut event = test_event(BRIDGE_MESSAGE_TYPE_ASK);
        event.payload = serde_json::json!({
            "message": "help from realtime",
            "sessionThread": {
                "parentSessionId": "session-1",
                "targetKind": "bridge-agent",
                "targetDisplayName": "Me's Kordi"
            }
        });

        let (inbox, job) = realtime_agent_queue_records(&target, &event, 1_000);

        assert_eq!(inbox.host_id, "host-1");
        assert_eq!(inbox.server_message_id, None);
        assert_eq!(inbox.message_type, BRIDGE_MESSAGE_TYPE_ASK);
        assert_eq!(inbox.chat_queue_key, "session:session-1");
        assert_eq!(inbox.requesting_user_key, "human:human-peer");
        assert_eq!(inbox.status, "received");
        assert_eq!(job.inbox_event_id, inbox.id);
        assert_eq!(job.status, "queued");
        assert_eq!(job.chat_queue_key, inbox.chat_queue_key);
        assert_eq!(job.requesting_user_key, inbox.requesting_user_key);
    }

    #[test]
    fn realtime_delivery_ack_payload_marks_raw_messages_delivered() {
        let payload =
            realtime_delivery_ack_payload(&test_target(), &test_event(BRIDGE_MESSAGE_TYPE_RAW))
                .expect("raw message should be acknowledged");

        assert_eq!(payload["from"], serde_json::json!("node-me"));
        assert_eq!(
            payload["messageType"],
            serde_json::json!(BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT)
        );
        assert_eq!(
            payload["payload"]["requestId"],
            serde_json::json!("bridge_req_1")
        );
        assert_eq!(
            payload["payload"]["state"],
            serde_json::json!(BRIDGE_DELIVERY_STATE_DELIVERED)
        );
    }

    #[test]
    fn realtime_delivery_ack_payload_ignores_delivery_events() {
        assert!(realtime_delivery_ack_payload(
            &test_target(),
            &test_event(BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT)
        )
        .is_none());
    }

    #[test]
    fn group_agent_response_targets_other_group_members() {
        assert_eq!(
            group_session_thread_relay_targets(
                &test_group_event(),
                "node-agent",
                Some("node-me"),
                "node-peer"
            ),
            vec!["node-other".to_string()]
        );
    }

    #[test]
    fn local_owner_processing_placeholder_is_stored_for_group_agent_mentions() {
        assert!(should_store_local_agent_processing_placeholder(
            &test_group_event()
        ));
    }

    #[test]
    fn bridge_response_payload_preserves_session_thread_for_group_sync() {
        let payload = bridge_response_payload(&test_group_event(), "processing...", false);

        assert_eq!(payload["message"], serde_json::json!("processing..."));
        assert_eq!(payload["done"], serde_json::json!(false));
        assert_eq!(
            payload["sessionThread"]["parentGroupSpaceId"],
            serde_json::json!("session:group:root")
        );
    }
}
