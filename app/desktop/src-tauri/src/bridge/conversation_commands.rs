use serde_json::Value;
use uuid::Uuid;

use super::{
    append_conversation_message, build_bridge_state, build_current_bridge_state,
    current_local_server_status, default_display_name, fetch_mailbox, load_bridge_store,
    load_conversation_store, note_peer_heartbeat, note_peer_typing, now_ms, parse_mailbox_payload,
    relay_plaintext_message, save_conversation_store, update_message_delivery_state,
    upsert_bridge_conversation, DesktopBridgeManager, DesktopBridgeState,
};

fn outbound_message_type(peer_runtime: &str) -> &'static str {
    let runtime = peer_runtime.to_lowercase();
    if runtime.contains("agent")
        || runtime.contains("claude")
        || runtime.contains("codex")
        || runtime.contains("openclaw")
        || runtime.contains("pi")
        || runtime.contains("bot")
    {
        "ask"
    } else {
        "raw"
    }
}

fn mailbox_payload_text(payload: &Value) -> String {
    payload
        .get("message")
        .and_then(|value| value.as_str())
        .or_else(|| payload.get("question").and_then(|value| value.as_str()))
        .or_else(|| payload.get("topic").and_then(|value| value.as_str()))
        .or_else(|| payload.get("content").and_then(|value| value.as_str()))
        .map(ToString::to_string)
        .unwrap_or_else(|| payload.to_string())
}

pub(super) async fn desktop_bridge_open_conversation_impl(
    manager: &DesktopBridgeManager,
    host_id: String,
    peer_node_id: String,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_conversation_store();
    let conversation = upsert_bridge_conversation(
        &mut store,
        &host_id,
        &peer_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime.unwrap_or_else(|| "bridge-node".to_string()),
        project_id,
        project_name,
    );
    conversation.unread_count = 0;
    save_conversation_store(&store)?;
    Ok(build_current_bridge_state(manager).await)
}

pub(super) async fn desktop_bridge_mark_conversation_read_impl(
    manager: &DesktopBridgeManager,
    conversation_id: String,
) -> Result<DesktopBridgeState, String> {
    let mut store = load_conversation_store();
    if let Some(conversation) = store
        .conversations
        .iter_mut()
        .find(|conversation| conversation.id == conversation_id)
    {
        conversation.unread_count = 0;
        save_conversation_store(&store)?;
    }
    Ok(build_current_bridge_state(manager).await)
}

