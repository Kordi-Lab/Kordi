use serde_json::Value;
use uuid::Uuid;

use super::constants::{
    is_agent_like_runtime, is_inbound_message_direction, API_STYLE_SERVE,
    BRIDGE_DELIVERY_STATE_READ, BRIDGE_DELIVERY_STATE_SENT, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE, BRIDGE_MESSAGE_TYPE_ASK,
    BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_HEARTBEAT, BRIDGE_MESSAGE_TYPE_RAW,
    BRIDGE_MESSAGE_TYPE_TYPING, BRIDGE_REQUEST_ID_PREFIX, DEFAULT_BRIDGE_RUNTIME,
};
use super::events::sender_name_for_runtime;
use super::outreach::mark_outreach_status;
use super::{
    add_serve_contact, append_conversation_message_to_storage,
    build_conversation_only_bridge_state, current_local_server_status, default_display_name,
    load_bridge_store, load_conversation_store, mark_bridge_conversation_read_in_storage, now_ms,
    relay_plaintext_message, send_realtime_payload, update_message_delivery_state_in_storage,
    DesktopBridgeConversationRecord, DesktopBridgeConversationStore, DesktopBridgeHostConfig,
    DesktopBridgeManager, DesktopBridgeOutreachMetadata, DesktopBridgeState, DesktopBridgeStore,
};

#[derive(Clone)]
struct ConversationContext {
    conversation: DesktopBridgeConversationRecord,
    host: DesktopBridgeHostConfig,
}

pub(super) fn outbound_message_type(peer_runtime: &str) -> &'static str {
    if is_agent_like_runtime(peer_runtime) {
        BRIDGE_MESSAGE_TYPE_ASK
    } else {
        BRIDGE_MESSAGE_TYPE_RAW
    }
}

fn is_realtime_direct_chat(
    conversation: &DesktopBridgeConversationRecord,
    host: &DesktopBridgeHostConfig,
) -> bool {
    host.api_style == API_STYLE_SERVE
        && conversation.project_id.is_none()
        && (conversation
            .peer_runtime
            .trim()
            .eq_ignore_ascii_case("person")
            || is_agent_like_runtime(&conversation.peer_runtime))
}

