use serde_json::Value;
use uuid::Uuid;

use crate::chat::{start_bridge_agent_prompt_stream, DesktopChatManager};

use super::constants::{
    is_agent_like_runtime, is_inbound_message_direction, API_STYLE_SERVE,
    BRIDGE_DELIVERY_STATE_DELIVERED, BRIDGE_DELIVERY_STATE_READ, BRIDGE_DELIVERY_STATE_RESPONDED,
    BRIDGE_DELIVERY_STATE_SENT, BRIDGE_MESSAGE_DIRECTION_INBOUND,
    BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE, BRIDGE_MESSAGE_TYPE_ASK,
    BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_HEARTBEAT, BRIDGE_MESSAGE_TYPE_RAW,
    BRIDGE_MESSAGE_TYPE_RESPONSE, BRIDGE_MESSAGE_TYPE_TYPING, BRIDGE_REQUEST_ID_PREFIX,
    DEFAULT_BRIDGE_RUNTIME,
};
use super::{
    add_serve_contact, append_conversation_message_to_storage, bridge_conversation_id,
    build_conversation_only_bridge_state, build_current_bridge_state, current_local_server_status,
    decrypt_bridge_payload_for_host, default_display_name, fetch_mailbox, load_bridge_store,
    load_conversation_store, mark_bridge_conversation_read_in_storage,
    note_peer_heartbeat_in_storage, note_peer_typing_in_storage, now_ms, parse_mailbox_payload,
    relay_plaintext_message, save_conversation_store, send_realtime_payload,
    update_message_delivery_state_in_storage, upsert_bridge_conversation,
    DesktopBridgeConversationRecord, DesktopBridgeConversationStore,
    DesktopBridgeCreateOutreachRequest, DesktopBridgeHostConfig, DesktopBridgeIdentitySnapshot,
    DesktopBridgeManager, DesktopBridgeOutreachMetadata, DesktopBridgeState, DesktopBridgeStore,
};

#[derive(Clone)]
struct ConversationContext {
    conversation: DesktopBridgeConversationRecord,
    host: DesktopBridgeHostConfig,
}

#[derive(Clone)]
struct LocalBridgeMailboxTarget {
    host: DesktopBridgeHostConfig,
    sender_runtime: String,
    sender_agent_id: Option<String>,
    should_process_agent_asks: bool,
}

pub(super) struct ParsedMailboxEvent {
    pub(super) from_node_id: String,
    pub(super) from_display_name: Option<String>,
    pub(super) from_owner_name: Option<String>,
    pub(super) from_runtime: Option<String>,
    pub(super) message_type: String,
    pub(super) payload: Value,
    pub(super) request_id: Option<String>,
    pub(super) project_id: Option<String>,
}

fn outbound_message_type(peer_runtime: &str) -> &'static str {
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

pub(super) fn mailbox_payload_text(payload: &Value) -> String {
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
    Ok(build_conversation_only_bridge_state(
        store,
        conversations,
        current_local_server_status(manager).await,
    ))
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

fn outbound_payload(context: &ConversationContext, request_id: &str, message: &str) -> Value {
    let is_person_chat = context
        .conversation
        .peer_runtime
        .trim()
        .eq_ignore_ascii_case("person");
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
    let sender_display_name = if is_person_chat {
        context
            .host
            .owner
            .clone()
            .unwrap_or_else(default_display_name)
    } else {
        active_agent
            .map(|agent| agent.label.clone())
            .or_else(|| context.host.display_name.clone())
            .unwrap_or_else(default_display_name)
    };
    let sender_owner_name = context
        .host
        .owner
        .clone()
        .unwrap_or_else(default_display_name);
    let sender_runtime = if is_person_chat {
        "person".to_string()
    } else {
        active_agent
            .map(|agent| agent.runtime.clone())
            .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string())
    };
    let sender_agent_id = if is_person_chat {
        None
    } else {
        context.host.active_agent_id.clone()
    };
    let message_type = outbound_message_type(&context.conversation.peer_runtime);
    if message_type == BRIDGE_MESSAGE_TYPE_ASK {
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
            "payload": { "question": message },
        })
    } else {
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
            "payload": { "message": message },
        })
    }
}

