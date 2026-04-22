use serde_json::Value;
use uuid::Uuid;

use super::constants::{
    BRIDGE_DELIVERY_STATE_DELIVERED, BRIDGE_DELIVERY_STATE_RESPONDED, BRIDGE_DELIVERY_STATE_SENT,
    BRIDGE_MESSAGE_TYPE_ASK, BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_HEARTBEAT,
    BRIDGE_MESSAGE_TYPE_RAW, BRIDGE_MESSAGE_TYPE_RESPONSE, BRIDGE_MESSAGE_TYPE_TYPING,
    BRIDGE_REQUEST_ID_PREFIX, DEFAULT_BRIDGE_RUNTIME,
};
use super::{
    append_conversation_message, build_bridge_state, build_current_bridge_state,
    current_local_server_status, default_display_name, fetch_mailbox, load_bridge_store,
    load_conversation_store, note_peer_heartbeat, note_peer_typing, now_ms, parse_mailbox_payload,
    relay_plaintext_message, save_conversation_store, update_message_delivery_state,
    upsert_bridge_conversation, DesktopBridgeConversationRecord, DesktopBridgeConversationStore,
    DesktopBridgeHostConfig, DesktopBridgeManager, DesktopBridgeState, DesktopBridgeStore,
};

#[derive(Clone)]
struct ConversationContext {
    conversation: DesktopBridgeConversationRecord,
    host: DesktopBridgeHostConfig,
}

struct ParsedMailboxEvent {
    from_node_id: String,
    message_type: String,
    payload: Value,
    request_id: Option<String>,
    project_id: Option<String>,
}