fn pending_read_receipt_request_ids(conversation: &DesktopBridgeConversationRecord) -> Vec<String> {
    let mut request_ids = conversation
        .messages
        .iter()
        .filter(|message| is_inbound_message_direction(&message.direction))
        .filter_map(|message| message.request_id.as_deref())
        .map(str::trim)
        .filter(|request_id| !request_id.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    request_ids.sort();
    request_ids.dedup();
    request_ids
}

fn read_receipt_payload(host_node_id: &str, request_id: &str) -> Value {
    serde_json::json!({
        "from": host_node_id,
        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
        "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_READ },
    })
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

pub(super) async fn rebuild_state(
    manager: &DesktopBridgeManager,
    store: DesktopBridgeStore,
    conversations: DesktopBridgeConversationStore,
) -> Result<DesktopBridgeState, String> {
    let state = build_conversation_only_bridge_state(
        store,
        conversations,
        current_local_server_status(manager).await,
    );
    if let Err(error) = crate::canonical_sessions::sync_bridge_state_sessions(&state) {
        eprintln!("Unable to sync bridge sessions into canonical sessions: {error}");
    }
    Ok(state)
}

async fn relay_with_contact_fallback(
    context: &ConversationContext,
    payload: &Value,
) -> Result<(), String> {
    let project_id = context.conversation.project_id.as_deref();
    let is_direct_serve_chat = project_id.is_none() && context.host.api_style == API_STYLE_SERVE;

    match relay_plaintext_message(
        &context.host,
        &context.conversation.peer_node_id,
        project_id,
        payload,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(error) if is_direct_serve_chat && error.contains("HTTP 403") => {
            add_serve_contact(
                &context.host.coordination,
                &context.host.api_key,
                &context.conversation.peer_node_id,
            )
            .await?;
            relay_plaintext_message(
                &context.host,
                &context.conversation.peer_node_id,
                project_id,
                payload,
            )
            .await
        }
        Err(error) => Err(error),
    }
}

async fn send_read_receipt(
    manager: &DesktopBridgeManager,
    context: &ConversationContext,
    request_id: &str,
) -> Result<(), String> {
    let payload = read_receipt_payload(&context.host.node_id, request_id);

    if is_realtime_direct_chat(&context.conversation, &context.host) {
        match send_realtime_payload(
            manager,
            &context.host,
            &context.conversation.peer_node_id,
            &payload,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(realtime_error) => {
                eprintln!(
                    "Bridge read receipt realtime send failed; conversation_id={}, target_node_id={}, request_id={}, error={}",
                    context.conversation.id,
                    context.conversation.peer_node_id,
                    request_id,
                    realtime_error
                );
            }
        }
    }

    relay_with_contact_fallback(context, &payload).await
}

fn outbound_direction(outreach: Option<&DesktopBridgeOutreachMetadata>) -> &'static str {
    if outreach
        .and_then(|outreach| outreach.parent_turn_id.as_deref())
        .is_some()
    {
        BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
    } else {
        BRIDGE_MESSAGE_DIRECTION_OUTBOUND
    }
}

fn outbound_payload(
    context: &ConversationContext,
    request_id: &str,
    message: &str,
    outreach: Option<&DesktopBridgeOutreachMetadata>,
) -> Value {
    let active_agent = context
        .host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| {
            context
                .host
                .agents
                .iter()
                .find(|agent| agent.id == active_id)
        })
        .or_else(|| context.host.agents.iter().find(|agent| agent.is_default))
        .or_else(|| context.host.agents.first());
    let agent_authored_outreach = outreach
        .and_then(|outreach| outreach.parent_turn_id.as_deref())
        .is_some();
    let sender_display_name = if agent_authored_outreach {
        active_agent
            .map(|agent| agent.label.clone())
            .or_else(|| context.host.display_name.clone())
            .unwrap_or_else(default_display_name)
    } else {
        context
            .host
            .owner
            .clone()
            .unwrap_or_else(default_display_name)
    };
    let sender_owner_name = context
        .host
        .owner
        .clone()
        .unwrap_or_else(default_display_name);
    let sender_runtime = if agent_authored_outreach {
        active_agent
            .map(|agent| agent.runtime.clone())
            .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string())
    } else {
        "person".to_string()
    };
    let sender_agent_id = if agent_authored_outreach {
        context.host.active_agent_id.clone()
    } else {
        None
    };
    let message_type = outbound_message_type(&context.conversation.peer_runtime);
    let context_text = outreach
        .and_then(|outreach| outreach.context_text.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let context_policy = outreach
        .and_then(|outreach| outreach.context_policy.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let session_thread = outreach.and_then(|outreach| {
        outreach
            .parent_session_id
            .as_ref()
            .map(|parent_session_id| {
                serde_json::json!({
                    "parentSessionId": parent_session_id,
                    "parentSessionTitle": outreach.parent_session_title.as_deref(),
                    "messages": &outreach.parent_session_messages,
                    "parentTurnId": outreach.parent_turn_id.as_deref(),
                    "parentMessageId": outreach.parent_message_id.as_deref(),
                    "targetKind": outreach.target_kind.as_str(),
                    "targetDisplayName": outreach.target_display_name.as_str(),
                    "targetNodeId": outreach.target_node_id.as_str(),
                    "requestText": outreach.request_text.as_str(),
                    "triggerText": outreach.trigger_text.as_deref(),
                    "contextPolicy": outreach.context_policy.as_deref(),
                    "projectName": outreach.project_name.as_deref(),
                })
            })
    });

    let delivery_state = outreach.and_then(|outreach| outreach.delivery_state.as_deref());

    if message_type == BRIDGE_MESSAGE_TYPE_ASK {
        let mut payload = serde_json::json!({ "question": message });
        if let Some(context_text) = context_text {
            payload["contextText"] = serde_json::json!(context_text);
        }
        if let Some(context_policy) = context_policy {
            payload["contextPolicy"] = serde_json::json!(context_policy);
        }
        if let Some(session_thread) = session_thread.clone() {
            payload["sessionThread"] = session_thread;
        }
        if let Some(delivery_state) = delivery_state {
            payload["deliveryState"] = serde_json::json!(delivery_state);
        }

        serde_json::json!({
            "from": context.host.node_id,
            "fromDisplayName": sender_display_name,
            "fromOwnerName": sender_owner_name,
            "fromRuntime": sender_runtime,
            "fromHumanId": context.host.human_id,
            "fromAgentId": sender_agent_id,
            "projectId": context.conversation.project_id,
            "messageType": BRIDGE_MESSAGE_TYPE_ASK,
            "requestId": request_id,
            "payload": payload,
        })
    } else {
        let mut payload = serde_json::json!({ "message": message });
        if let Some(context_text) = context_text {
            payload["contextText"] = serde_json::json!(context_text);
        }
        if let Some(context_policy) = context_policy {
            payload["contextPolicy"] = serde_json::json!(context_policy);
        }
        if let Some(session_thread) = session_thread {
            payload["sessionThread"] = session_thread;
        }
        if let Some(delivery_state) = delivery_state {
            payload["deliveryState"] = serde_json::json!(delivery_state);
        }

        serde_json::json!({
            "from": context.host.node_id,
            "fromDisplayName": sender_display_name,
            "fromOwnerName": sender_owner_name,
            "fromRuntime": sender_runtime,
            "fromHumanId": context.host.human_id,
            "fromAgentId": sender_agent_id,
            "projectId": context.conversation.project_id,
            "messageType": BRIDGE_MESSAGE_TYPE_RAW,
            "requestId": request_id,
            "payload": payload,
        })
    }
}

pub(super) async fn desktop_bridge_mark_conversation_read_impl(
    manager: &DesktopBridgeManager,
    conversation_id: String,
) -> Result<DesktopBridgeState, String> {
    let bridge_store = load_bridge_store();
    let store = load_conversation_store();
    let mut marked_store = None;
    if let Ok(context) = resolve_conversation_context(&bridge_store, &store, &conversation_id) {
        let pending_read_receipts = pending_read_receipt_request_ids(&context.conversation);
        for request_id in pending_read_receipts {
            if let Err(error) = send_read_receipt(manager, &context, &request_id).await {
                eprintln!(
                    "Bridge read receipt relay send failed; conversation_id={}, target_node_id={}, request_id={}, error={}",
                    context.conversation.id,
                    context.conversation.peer_node_id,
                    request_id,
                    error
                );
            }
        }
        marked_store = Some(mark_bridge_conversation_read_in_storage(&conversation_id)?);
    }
    Ok(build_conversation_only_bridge_state(
        bridge_store,
        marked_store.unwrap_or(store),
        current_local_server_status(manager).await,
    ))
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
    if is_realtime_direct_chat(&context.conversation, &context.host) {
        send_realtime_payload(
            manager,
            &context.host,
            &context.conversation.peer_node_id,
            &payload,
        )
        .await?;
    } else {
        relay_with_contact_fallback(&context, &payload).await?;
    }
    rebuild_state(manager, store, conversations).await
}

pub(super) async fn desktop_bridge_cancel_outreach_impl(
    manager: &DesktopBridgeManager,
    conversation_id: String,
    request_id: Option<String>,
) -> Result<DesktopBridgeState, String> {
    let (bridge_store, _conversations, context) = load_conversation_context(&conversation_id)?;
    let request_id = request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            context
                .conversation
                .outreach
                .as_ref()
                .and_then(|outreach| outreach.bridge_request_id.clone())
        })
        .or_else(|| {
            context
                .conversation
                .messages
                .iter()
                .rev()
                .find_map(|message| message.request_id.clone())
        })
        .ok_or_else(|| "No cancellable bridge request found".to_string())?;

    update_message_delivery_state_in_storage(&request_id, "cancelled")?;
    mark_outreach_status(
        &conversation_id,
        "cancelled",
        true,
        Some("Cancelled by user".to_string()),
    )?;

    let cancelled = serde_json::json!({
        "from": context.host.node_id,
        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
        "payload": { "requestId": request_id, "state": "cancelled" },
    });
    if is_realtime_direct_chat(&context.conversation, &context.host) {
        let _ = send_realtime_payload(
            manager,
            &context.host,
            &context.conversation.peer_node_id,
            &cancelled,
        )
        .await;
    } else {
        let _ = relay_with_contact_fallback(&context, &cancelled).await;
    }

    rebuild_state(manager, bridge_store, load_conversation_store()).await
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

    let (store, _conversations, context) = load_conversation_context(&conversation_id)?;
    let fresh_outreach_for_message = context.conversation.outreach.clone().filter(|outreach| {
        outreach.request_text.trim() == message
            && now_ms().saturating_sub(outreach.created_at_ms) < 30_000
    });
    let request_id = fresh_outreach_for_message
        .as_ref()
        .and_then(|outreach| outreach.bridge_request_id.clone())
        .unwrap_or_else(|| format!("{}{}", BRIDGE_REQUEST_ID_PREFIX, Uuid::new_v4().simple()));
    let payload = outbound_payload(
        &context,
        &request_id,
        message,
        fresh_outreach_for_message.as_ref(),
    );

    if is_realtime_direct_chat(&context.conversation, &context.host) {
        send_realtime_payload(
            manager,
            &context.host,
            &context.conversation.peer_node_id,
            &payload,
        )
        .await?;
    } else {
        relay_with_contact_fallback(&context, &payload).await?;
    }

    let sender_name = fresh_outreach_for_message
        .as_ref()
        .and_then(|outreach| outreach.parent_turn_id.as_ref())
        .and_then(|_| {
            context
                .host
                .active_agent_id
                .as_deref()
                .and_then(|active_id| {
                    context
                        .host
                        .agents
                        .iter()
                        .find(|agent| agent.id == active_id)
                })
                .or_else(|| context.host.agents.iter().find(|agent| agent.is_default))
                .or_else(|| context.host.agents.first())
                .map(|agent| agent.label.clone())
        })
        .unwrap_or_else(|| {
            sender_name_for_runtime(
                &context.conversation.peer_runtime,
                context.host.display_name.as_deref(),
                context.host.owner.as_deref(),
                &context.host.node_id,
            )
        });

    append_conversation_message_to_storage(
        &context.conversation.host_id,
        &context.conversation.peer_node_id,
        context.conversation.peer_display_name.clone(),
        context.conversation.peer_owner_name.clone(),
        context.conversation.peer_runtime.clone(),
        context.conversation.project_id.clone(),
        context.conversation.project_name.clone(),
        context.conversation.identity.clone(),
        fresh_outreach_for_message.clone(),
        outbound_direction(fresh_outreach_for_message.as_ref()),
        Some(sender_name),
        message.to_string(),
        Some(request_id),
        fresh_outreach_for_message
            .as_ref()
            .and_then(|outreach| outreach.delivery_state.clone())
            .or_else(|| Some(BRIDGE_DELIVERY_STATE_SENT.to_string())),
        false,
    )?;
    let conversations = mark_bridge_conversation_read_in_storage(&conversation_id)?;
    rebuild_state(manager, store, conversations).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::constants::{
        BRIDGE_MESSAGE_DIRECTION_INBOUND, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    };

    fn test_conversation(
        messages: Vec<crate::bridge::DesktopBridgeConversationMessageRecord>,
    ) -> DesktopBridgeConversationRecord {
        DesktopBridgeConversationRecord {
            id: "bridge:host-1:peer-1:person".to_string(),
            host_id: "host-1".to_string(),
            peer_node_id: "peer-1".to_string(),
            peer_display_name: Some("Peer".to_string()),
            peer_owner_name: Some("Peer".to_string()),
            peer_runtime: "person".to_string(),
            project_id: None,
            project_name: None,
            unread_count: 0,
            updated_at_ms: 1,
            peer_last_typing_at_ms: None,
            peer_last_heartbeat_at_ms: None,
            outreach: None,
            identity: None,
            messages,
        }
    }

    fn test_message(
        direction: &str,
        request_id: Option<&str>,
    ) -> crate::bridge::DesktopBridgeConversationMessageRecord {
        crate::bridge::DesktopBridgeConversationMessageRecord {
            id: format!("msg-{}", request_id.unwrap_or("none")),
            direction: direction.to_string(),
            sender: Some("Peer".to_string()),
            text: "hello".to_string(),
            timestamp_ms: 1,
            request_id: request_id.map(ToString::to_string),
            delivery_state: None,
            outreach: None,
        }
    }

    #[test]
    fn pending_read_receipt_request_ids_include_inbound_ids_when_unread_is_zero() {
        let conversation = test_conversation(vec![test_message(
            BRIDGE_MESSAGE_DIRECTION_INBOUND,
            Some("req-1"),
        )]);

        assert_eq!(
            pending_read_receipt_request_ids(&conversation),
            vec!["req-1".to_string()]
        );
    }

    #[test]
    fn pending_read_receipt_request_ids_deduplicate_and_skip_outbound() {
        let conversation = test_conversation(vec![
            test_message(BRIDGE_MESSAGE_DIRECTION_INBOUND, Some("req-1")),
            test_message(BRIDGE_MESSAGE_DIRECTION_INBOUND, Some("req-1")),
            test_message(BRIDGE_MESSAGE_DIRECTION_OUTBOUND, Some("req-out")),
            test_message(BRIDGE_MESSAGE_DIRECTION_INBOUND, None),
        ]);

        assert_eq!(
            pending_read_receipt_request_ids(&conversation),
            vec!["req-1".to_string()]
        );
    }

    fn test_outreach(parent_turn_id: Option<&str>) -> DesktopBridgeOutreachMetadata {
        DesktopBridgeOutreachMetadata {
            target_kind: "bridge-person".to_string(),
            parent_session_id: Some("session-1".to_string()),
            parent_session_title: Some("Shared".to_string()),
            parent_session_messages: Vec::new(),
            parent_turn_id: parent_turn_id.map(ToString::to_string),
            parent_message_id: Some("msg-user".to_string()),
            bridge_host_id: "host-1".to_string(),
            bridge_conversation_id: Some("bridge:host-1:peer-1:person".to_string()),
            bridge_request_id: Some("bridge_req_1".to_string()),
            delivery_state: None,
            target_node_id: "peer-1".to_string(),
            target_human_id: Some("human-peer".to_string()),
            target_agent_id: None,
            target_display_name: "Peer".to_string(),
            target_owner_name: Some("Peer".to_string()),
            target_runtime: Some("person".to_string()),
            request_text: "hello".to_string(),
            trigger_text: None,
            context_text: None,
            context_policy: Some("session-relay".to_string()),
            project_id: None,
            project_name: None,
            status: "completed".to_string(),
            created_at_ms: 1,
            updated_at_ms: 1,
            completed_at_ms: Some(1),
            error: None,
        }
    }

    #[test]
    fn outbound_direction_marks_session_relay_agent_turn_as_response() {
        let agent_turn_outreach = test_outreach(Some("turn-1"));
        let human_outreach = test_outreach(None);

        assert_eq!(
            outbound_direction(Some(&agent_turn_outreach)),
            BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
        );
        assert_eq!(
            outbound_direction(Some(&human_outreach)),
            BRIDGE_MESSAGE_DIRECTION_OUTBOUND
        );
    }

    #[test]
    fn read_receipt_payload_uses_delivery_event_read_state() {
        let payload = read_receipt_payload("node-me", "req-1");

        assert_eq!(payload["from"], serde_json::json!("node-me"));
        assert_eq!(
            payload["messageType"],
            serde_json::json!(BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT)
        );
        assert_eq!(payload["payload"]["requestId"], serde_json::json!("req-1"));
        assert_eq!(
            payload["payload"]["state"],
            serde_json::json!(BRIDGE_DELIVERY_STATE_READ)
        );
    }
}