pub(super) fn parse_bridge_event_payload(parsed: &Value) -> Option<ParsedMailboxEvent> {
    let from_node_id = parsed
        .get("from")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if from_node_id.is_empty() {
        return None;
    }

    Some(ParsedMailboxEvent {
        from_node_id,
        from_display_name: parsed
            .get("fromDisplayName")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        from_owner_name: parsed
            .get("fromOwnerName")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        from_runtime: parsed
            .get("fromRuntime")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
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

fn parse_mailbox_event(host: &DesktopBridgeHostConfig, item: &Value) -> Option<ParsedMailboxEvent> {
    let blob = item
        .get("blob")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if blob.trim().is_empty() {
        return None;
    }

    let mut parsed = decrypt_bridge_payload_for_host(host, parse_mailbox_payload(blob)?).ok()?;
    if parsed.get("from").is_none() {
        if let Some(from) = item.get("from") {
            parsed["from"] = from.clone();
        }
    }
    parse_bridge_event_payload(&parsed)
}

fn bridge_response_is_done(event: &ParsedMailboxEvent) -> bool {
    event
        .payload
        .get("done")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn should_buffer_partial_agent_response(event: &ParsedMailboxEvent) -> bool {
    if bridge_response_is_done(event) {
        return false;
    }
    if !is_agent_like_runtime(event.from_runtime.as_deref().unwrap_or_default()) {
        return false;
    }

    let text = mailbox_payload_text(&event.payload);
    let normalized = text.trim();
    if normalized.is_empty() {
        return true;
    }

    let word_count = normalized.split_whitespace().take(5).count();
    normalized.chars().count() < 24 && word_count <= 3
}

fn mailbox_targets(store: &DesktopBridgeStore) -> Vec<LocalBridgeMailboxTarget> {
    let mut targets: Vec<LocalBridgeMailboxTarget> = Vec::new();

    let mut upsert_target = |target: LocalBridgeMailboxTarget| {
        if let Some(existing) = targets
            .iter_mut()
            .find(|existing| existing.host.node_id == target.host.node_id)
        {
            if target.should_process_agent_asks || !existing.should_process_agent_asks {
                *existing = target;
            }
            return;
        }
        targets.push(target);
    };

    for host in &store.hosts {
        if !host.node_id.trim().is_empty() && !host.api_key.trim().is_empty() {
            upsert_target(LocalBridgeMailboxTarget {
                host: host.clone(),
                sender_runtime: "person".to_string(),
                sender_agent_id: None,
                should_process_agent_asks: false,
            });
        }

        for agent in &host.agents {
            if agent.node_id.trim().is_empty() || agent.api_key.trim().is_empty() {
                continue;
            }
            upsert_target(LocalBridgeMailboxTarget {
                host: DesktopBridgeHostConfig {
                    id: host.id.clone(),
                    coordination: host.coordination.clone(),
                    node_id: agent.node_id.clone(),
                    api_key: agent.api_key.clone(),
                    display_name: Some(agent.label.clone()),
                    owner: host.owner.clone(),
                    human_id: host.human_id.clone(),
                    discovery_mode: host.discovery_mode.clone(),
                    active_agent_id: Some(agent.id.clone()),
                    agents: vec![agent.clone()],
                    api_style: host.api_style.clone(),
                },
                sender_runtime: agent.runtime.clone(),
                sender_agent_id: Some(agent.id.clone()),
                should_process_agent_asks: true,
            });
        }
    }

    targets
}

pub(super) fn sender_name_for_runtime(
    runtime: &str,
    display_name: Option<&str>,
    owner_name: Option<&str>,
    fallback: &str,
) -> String {
    if runtime.trim().eq_ignore_ascii_case("person") {
        owner_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                display_name
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| fallback.to_string())
    } else {
        display_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .or_else(|| {
                owner_name
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| fallback.to_string())
    }
}

async fn acknowledge_inbound_delivery(host: &DesktopBridgeHostConfig, event: &ParsedMailboxEvent) {
    if let Some(request_id) = event.request_id.as_deref() {
        let ack = serde_json::json!({
            "from": host.node_id,
            "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
            "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_DELIVERED },
        });
        let _ =
            relay_plaintext_message(host, &event.from_node_id, event.project_id.as_deref(), &ack)
                .await;
    }
}

fn append_inbound_event_message_to_storage(
    host: &DesktopBridgeHostConfig,
    event: &ParsedMailboxEvent,
) -> Result<Option<String>, String> {
    let text = mailbox_payload_text(&event.payload);
    if text.trim().is_empty() {
        return Ok(None);
    }

    let conversations = load_conversation_store();
    let existing = conversations.conversations.iter().find(|conversation| {
        conversation.id
            == bridge_conversation_id(&host.id, &event.from_node_id, event.project_id.as_deref())
    });
    let peer_display_name = event
        .from_display_name
        .clone()
        .or_else(|| existing.and_then(|conversation| conversation.peer_display_name.clone()));
    let peer_owner_name = event
        .from_owner_name
        .clone()
        .or_else(|| existing.and_then(|conversation| conversation.peer_owner_name.clone()));
    let peer_runtime = event.from_runtime.clone().unwrap_or_else(|| {
        existing
            .map(|conversation| conversation.peer_runtime.clone())
            .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string())
    });
    let sender_name = sender_name_for_runtime(
        &peer_runtime,
        peer_display_name.as_deref(),
        peer_owner_name.as_deref(),
        &event.from_node_id,
    );

    append_conversation_message_to_storage(
        &host.id,
        &event.from_node_id,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        event.project_id.clone(),
        None,
        if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE {
            BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
        } else {
            BRIDGE_MESSAGE_DIRECTION_INBOUND
        },
        Some(sender_name),
        text.clone(),
        event.request_id.clone(),
        if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE {
            Some(if bridge_response_is_done(event) {
                BRIDGE_DELIVERY_STATE_RESPONDED.to_string()
            } else {
                "processing".to_string()
            })
        } else {
            None
        },
        true,
    )?;
    Ok(Some(text))
}

pub(super) async fn apply_bridge_event_to_storage(
    host: &DesktopBridgeHostConfig,
    event: ParsedMailboxEvent,
    acknowledge_delivery: bool,
) -> Result<(), String> {
    if event.message_type == BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT {
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
            update_message_delivery_state_in_storage(target_request_id, state)?;
        }
        return Ok(());
    }

    match event.message_type.as_str() {
        BRIDGE_MESSAGE_TYPE_TYPING => {
            note_peer_typing_in_storage(
                &host.id,
                &event.from_node_id,
                event.project_id.clone(),
                None,
            )?;
            return Ok(());
        }
        BRIDGE_MESSAGE_TYPE_HEARTBEAT => {
            note_peer_heartbeat_in_storage(
                &host.id,
                &event.from_node_id,
                event.project_id.clone(),
                None,
            )?;
            return Ok(());
        }
        _ => {}
    }

    if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE
        && should_buffer_partial_agent_response(&event)
    {
        note_peer_typing_in_storage(
            &host.id,
            &event.from_node_id,
            event.project_id.clone(),
            None,
        )?;
        return Ok(());
    }

    if append_inbound_event_message_to_storage(host, &event)?.is_none() {
        return Ok(());
    }

    if event.message_type == BRIDGE_MESSAGE_TYPE_RESPONSE {
        if bridge_response_is_done(&event) {
            if let Some(request_id) = event.request_id.as_deref() {
                update_message_delivery_state_in_storage(
                    request_id,
                    BRIDGE_DELIVERY_STATE_RESPONDED,
                )?;
            }
        }
    } else if acknowledge_delivery {
        acknowledge_inbound_delivery(host, &event).await;
    }
    Ok(())
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
    let has_display_name = peer_display_name
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_owner_name = peer_owner_name
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_runtime = peer_runtime
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());

    let inferred_peer = if has_display_name && has_owner_name && has_runtime {
        None
    } else {
        let current_state = build_current_bridge_state(manager).await;
        current_state
            .hosts
            .iter()
            .find(|host| host.id == host_id)
            .and_then(|host| {
                host.visible_peers
                    .iter()
                    .find(|peer| peer.node_id == peer_node_id)
            })
            .cloned()
    };

    let resolved_peer_display_name = peer_display_name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            inferred_peer
                .as_ref()
                .and_then(|peer| peer.display_name.clone())
        });
    let resolved_peer_owner_name = peer_owner_name
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            inferred_peer
                .as_ref()
                .and_then(|peer| peer.owner_name.clone())
        });
    let resolved_peer_runtime = peer_runtime
        .filter(|value| !value.trim().is_empty())
        .or_else(|| inferred_peer.as_ref().map(|peer| peer.runtime.clone()))
        .unwrap_or_else(|| DEFAULT_BRIDGE_RUNTIME.to_string());

    let mut store = load_conversation_store();
    let conversation = upsert_bridge_conversation(
        &mut store,
        &host_id,
        &peer_node_id,
        resolved_peer_display_name,
        resolved_peer_owner_name,
        resolved_peer_runtime,
        project_id,
        project_name,
    );
    conversation.unread_count = 0;
    conversation.updated_at_ms = now_ms();
    save_conversation_store(&store)?;
    Ok(build_conversation_only_bridge_state(
        load_bridge_store(),
        store,
        current_local_server_status(manager).await,
    ))
}