pub(super) async fn desktop_bridge_send_presence_impl(
    manager: &DesktopBridgeManager,
    conversation_id: String,
    kind: String,
) -> Result<DesktopBridgeState, String> {
    let presence_kind = kind.trim().to_lowercase();
    if presence_kind != "typing" && presence_kind != "heartbeat" {
        return Err("Unsupported bridge presence event".to_string());
    }

    let store = load_bridge_store();
    let conversations = load_conversation_store();
    let conversation = conversations
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)
        .cloned()
        .ok_or_else(|| "Bridge conversation not found".to_string())?;
    let host = store
        .hosts
        .iter()
        .find(|host| host.id == conversation.host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;

    let payload = serde_json::json!({
        "from": host.node_id,
        "projectId": conversation.project_id,
        "messageType": presence_kind,
        "payload": { "at": now_ms() },
    });
    relay_plaintext_message(
        &host.coordination,
        &host.api_key,
        &conversation.peer_node_id,
        conversation.project_id.as_deref(),
        &payload,
    )
    .await?;
    Ok(build_bridge_state(
        store,
        conversations,
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_bridge_send_message_impl(
    manager: &DesktopBridgeManager,
    conversation_id: String,
    text: String,
) -> Result<DesktopBridgeState, String> {
    let message = text.trim();
    if message.is_empty() {
        return Err("Bridge message cannot be empty".to_string());
    }

    let store = load_bridge_store();
    let mut conversations = load_conversation_store();
    let conversation = conversations
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)
        .cloned()
        .ok_or_else(|| "Bridge conversation not found".to_string())?;
    let host = store
        .hosts
        .iter()
        .find(|host| host.id == conversation.host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;

    let request_id = format!("bridge_req_{}", Uuid::new_v4().simple());
    let message_type = outbound_message_type(&conversation.peer_runtime);
    let payload = if message_type == "ask" {
        serde_json::json!({
            "from": host.node_id,
            "projectId": conversation.project_id,
            "messageType": "ask",
            "requestId": request_id,
            "payload": { "question": message },
        })
    } else {
        serde_json::json!({
            "from": host.node_id,
            "projectId": conversation.project_id,
            "messageType": "raw",
            "requestId": request_id,
            "payload": { "message": message },
        })
    };

    relay_plaintext_message(
        &host.coordination,
        &host.api_key,
        &conversation.peer_node_id,
        conversation.project_id.as_deref(),
        &payload,
    )
    .await?;

    append_conversation_message(
        &mut conversations,
        &conversation.host_id,
        &conversation.peer_node_id,
        conversation.peer_display_name.clone(),
        conversation.peer_owner_name.clone(),
        conversation.peer_runtime.clone(),
        conversation.project_id.clone(),
        conversation.project_name.clone(),
        "outbound",
        Some(
            host.display_name
                .clone()
                .unwrap_or_else(default_display_name),
        ),
        message.to_string(),
        Some(request_id),
        Some("sent".to_string()),
        false,
    );
    if let Some(record) = conversations
        .conversations
        .iter_mut()
        .find(|record| record.id == conversation_id)
    {
        record.unread_count = 0;
    }
    save_conversation_store(&conversations)?;
    Ok(build_bridge_state(
        store,
        conversations,
        current_local_server_status(manager).await,
    )
    .await)
}

pub(super) async fn desktop_bridge_poll_mailbox_impl(
    manager: &DesktopBridgeManager,
) -> Result<DesktopBridgeState, String> {
    let store = load_bridge_store();
    let mut conversations = load_conversation_store();

    for host in &store.hosts {
        if host.api_key.trim().is_empty() {
            continue;
        }
        let mailbox = match fetch_mailbox(&host.coordination, &host.api_key).await {
            Ok(mailbox) => mailbox,
            Err(_) => continue,
        };
        if mailbox.is_empty() {
            continue;
        }

        for item in mailbox {
            let from_node_id = item
                .get("from")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let blob = item
                .get("blob")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if from_node_id.is_empty() || blob.trim().is_empty() {
                continue;
            }
            let Some(parsed) = parse_mailbox_payload(blob) else {
                continue;
            };
            let message_type = parsed
                .get("messageType")
                .and_then(|value| value.as_str())
                .unwrap_or("raw");
            let payload = parsed.get("payload").cloned().unwrap_or(Value::Null);
            let request_id = parsed
                .get("requestId")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);
            let parsed_project_id = parsed
                .get("projectId")
                .and_then(|value| value.as_str())
                .map(ToString::to_string);

            if message_type == "delivery_event" {
                if let Some(target_request_id) =
                    payload.get("requestId").and_then(|value| value.as_str())
                {
                    let state = payload
                        .get("state")
                        .and_then(|value| value.as_str())
                        .unwrap_or("delivered");
                    update_message_delivery_state(&mut conversations, target_request_id, state);
                }
                continue;
            }
            if message_type == "typing" {
                note_peer_typing(
                    &mut conversations,
                    &host.id,
                    &from_node_id,
                    parsed_project_id.clone(),
                    None,
                );
                continue;
            }
            if message_type == "heartbeat" {
                note_peer_heartbeat(
                    &mut conversations,
                    &host.id,
                    &from_node_id,
                    parsed_project_id.clone(),
                    None,
                );
                continue;
            }

            let text = mailbox_payload_text(&payload);
            if text.trim().is_empty() {
                continue;
            }

            append_conversation_message(
                &mut conversations,
                &host.id,
                &from_node_id,
                None,
                None,
                "bridge-node".to_string(),
                parsed_project_id.clone(),
                None,
                if message_type == "response" {
                    "inbound-response"
                } else {
                    "inbound"
                },
                Some(from_node_id.clone()),
                text,
                request_id.clone(),
                None,
                true,
            );

            if message_type == "response" {
                if let Some(request_id) = request_id.as_deref() {
                    update_message_delivery_state(&mut conversations, request_id, "responded");
                }
            } else if let Some(request_id) = request_id.as_deref() {
                let ack = serde_json::json!({
                    "from": host.node_id,
                    "messageType": "delivery_event",
                    "payload": { "requestId": request_id, "state": "delivered" },
                });
                let _ = relay_plaintext_message(
                    &host.coordination,
                    &host.api_key,
                    &from_node_id,
                    parsed.get("projectId").and_then(|value| value.as_str()),
                    &ack,
                )
                .await;
            }
        }
    }

    save_conversation_store(&conversations)?;
    Ok(build_bridge_state(
        store,
        conversations,
        current_local_server_status(manager).await,
    )
    .await)
}
