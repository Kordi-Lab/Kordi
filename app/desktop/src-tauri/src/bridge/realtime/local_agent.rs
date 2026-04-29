use serde_json::Value;
use tauri::Manager;

use crate::chat::{run_bridge_agent_prompt, DesktopChatManager};

use super::super::constants::{
    BRIDGE_DELIVERY_STATE_DELIVERED, BRIDGE_DELIVERY_STATE_RESPONDED,
    BRIDGE_MESSAGE_DIRECTION_INBOUND, BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
    BRIDGE_MESSAGE_TYPE_ASK, BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_RESPONSE,
    DEFAULT_BRIDGE_RUNTIME,
};
use super::super::events::{
    identity_snapshot_for_event, mailbox_payload_agent_prompt_text, mailbox_payload_text,
    outreach_metadata_for_event, parse_bridge_event_payload, sanitize_agent_response_for_event,
    sender_name_for_runtime, ParsedMailboxEvent,
};
use super::super::mailbox::apply_bridge_event_to_storage;
use super::super::{
    append_conversation_message_to_storage, bridge_request_is_cancelled,
    decrypt_bridge_payload_for_host, update_message_delivery_state_in_storage,
    DesktopBridgeConversationStore, DesktopBridgeManager, LocalBridgeServerRuntime,
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

fn append_local_agent_inbound_message(
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
    text: String,
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
        false,
    )
}

async fn fail_local_agent_response(
    manager: &DesktopBridgeManager,
    app: &tauri::AppHandle,
    local_server: &std::sync::Arc<tokio::sync::Mutex<LocalBridgeServerRuntime>>,
    target: &LocalRealtimeTarget,
    event: &ParsedMailboxEvent,
    error: String,
) {
    let error_text = if error.trim().is_empty() {
        "Agent processing failed".to_string()
    } else {
        error
    };

    let _ = emit_after_storage_write(
        app,
        local_server,
        append_local_agent_outbound_response(
            target,
            event,
            format!("Failed: {error_text}"),
            "processing_failed",
            false,
        ),
    )
    .await;

    if let Some(request_id) = event.request_id.as_deref() {
        let _ = emit_after_storage_write(
            app,
            local_server,
            update_message_delivery_state_in_storage(request_id, "processing_failed"),
        )
        .await;

        let failed = serde_json::json!({
            "from": target.host.node_id,
            "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
            "payload": { "requestId": request_id, "state": "processing_failed", "error": error_text },
        });
        send_realtime_or_relay(
            manager,
            &target.host,
            &event.from_node_id,
            event.project_id.as_deref(),
            &failed,
        )
        .await;
    }
}

fn spawn_local_agent_response(
    manager: DesktopBridgeManager,
    chat_manager: DesktopChatManager,
    app: tauri::AppHandle,
    local_server: std::sync::Arc<tokio::sync::Mutex<LocalBridgeServerRuntime>>,
    target: LocalRealtimeTarget,
    event: ParsedMailboxEvent,
    text: String,
) {
    tokio::spawn(async move {
        let _ = emit_after_storage_write(
            &app,
            &local_server,
            append_local_agent_outbound_response(
                &target,
                &event,
                "processing...".to_string(),
                "processing",
                false,
            ),
        )
        .await;

        let final_snapshot = match run_bridge_agent_prompt(
            &chat_manager,
            &target.host.node_id,
            &event.from_node_id,
            text,
        )
        .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                fail_local_agent_response(&manager, &app, &local_server, &target, &event, error)
                    .await;
                return;
            }
        };

        if event
            .request_id
            .as_deref()
            .is_some_and(bridge_request_is_cancelled)
        {
            let _ = emit_after_storage_write(
                &app,
                &local_server,
                append_local_agent_outbound_response(
                    &target,
                    &event,
                    "Cancelled".to_string(),
                    "cancelled",
                    false,
                ),
            )
            .await;
            return;
        }

        match final_snapshot {
            final_snapshot
                if final_snapshot.succeeded && !final_snapshot.assistant_text.trim().is_empty() =>
            {
                let assistant_text =
                    sanitize_agent_response_for_event(&event, &final_snapshot.assistant_text);
                if assistant_text.trim().is_empty() {
                    fail_local_agent_response(
                        &manager,
                        &app,
                        &local_server,
                        &target,
                        &event,
                        "Bridge agent returned no text response".to_string(),
                    )
                    .await;
                    return;
                }
                let _ = emit_after_storage_write(
                    &app,
                    &local_server,
                    append_local_agent_outbound_response(
                        &target,
                        &event,
                        assistant_text.clone(),
                        BRIDGE_DELIVERY_STATE_RESPONDED,
                        true,
                    ),
                )
                .await;

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
                    "payload": { "message": assistant_text, "done": true },
                });
                send_realtime_or_relay(
                    &manager,
                    &target.host,
                    &event.from_node_id,
                    event.project_id.as_deref(),
                    &response,
                )
                .await;

                if let Some(request_id) = event.request_id.as_deref() {
                    let responded = serde_json::json!({
                        "from": target.host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_RESPONDED },
                    });
                    send_realtime_or_relay(
                        &manager,
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &responded,
                    )
                    .await;
                }
            }
            final_snapshot => {
                let error = final_snapshot
                    .error
                    .unwrap_or_else(|| final_snapshot.message.clone());
                fail_local_agent_response(&manager, &app, &local_server, &target, &event, error)
                    .await;
            }
        }
    });
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
        let agent_prompt_text = mailbox_payload_agent_prompt_text(&event.payload);
        if text.trim().is_empty() {
            return Ok(());
        }

        emit_after_storage_write(
            app,
            local_server,
            append_local_agent_inbound_message(target, &event, text.clone()),
        )
        .await?;

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

        let chat_manager = app.state::<DesktopChatManager>().inner().clone();
        spawn_local_agent_response(
            manager.clone(),
            chat_manager,
            app.clone(),
            local_server.clone(),
            target.clone(),
            event,
            agent_prompt_text,
        );
        return Ok(());
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
    use crate::bridge::constants::{BRIDGE_DELIVERY_STATE_DELIVERED, BRIDGE_MESSAGE_TYPE_RAW};

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
}