pub(super) async fn desktop_bridge_create_outreach_impl(
    manager: &DesktopBridgeManager,
    request: DesktopBridgeCreateOutreachRequest,
) -> Result<DesktopBridgeState, String> {
    let message = request.request_text.trim();
    if message.is_empty() {
        return Err("Outreach request cannot be empty".to_string());
    }

    let target_kind = request.target_kind.trim().to_ascii_lowercase();
    if target_kind != "bridge-agent" && target_kind != "bridge-person" {
        return Err("Outreach target kind must be bridge-agent or bridge-person".to_string());
    }

    let current_state = build_current_bridge_state(manager).await;
    let host = current_state
        .hosts
        .iter()
        .find(|host| host.id == request.host_id)
        .cloned()
        .ok_or_else(|| "Bridge host not found".to_string())?;
    let peer = host
        .visible_peers
        .iter()
        .find(|peer| peer.node_id == request.target_node_id)
        .cloned()
        .ok_or_else(|| "Bridge outreach target is not visible on this host".to_string())?;

    let peer_runtime = if target_kind == "bridge-person" {
        "person".to_string()
    } else {
        peer.runtime.clone()
    };
    if target_kind == "bridge-agent" && !is_agent_like_runtime(&peer_runtime) {
        return Err("Selected outreach target is not a bridge agent".to_string());
    }

    let now = now_ms();
    let mut store = load_conversation_store();
    let conversation = upsert_bridge_conversation(
        &mut store,
        &request.host_id,
        &request.target_node_id,
        peer.display_name.clone(),
        peer.owner_name.clone(),
        peer_runtime.clone(),
        request.project_id.clone(),
        request.project_name.clone(),
    );
    let active_agent = host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| host.agents.iter().find(|agent| agent.id == active_id))
        .or_else(|| host.agents.iter().find(|agent| agent.is_default))
        .or_else(|| host.agents.first());
    let target_display_name = peer
        .display_name
        .clone()
        .or_else(|| peer.owner_name.clone())
        .unwrap_or_else(|| peer.node_id.clone());

    conversation.outreach = Some(DesktopBridgeOutreachMetadata {
        target_kind: target_kind.clone(),
        parent_session_id: request.parent_session_id.clone(),
        parent_turn_id: request.parent_turn_id.clone(),
        parent_message_id: request.parent_message_id.clone(),
        bridge_host_id: request.host_id.clone(),
        bridge_conversation_id: Some(conversation.id.clone()),
        target_node_id: request.target_node_id.clone(),
        target_human_id: peer.human_id.clone(),
        target_agent_id: (target_kind == "bridge-agent")
            .then(|| peer.agent_id.clone())
            .flatten(),
        target_display_name: target_display_name.clone(),
        target_owner_name: peer.owner_name.clone(),
        target_runtime: Some(peer_runtime.clone()),
        request_text: message.to_string(),
        context_text: request.context_text.clone(),
        project_id: request.project_id.clone(),
        project_name: request.project_name.clone(),
        status: "awaitingReply".to_string(),
        created_at_ms: now,
        updated_at_ms: now,
        completed_at_ms: None,
        error: None,
    });
    conversation.identity = Some(DesktopBridgeIdentitySnapshot {
        bridge_host_id: request.host_id.clone(),
        local_human_id: host.human_id.clone(),
        local_human_name: host.owner_name.clone(),
        local_agent_id: active_agent.map(|agent| agent.id.clone()),
        local_agent_name: active_agent.map(|agent| agent.label.clone()),
        local_agent_node_id: host.node_id.clone(),
        remote_human_id: peer.human_id.clone(),
        remote_human_name: peer.owner_name.clone(),
        remote_human_node_id: (target_kind == "bridge-person").then(|| peer.node_id.clone()),
        remote_agent_id: (target_kind == "bridge-agent")
            .then(|| peer.agent_id.clone())
            .flatten(),
        remote_agent_name: (target_kind == "bridge-agent").then_some(target_display_name),
        remote_agent_node_id: (target_kind == "bridge-agent").then(|| peer.node_id.clone()),
        remote_agent_runtime: (target_kind == "bridge-agent").then_some(peer_runtime),
    });
    conversation.updated_at_ms = now;
    let conversation_id = conversation.id.clone();
    save_conversation_store(&store)?;

    desktop_bridge_send_message_impl(manager, conversation_id, message.to_string()).await
}