fn outbound_message_type(peer_runtime: &str) -> &'static str {
    let runtime = peer_runtime.to_lowercase();
    if runtime.contains("agent")
        || runtime.contains("claude")
        || runtime.contains("codex")
        || runtime.contains("openclaw")
        || runtime.contains("pi")
        || runtime.contains("bot")
    {
        BRIDGE_MESSAGE_TYPE_ASK
    } else {
        BRIDGE_MESSAGE_TYPE_RAW
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

fn load_conversation_context(
    conversation_id: &str,
) -> Result<
    (
        DesktopBridgeStore,
        DesktopBridgeConversationStore,
        ConversationContext,
    ),
    String,
> {
    let store = load_bridge_store();
    let conversations = load_conversation_store();
    let context = resolve_conversation_context(&store, &conversations, conversation_id)?;
    Ok((store, conversations, context))
}

fn resolve_conversation_context(
    store: &DesktopBridgeStore,
    conversations: &DesktopBridgeConversationStore,
    conversation_id: &str,
) -> Result<ConversationContext, String> {
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
    Ok(ConversationContext { conversation, host })
}

async fn rebuild_state(
    manager: &DesktopBridgeManager,
    store: DesktopBridgeStore,
    conversations: DesktopBridgeConversationStore,
) -> Result<DesktopBridgeState, String> {
    Ok(build_bridge_state(
        store,
        conversations,
        current_local_server_status(manager).await,
    )
    .await)
}

fn outbound_payload(context: &ConversationContext, request_id: &str, message: &str) -> Value {
    let message_type = outbound_message_type(&context.conversation.peer_runtime);
    if message_type == BRIDGE_MESSAGE_TYPE_ASK {
        serde_json::json!({
            "from": context.host.node_id,
            "projectId": context.conversation.project_id,
            "messageType": BRIDGE_MESSAGE_TYPE_ASK,
            "requestId": request_id,
            "payload": { "question": message },
        })
    } else {
        serde_json::json!({
            "from": context.host.node_id,
            "projectId": context.conversation.project_id,
            "messageType": BRIDGE_MESSAGE_TYPE_RAW,
            "requestId": request_id,
            "payload": { "message": message },
        })
    }
}

fn parse_mailbox_event(item: &Value) -> Option<ParsedMailboxEvent> {
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
        return None;
    }

    let parsed = parse_mailbox_payload(blob)?;
    Some(ParsedMailboxEvent {
        from_node_id,
        message_type: parsed
            .get("messageType")
            .and_then(|value| value.as_str())
            .unwrap_or(BRIDGE_MESSAGE_TYPE_RAW)
            .to_string(),
        payload: parsed.get("payload").cloned().unwrap_or(Value::Null),
        request_id: parsed
            .get("requestId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        project_id: parsed
            .get("projectId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
    })
}

fn apply_delivery_event(
    conversations: &mut DesktopBridgeConversationStore,
    event: &ParsedMailboxEvent,
) {
    if let Some(target_request_id) = event
        .payload
        .get("requestId")
        .and_then(|value| value.as_str())
    {
        let state = event
            .payload
            .get("state")
            .and_then(|value| value.as_str())
            .unwrap_or(BRIDGE_DELIVERY_STATE_DELIVERED);
        update_message_delivery_state(conversations, target_request_id, state);
    }
}

fn apply_presence_event(
    host: &DesktopBridgeHostConfig,
    conversations: &mut DesktopBridgeConversationStore,
    event: &ParsedMailboxEvent,
) -> bool {
    match event.message_type.as_str() {
        BRIDGE_MESSAGE_TYPE_TYPING => {
            note_peer_typing(
                conversations,
                &host.id,
                &event.from_node_id,
                event.project_id.clone(),
                None,
            );
            true
        }
        BRIDGE_MESSAGE_TYPE_HEARTBEAT => {
            note_peer_heartbeat(
                conversations,
                &host.id,
                &event.from_node_id,
                event.project_id.clone(),
                None,
            );
            true
        }
        _ => false,
    }
}

fn append_inbound_event_message(
    host: &DesktopBridgeHostConfig,
    conversations: &mut DesktopBridgeConversationStore,
    event: &ParsedMailboxEvent,
) -> Option<String> {
    let text = mailbox_payload_text(&event.payload);
    if text.trim().is_empty() {
        return None;
    }

    append_conversation_message(
        conversations,
        &host.id,
        &event.from_node_id,
        None,
        None,
        DEFAULT_BRIDGE_RUNTIME.to_string(),
        event.project_id.clone(),
        None,
        if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE {
            "inbound-response"
        } else {
            "inbound"
        },
        Some(event.from_node_id.clone()),
        text.clone(),
        event.request_id.clone(),
        None,
        true,
    );
    Some(text)
}

async fn acknowledge_inbound_delivery(host: &DesktopBridgeHostConfig, event: &ParsedMailboxEvent) {
    if let Some(request_id) = event.request_id.as_deref() {
        let ack = serde_json::json!({
            "from": host.node_id,
            "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
            "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_DELIVERED },
        });
        let _ = relay_plaintext_message(
            &host.coordination,
            &host.api_key,
            &event.from_node_id,
            event.project_id.as_deref(),
            &ack,
        )
        .await;
    }
}

async fn apply_mailbox_event(
    host: &DesktopBridgeHostConfig,
    conversations: &mut DesktopBridgeConversationStore,
    event: ParsedMailboxEvent,
) {
    if event.message_type == BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT {
        apply_delivery_event(conversations, &event);
        return;
    }
    if apply_presence_event(host, conversations, &event) {
        return;
    }
    if append_inbound_event_message(host, conversations, &event).is_none() {
        return;
    }

    if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE {
        if let Some(request_id) = event.request_id.as_deref() {
            update_message_delivery_state(
                conversations,
                request_id,
                BRIDGE_DELIVERY_STATE_RESPONDED,
            );
        }
    } else {
        acknowledge_inbound_delivery(host, &event).await;
    }
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
        peer_runtime.unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string()),
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
    if presence_kind != BRIDGE_MESSAGE_TYPE_TYPING && presence_kind != BRIDGE_MESSAGE_TYPE_HEARTBEAT
    {
        return Err("Unsupported bridge presence event".to_string());
    }

    let (store, conversations, context) = load_conversation_context(&conversation_id)?;
    let payload = serde_json::json!({
        "from": context.host.node_id,
        "projectId": context.conversation.project_id,
        "messageType": presence_kind,
        "payload": { "at": now_ms() },
    });
    relay_plaintext_message(
        &context.host.coordination,
        &context.host.api_key,
        &context.conversation.peer_node_id,
        context.conversation.project_id.as_deref(),
        &payload,
    )
    .await?;
    rebuild_state(manager, store, conversations).await
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

    let (store, mut conversations, context) = load_conversation_context(&conversation_id)?;
    let request_id = format!("{}{}", BRIDGE_REQUEST_ID_PREFIX, Uuid::new_v4().simple());
    let payload = outbound_payload(&context, &request_id, message);

    relay_plaintext_message(
        &context.host.coordination,
        &context.host.api_key,
        &context.conversation.peer_node_id,
        context.conversation.project_id.as_deref(),
        &payload,
    )
    .await?;

    append_conversation_message(
        &mut conversations,
        &context.conversation.host_id,
        &context.conversation.peer_node_id,
        context.conversation.peer_display_name.clone(),
        context.conversation.peer_owner_name.clone(),
        context.conversation.peer_runtime.clone(),
        context.conversation.project_id.clone(),
        context.conversation.project_name.clone(),
        "outbound",
        Some(
            context
                .host
                .display_name
                .clone()
                .unwrap_or_else(default_display_name),
        ),
        message.to_string(),
        Some(request_id),
        Some(BRIDGE_DELIVERY_STATE_SENT.to_string()),
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
    rebuild_state(manager, store, conversations).await
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
            let Some(event) = parse_mailbox_event(&item) else {
                continue;
            };
            apply_mailbox_event(host, &mut conversations, event).await;
        }
    }

    save_conversation_store(&conversations)?;
    rebuild_state(manager, store, conversations).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn outbound_message_type_uses_ask_for_agent_like_runtimes() {
        assert_eq!(
            outbound_message_type("claude-code"),
            BRIDGE_MESSAGE_TYPE_ASK
        );
        assert_eq!(outbound_message_type("codex"), BRIDGE_MESSAGE_TYPE_ASK);
        assert_eq!(
            outbound_message_type("plain-terminal"),
            BRIDGE_MESSAGE_TYPE_RAW
        );
    }

    #[test]
    fn parse_mailbox_event_decodes_valid_payload() {
        let payload = serde_json::json!({
            "messageType": BRIDGE_MESSAGE_TYPE_RESPONSE,
            "requestId": "req-1",
            "projectId": "proj-1",
            "payload": { "message": "hello" },
        });
        let blob = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&payload).expect("serialize payload"));
        let item = serde_json::json!({
            "from": "kd_peer",
            "blob": blob,
        });

        let event = parse_mailbox_event(&item).expect("parse mailbox event");

        assert_eq!(event.from_node_id, "kd_peer");
        assert_eq!(event.message_type, BRIDGE_MESSAGE_TYPE_RESPONSE);
        assert_eq!(event.request_id.as_deref(), Some("req-1"));
        assert_eq!(event.project_id.as_deref(), Some("proj-1"));
        assert_eq!(mailbox_payload_text(&event.payload), "hello");
    }
}