pub(super) async fn desktop_bridge_mark_conversation_read_impl(
    manager: &DesktopBridgeManager,
    conversation_id: String,
) -> Result<DesktopBridgeState, String> {
    let bridge_store = load_bridge_store();
    let store = load_conversation_store();
    let mut marked_store = None;
    if let Some(conversation) = store
        .conversations
        .iter()
        .find(|conversation| conversation.id == conversation_id)
    {
        if let Some(host) = bridge_store
            .hosts
            .iter()
            .find(|host| host.id == conversation.host_id)
            .cloned()
        {
            if is_realtime_direct_chat(conversation, &host) {
                let pending_read_receipts: Vec<String> = conversation
                    .messages
                    .iter()
                    .filter(|message| {
                        is_inbound_message_direction(&message.direction)
                            && message.request_id.is_some()
                    })
                    .filter_map(|message| message.request_id.clone())
                    .collect();
                for request_id in pending_read_receipts {
                    let payload = serde_json::json!({
                        "from": host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_READ },
                    });
                    let _ =
                        send_realtime_payload(manager, &host, &conversation.peer_node_id, &payload)
                            .await;
                }
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
    let request_id = format!("{}{}", BRIDGE_REQUEST_ID_PREFIX, Uuid::new_v4().simple());
    let payload = outbound_payload(&context, &request_id, message);

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

    let sender_name = sender_name_for_runtime(
        &context.conversation.peer_runtime,
        context.host.display_name.as_deref(),
        context.host.owner.as_deref(),
        &context.host.node_id,
    );

    append_conversation_message_to_storage(
        &context.conversation.host_id,
        &context.conversation.peer_node_id,
        context.conversation.peer_display_name.clone(),
        context.conversation.peer_owner_name.clone(),
        context.conversation.peer_runtime.clone(),
        context.conversation.project_id.clone(),
        context.conversation.project_name.clone(),
        BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
        Some(sender_name),
        message.to_string(),
        Some(request_id),
        Some(BRIDGE_DELIVERY_STATE_SENT.to_string()),
        false,
    )?;
    let conversations = mark_bridge_conversation_read_in_storage(&conversation_id)?;
    rebuild_state(manager, store, conversations).await
}

pub(super) async fn desktop_bridge_poll_mailbox_impl(
    manager: &DesktopBridgeManager,
    chat_manager: &DesktopChatManager,
) -> Result<DesktopBridgeState, String> {
    let store = load_bridge_store();

    for target in mailbox_targets(&store) {
        let mailbox = match fetch_mailbox(&target.host.coordination, &target.host.api_key).await {
            Ok(mailbox) => mailbox,
            Err(_) => continue,
        };
        if mailbox.is_empty() {
            continue;
        }

        for item in mailbox {
            let Some(event) = parse_mailbox_event(&target.host, &item) else {
                continue;
            };

            if target.should_process_agent_asks && event.message_type == BRIDGE_MESSAGE_TYPE_ASK {
                let text = mailbox_payload_text(&event.payload);
                if text.trim().is_empty() {
                    continue;
                }

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
                    peer_display_name.clone(),
                    peer_owner_name.clone(),
                    peer_runtime.clone(),
                    event.project_id.clone(),
                    None,
                    BRIDGE_MESSAGE_DIRECTION_INBOUND,
                    Some(sender_name),
                    text.clone(),
                    event.request_id.clone(),
                    Some("processing".to_string()),
                    true,
                )?;

                if let Some(request_id) = event.request_id.as_deref() {
                    let processing = serde_json::json!({
                        "from": target.host.node_id,
                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                        "payload": { "requestId": request_id, "state": "processing" },
                    });
                    let _ = relay_plaintext_message(
                        &target.host,
                        &event.from_node_id,
                        event.project_id.as_deref(),
                        &processing,
                    )
                    .await;
                }

                match start_bridge_agent_prompt_stream(
                    chat_manager,
                    &target.host.node_id,
                    &event.from_node_id,
                    text,
                )
                .await
                {
                    Ok(mut stream) => {
                        let sender_name = sender_name_for_runtime(
                            &target.sender_runtime,
                            target.host.display_name.as_deref(),
                            target.host.owner.as_deref(),
                            &target.host.node_id,
                        );
                        let mut last_sent_text = String::new();

                        while let Some(snapshot) = stream.updates.recv().await {
                            if snapshot.assistant_text == last_sent_text && !snapshot.completed {
                                continue;
                            }
                            if snapshot.assistant_text.trim().is_empty() {
                                if snapshot.completed {
                                    break;
                                }
                                continue;
                            }

                            let is_final = snapshot.completed && snapshot.succeeded;
                            last_sent_text = snapshot.assistant_text.clone();
                            append_conversation_message_to_storage(
                                &target.host.id,
                                &event.from_node_id,
                                peer_display_name.clone(),
                                peer_owner_name.clone(),
                                peer_runtime.clone(),
                                event.project_id.clone(),
                                None,
                                BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE,
                                Some(sender_name.clone()),
                                snapshot.assistant_text.clone(),
                                event.request_id.clone(),
                                Some(if is_final {
                                    BRIDGE_DELIVERY_STATE_RESPONDED.to_string()
                                } else {
                                    "processing".to_string()
                                }),
                                false,
                            )?;

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
                                "payload": { "message": snapshot.assistant_text, "done": is_final },
                            });
                            let _ = relay_plaintext_message(
                                &target.host,
                                &event.from_node_id,
                                event.project_id.as_deref(),
                                &response,
                            )
                            .await;

                            if is_final {
                                if let Some(request_id) = event.request_id.as_deref() {
                                    let responded = serde_json::json!({
                                        "from": target.host.node_id,
                                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                                        "payload": { "requestId": request_id, "state": BRIDGE_DELIVERY_STATE_RESPONDED },
                                    });
                                    let _ = relay_plaintext_message(
                                        &target.host,
                                        &event.from_node_id,
                                        event.project_id.as_deref(),
                                        &responded,
                                    )
                                    .await;
                                }
                                break;
                            }
                        }

                        match stream.completion.await {
                            Ok(Ok(final_snapshot)) if final_snapshot.succeeded => {}
                            Ok(Ok(final_snapshot)) => {
                                if let Some(request_id) = event.request_id.as_deref() {
                                    update_message_delivery_state_in_storage(
                                        request_id,
                                        "processing_failed",
                                    )?;
                                    let failed = serde_json::json!({
                                        "from": target.host.node_id,
                                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                                        "payload": {
                                            "requestId": request_id,
                                            "state": "processing_failed",
                                            "error": final_snapshot.error.unwrap_or(final_snapshot.message)
                                        },
                                    });
                                    let _ = relay_plaintext_message(
                                        &target.host,
                                        &event.from_node_id,
                                        event.project_id.as_deref(),
                                        &failed,
                                    )
                                    .await;
                                }
                            }
                            Ok(Err(error)) => {
                                if let Some(request_id) = event.request_id.as_deref() {
                                    update_message_delivery_state_in_storage(
                                        request_id,
                                        "processing_failed",
                                    )?;
                                    let failed = serde_json::json!({
                                        "from": target.host.node_id,
                                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                                        "payload": { "requestId": request_id, "state": "processing_failed", "error": error },
                                    });
                                    let _ = relay_plaintext_message(
                                        &target.host,
                                        &event.from_node_id,
                                        event.project_id.as_deref(),
                                        &failed,
                                    )
                                    .await;
                                }
                            }
                            Err(error) => {
                                if let Some(request_id) = event.request_id.as_deref() {
                                    update_message_delivery_state_in_storage(
                                        request_id,
                                        "processing_failed",
                                    )?;
                                    let failed = serde_json::json!({
                                        "from": target.host.node_id,
                                        "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                                        "payload": { "requestId": request_id, "state": "processing_failed", "error": error.to_string() },
                                    });
                                    let _ = relay_plaintext_message(
                                        &target.host,
                                        &event.from_node_id,
                                        event.project_id.as_deref(),
                                        &failed,
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                    Err(error) => {
                        if let Some(request_id) = event.request_id.as_deref() {
                            update_message_delivery_state_in_storage(
                                request_id,
                                "processing_failed",
                            )?;
                            let failed = serde_json::json!({
                                "from": target.host.node_id,
                                "messageType": BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT,
                                "payload": { "requestId": request_id, "state": "processing_failed", "error": error },
                            });
                            let _ = relay_plaintext_message(
                                &target.host,
                                &event.from_node_id,
                                event.project_id.as_deref(),
                                &failed,
                            )
                            .await;
                        }
                    }
                }

                continue;
            }

            apply_bridge_event_to_storage(&target.host, event, true).await?;
        }
    }

    rebuild_state(manager, store, load_conversation_store()).await
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

        let host = DesktopBridgeHostConfig {
            id: "host-1".to_string(),
            coordination: "http://127.0.0.1:17080".to_string(),
            node_id: "kd_self".to_string(),
            api_key: "secret".to_string(),
            display_name: Some("Self".to_string()),
            owner: Some("Owner".to_string()),
            human_id: Some("kh_self".to_string()),
            discovery_mode: "open".to_string(),
            active_agent_id: None,
            agents: Vec::new(),
            api_style: API_STYLE_SERVE.to_string(),
        };
        let event = parse_mailbox_event(&host, &item).expect("parse mailbox event");

        assert_eq!(event.from_node_id, "kd_peer");
        assert_eq!(event.message_type, BRIDGE_MESSAGE_TYPE_RESPONSE);
        assert_eq!(event.request_id.as_deref(), Some("req-1"));
        assert_eq!(event.project_id.as_deref(), Some("proj-1"));
        assert_eq!(mailbox_payload_text(&event.payload), "hello");
    }
}
