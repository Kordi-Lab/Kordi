use base64::Engine;
use serde_json::Value;
use std::path::Path;
use uuid::Uuid;

use super::constants::{
    is_agent_like_runtime, is_inbound_message_direction, API_STYLE_SERVE,
    BRIDGE_AGENT_SESSION_MESSAGE_TIMEOUT_MS, BRIDGE_AGENT_SESSION_MESSAGE_TIMEOUT_TEXT,
    BRIDGE_DELIVERY_STATE_READ, BRIDGE_DELIVERY_STATE_RESPONDED, BRIDGE_DELIVERY_STATE_SENT,
    BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE, BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
    BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE, BRIDGE_MESSAGE_TYPE_ASK,
    BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT, BRIDGE_MESSAGE_TYPE_HEARTBEAT, BRIDGE_MESSAGE_TYPE_RAW,
    BRIDGE_MESSAGE_TYPE_RESPONSE, BRIDGE_MESSAGE_TYPE_TYPING, BRIDGE_REQUEST_ID_PREFIX,
    DEFAULT_BRIDGE_RUNTIME,
};
use super::events::sender_name_for_runtime;
use super::outreach::mark_outreach_status;
use super::realtime::send_realtime_or_relay;
use super::{
    add_serve_contact, append_conversation_message_to_storage_with_timestamp,
    build_conversation_only_bridge_state, current_local_server_status,
    default_contact_request_message, default_display_name, fetch_serve_contact_requests,
    fetch_serve_contacts, fetch_serve_discovery, load_bridge_store, load_conversation_store,
    mark_bridge_conversation_read_in_storage, now_ms, relay_plaintext_message,
    save_conversation_store, send_realtime_payload, update_message_delivery_state_in_storage,
    DesktopBridgeContactRequest, DesktopBridgeConversationRecord, DesktopBridgeConversationStore,
    DesktopBridgeHostConfig, DesktopBridgeLocalServerStatus, DesktopBridgeManager,
    DesktopBridgeMessageAttachment, DesktopBridgeOutreachMetadata, DesktopBridgePeer,
    DesktopBridgeState, DesktopBridgeStore,
};

const MAX_BRIDGE_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;

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

fn should_fallback_direct_realtime_to_relay(
    outreach: Option<&DesktopBridgeOutreachMetadata>,
) -> bool {
    outreach
        .and_then(|outreach| outreach.context_policy.as_deref())
        .map(str::trim)
        .is_some_and(|policy| {
            policy.eq_ignore_ascii_case("session-relay")
                || policy.eq_ignore_ascii_case("session-message")
                || policy.eq_ignore_ascii_case("session-invite")
                || policy.eq_ignore_ascii_case("session-update")
                || policy.eq_ignore_ascii_case("session-title-update")
        })
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

fn rebuild_conversation_state(
    store: DesktopBridgeStore,
    conversations: DesktopBridgeConversationStore,
    local_server: DesktopBridgeLocalServerStatus,
    sync_canonical_sessions: bool,
) -> DesktopBridgeState {
    let state = build_conversation_only_bridge_state(store, conversations, local_server);
    if sync_canonical_sessions {
        if let Err(error) = crate::canonical_sessions::sync_bridge_state_sessions(&state) {
            eprintln!("Unable to sync bridge sessions into canonical sessions: {error}");
        }
    }
    state
}

pub(super) async fn rebuild_state(
    manager: &DesktopBridgeManager,
    store: DesktopBridgeStore,
    conversations: DesktopBridgeConversationStore,
) -> Result<DesktopBridgeState, String> {
    Ok(rebuild_conversation_state(
        store,
        conversations,
        current_local_server_status(manager).await,
        true,
    ))
}

pub(super) async fn rebuild_state_after_mailbox_poll(
    manager: &DesktopBridgeManager,
    store: DesktopBridgeStore,
    conversations: DesktopBridgeConversationStore,
    storage_changed: bool,
) -> Result<DesktopBridgeState, String> {
    let sync_now_ms = now_ms();
    let timed_out_conversations =
        mark_bridge_agent_session_message_timeouts_in_storage(&conversations, sync_now_ms)?;
    let timeout_storage_changed = timed_out_conversations.is_some();
    let conversations = timed_out_conversations.unwrap_or(conversations);
    let should_sync_canonical = storage_changed || timeout_storage_changed;
    Ok(rebuild_conversation_state(
        store,
        conversations,
        current_local_server_status(manager).await,
        should_sync_canonical,
    ))
}

fn is_processing_placeholder_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.eq_ignore_ascii_case("processing")
        || trimmed.eq_ignore_ascii_case("processing...")
        || trimmed.eq_ignore_ascii_case("processing…")
}

fn bridge_message_request_id(
    message: &crate::bridge::DesktopBridgeConversationMessageRecord,
) -> Option<&str> {
    message
        .request_id
        .as_deref()
        .or_else(|| {
            message
                .outreach
                .as_ref()
                .and_then(|outreach| outreach.bridge_request_id.as_deref())
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn delivery_state_is_terminal_agent_request(delivery_state: Option<&str>) -> bool {
    delivery_state.map(str::trim).is_some_and(|state| {
        state.eq_ignore_ascii_case(BRIDGE_DELIVERY_STATE_RESPONDED)
            || state.eq_ignore_ascii_case("processing_failed")
            || state.eq_ignore_ascii_case("failed")
            || state.eq_ignore_ascii_case("cancelled")
    })
}

fn delivery_state_is_terminal_agent_response(delivery_state: Option<&str>) -> bool {
    delivery_state.map(str::trim).is_some_and(|state| {
        state.eq_ignore_ascii_case(BRIDGE_DELIVERY_STATE_RESPONDED)
            || state.eq_ignore_ascii_case("processing_failed")
            || state.eq_ignore_ascii_case("failed")
            || state.eq_ignore_ascii_case("cancelled")
            || state.eq_ignore_ascii_case(BRIDGE_DELIVERY_STATE_READ)
    })
}

fn has_terminal_bridge_agent_response(
    conversation: &DesktopBridgeConversationRecord,
    request_id: &str,
) -> bool {
    conversation.messages.iter().any(|message| {
        let same_request = message
            .request_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| value == request_id);
        if !same_request
            || !matches!(
                message.direction.as_str(),
                BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE
                    | BRIDGE_MESSAGE_DIRECTION_OUTBOUND_RESPONSE
            )
        {
            return false;
        }

        delivery_state_is_terminal_agent_response(message.delivery_state.as_deref())
            || (!is_processing_placeholder_text(&message.text) && !message.text.trim().is_empty())
    })
}

fn bridge_agent_timeout_marked(outreach: &DesktopBridgeOutreachMetadata) -> bool {
    outreach.status.trim().eq_ignore_ascii_case("failed")
        && outreach
            .error
            .as_deref()
            .map(str::trim)
            .is_some_and(|error| error == BRIDGE_AGENT_SESSION_MESSAGE_TIMEOUT_TEXT)
}

fn bridge_agent_session_message_timeout_due_for_message(
    conversation: &DesktopBridgeConversationRecord,
    message: &crate::bridge::DesktopBridgeConversationMessageRecord,
    sync_now_ms: i64,
) -> bool {
    if message.direction.as_str() != BRIDGE_MESSAGE_DIRECTION_OUTBOUND {
        return false;
    }
    let Some(outreach) = message.outreach.as_ref() else {
        return false;
    };
    let is_bridge_agent_session_message = outreach.target_kind == "bridge-agent"
        && outreach
            .context_policy
            .as_deref()
            .map(str::trim)
            .is_some_and(|policy| policy.eq_ignore_ascii_case("session-message"));
    if !is_bridge_agent_session_message
        || bridge_agent_timeout_marked(outreach)
        || delivery_state_is_terminal_agent_request(message.delivery_state.as_deref())
        || sync_now_ms.saturating_sub(message.timestamp_ms)
            < BRIDGE_AGENT_SESSION_MESSAGE_TIMEOUT_MS
    {
        return false;
    }
    let Some(request_id) = bridge_message_request_id(message) else {
        return false;
    };
    !has_terminal_bridge_agent_response(conversation, request_id)
}

fn bridge_agent_session_message_timeout_due(
    conversations: &DesktopBridgeConversationStore,
    sync_now_ms: i64,
) -> bool {
    conversations.conversations.iter().any(|conversation| {
        conversation.messages.iter().any(|message| {
            bridge_agent_session_message_timeout_due_for_message(conversation, message, sync_now_ms)
        })
    })
}

fn mark_bridge_agent_session_message_timeouts_in_storage(
    conversations: &DesktopBridgeConversationStore,
    sync_now_ms: i64,
) -> Result<Option<DesktopBridgeConversationStore>, String> {
    if !bridge_agent_session_message_timeout_due(conversations, sync_now_ms) {
        return Ok(None);
    }

    let mut store = load_conversation_store();
    let mut changed = false;
    for conversation in &mut store.conversations {
        let conversation_snapshot = conversation.clone();
        for message in &mut conversation.messages {
            if !bridge_agent_session_message_timeout_due_for_message(
                &conversation_snapshot,
                message,
                sync_now_ms,
            ) {
                continue;
            }
            if let Some(outreach) = message.outreach.as_mut() {
                outreach.status = "failed".to_string();
                outreach.delivery_state = Some("processing_failed".to_string());
                outreach.error = Some(BRIDGE_AGENT_SESSION_MESSAGE_TIMEOUT_TEXT.to_string());
                outreach.updated_at_ms = sync_now_ms;
                outreach.completed_at_ms = Some(sync_now_ms);
                changed = true;
            }
        }
    }

    if !changed {
        return Ok(None);
    }
    save_conversation_store(&store)?;
    Ok(Some(store))
}

fn should_retry_direct_serve_with_contact_fallback(
    context: &ConversationContext,
    error: &str,
) -> bool {
    context.host.api_style == API_STYLE_SERVE
        && context.conversation.project_id.is_none()
        && error.contains("HTTP 403")
}

async fn add_direct_contact_for_context(context: &ConversationContext) -> Result<(), String> {
    let message = default_contact_request_message(&context.host);
    add_serve_contact(
        &context.host.coordination,
        &context.host.api_key,
        &context.conversation.peer_node_id,
        Some(&message),
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectPersonContactGateAction {
    Allow,
    SendRequest,
    BlockPendingOutgoing,
    BlockPendingIncoming,
    BlockRejected,
}

fn conversation_is_group_session_transport(conversation: &DesktopBridgeConversationRecord) -> bool {
    conversation
        .outreach
        .as_ref()
        .is_some_and(outreach_targets_group_session)
}

fn direct_person_messages_require_contact_gate(context: &ConversationContext) -> bool {
    context.host.api_style == API_STYLE_SERVE
        && context.conversation.project_id.is_none()
        && !conversation_is_group_session_transport(&context.conversation)
        && context
            .conversation
            .peer_runtime
            .trim()
            .eq_ignore_ascii_case("person")
}

fn target_is_approved_contact(contacts: &[DesktopBridgePeer], target_node_id: &str) -> bool {
    contacts
        .iter()
        .any(|contact| contact.node_id == target_node_id)
}

fn contact_request_matches_target(
    request: &DesktopBridgeContactRequest,
    local_node_id: &str,
    target_node_id: &str,
) -> bool {
    (request.requester_node_id == local_node_id && request.target_node_id == target_node_id)
        || (request.requester_node_id == target_node_id && request.target_node_id == local_node_id)
}

fn target_allows_unapproved_person_messages(target_peer: Option<&DesktopBridgePeer>) -> bool {
    let Some(peer) = target_peer else {
        return false;
    };
    peer.human_visibility_policy.as_deref() == Some("server-open")
        && peer.contact_approval_policy.as_deref() == Some("auto")
}

fn direct_person_contact_gate_action(
    context: &ConversationContext,
    contacts: &[DesktopBridgePeer],
    contact_requests: &[DesktopBridgeContactRequest],
    target_peer: Option<&DesktopBridgePeer>,
) -> DirectPersonContactGateAction {
    if !direct_person_messages_require_contact_gate(context) {
        return DirectPersonContactGateAction::Allow;
    }

    let target_node_id = context.conversation.peer_node_id.as_str();
    if target_is_approved_contact(contacts, target_node_id) {
        return DirectPersonContactGateAction::Allow;
    }

    if let Some(request) = contact_requests.iter().find(|request| {
        contact_request_matches_target(request, &context.host.node_id, target_node_id)
    }) {
        let status = request.status.trim().to_ascii_lowercase();
        if status == "approved" {
            return DirectPersonContactGateAction::Allow;
        }
        if status == "pending" && request.direction == "outgoing" {
            return DirectPersonContactGateAction::BlockPendingOutgoing;
        }
        if status == "pending" && request.direction == "incoming" {
            return DirectPersonContactGateAction::BlockPendingIncoming;
        }
        if status == "rejected" {
            return DirectPersonContactGateAction::BlockRejected;
        }
    }

    if target_allows_unapproved_person_messages(target_peer) {
        return DirectPersonContactGateAction::Allow;
    }

    DirectPersonContactGateAction::SendRequest
}

fn direct_person_contact_gate_message(
    action: DirectPersonContactGateAction,
) -> Option<&'static str> {
    match action {
        DirectPersonContactGateAction::Allow => None,
        DirectPersonContactGateAction::SendRequest => {
            Some("Contact request sent. They need to approve it before messages can be delivered.")
        }
        DirectPersonContactGateAction::BlockPendingOutgoing => Some(
            "Contact request is pending. They need to approve it before messages can be delivered.",
        ),
        DirectPersonContactGateAction::BlockPendingIncoming => {
            Some("Approve this contact request before sending messages.")
        }
        DirectPersonContactGateAction::BlockRejected => {
            Some("Contact request was rejected, so messages are blocked.")
        }
    }
}

async fn ensure_direct_person_contact_approved(
    context: &ConversationContext,
) -> Result<(), String> {
    if !direct_person_messages_require_contact_gate(context) {
        return Ok(());
    }

    let contacts = fetch_serve_contacts(&context.host.coordination, &context.host.api_key)
        .await
        .unwrap_or_default();
    let contact_requests =
        fetch_serve_contact_requests(&context.host.coordination, &context.host.api_key)
            .await
            .unwrap_or_default();
    let discovery_peers = fetch_serve_discovery(&context.host.coordination, &context.host.api_key)
        .await
        .unwrap_or_default();
    let target_peer = discovery_peers
        .iter()
        .find(|peer| peer.node_id == context.conversation.peer_node_id);

    let action =
        direct_person_contact_gate_action(context, &contacts, &contact_requests, target_peer);
    if action == DirectPersonContactGateAction::SendRequest {
        add_direct_contact_for_context(context).await?;
    }
    if let Some(message) = direct_person_contact_gate_message(action) {
        return Err(message.to_string());
    }
    Ok(())
}

async fn relay_with_contact_fallback(
    context: &ConversationContext,
    payload: &Value,
) -> Result<(), String> {
    let project_id = context.conversation.project_id.as_deref();

    match relay_plaintext_message(
        &context.host,
        &context.conversation.peer_node_id,
        project_id,
        payload,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(error) if should_retry_direct_serve_with_contact_fallback(context, &error) => {
            add_direct_contact_for_context(context).await?;
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

async fn send_realtime_with_contact_fallback(
    manager: &DesktopBridgeManager,
    context: &ConversationContext,
    payload: &Value,
    durable: bool,
) -> Result<(), String> {
    match send_realtime_payload(
        manager,
        &context.host,
        &context.conversation.peer_node_id,
        payload,
        durable,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(error) if should_retry_direct_serve_with_contact_fallback(context, &error) => {
            add_direct_contact_for_context(context).await?;
            send_realtime_payload(
                manager,
                &context.host,
                &context.conversation.peer_node_id,
                payload,
                durable,
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
        if let Err(realtime_error) =
            send_realtime_with_contact_fallback(manager, context, &payload, false).await
        {
            eprintln!(
                "Bridge read receipt realtime send failed; conversation_id={}, target_node_id={}, request_id={}, error={}",
                context.conversation.id,
                context.conversation.peer_node_id,
                request_id,
                realtime_error
            );
        }
        return Ok(());
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

fn bridge_attachment_from_stored(
    attachment: crate::chat::DesktopStoredChatAttachment,
) -> DesktopBridgeMessageAttachment {
    DesktopBridgeMessageAttachment {
        kind: attachment.kind,
        name: attachment.name,
        format_label: attachment.format_label,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        local_path: Some(attachment.path),
    }
}

fn expand_local_attachment_path(path: &str) -> std::path::PathBuf {
    if path == "~" {
        return std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| Path::new(path).to_path_buf());
    }
    if let Some(suffix) = path.strip_prefix("~/") {
        return std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .map(|home| home.join(suffix))
            .unwrap_or_else(|| Path::new(path).to_path_buf());
    }
    Path::new(path).to_path_buf()
}

fn attachment_display_name(raw_name: Option<&String>, fallback: &str) -> String {
    raw_name
        .map(|name| Path::new(name))
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn bridge_attachment_payloads_from_paths(
    attachment_paths: &[String],
    attachment_names: &[String],
) -> Result<(Vec<DesktopBridgeMessageAttachment>, Vec<Value>), String> {
    let mut records = Vec::new();
    let mut payloads = Vec::new();
    for (index, raw_path) in attachment_paths.iter().enumerate() {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = expand_local_attachment_path(trimmed);
        let mut stored = crate::chat::stored_chat_attachment_from_path(&path)?;
        stored.name = attachment_display_name(attachment_names.get(index), &stored.name);
        if stored.size_bytes.unwrap_or(0) > MAX_BRIDGE_ATTACHMENT_BYTES {
            return Err(format!(
                "Bridge attachment is too large: {} exceeds {} MB",
                stored.name,
                MAX_BRIDGE_ATTACHMENT_BYTES / 1024 / 1024
            ));
        }
        let bytes = std::fs::read(&path)
            .map_err(|err| format!("Unable to read bridge attachment {}: {err}", path.display()))?;
        let record = bridge_attachment_from_stored(stored);
        payloads.push(serde_json::json!({
            "kind": record.kind.clone(),
            "name": record.name.clone(),
            "formatLabel": record.format_label.clone(),
            "mimeType": record.mime_type.clone(),
            "sizeBytes": record.size_bytes,
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
        records.push(record);
    }
    Ok((records, payloads))
}

fn outbound_payload(
    context: &ConversationContext,
    request_id: &str,
    message: &str,
    attachments: &[Value],
    outreach: Option<&DesktopBridgeOutreachMetadata>,
    sent_at_ms: i64,
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
                    "parentSessionKind": outreach.parent_session_kind.as_deref(),
                    "parentGroupSpaceId": outreach.parent_group_space_id.as_deref(),
                    "participants": &outreach.parent_session_participants,
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
        if !attachments.is_empty() {
            payload["attachments"] = serde_json::json!(attachments);
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
            "sentAtMs": sent_at_ms,
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
        if !attachments.is_empty() {
            payload["attachments"] = serde_json::json!(attachments);
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
            "sentAtMs": sent_at_ms,
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
        send_realtime_with_contact_fallback(manager, &context, &payload, false).await?;
    } else {
        relay_with_contact_fallback(&context, &payload).await?;
    }
    rebuild_state(manager, store, conversations).await
}

fn outreach_targets_group_session(outreach: &DesktopBridgeOutreachMetadata) -> bool {
    outreach
        .parent_session_kind
        .as_deref()
        .map(str::trim)
        .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
        || outreach
            .parent_group_space_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || outreach
            .parent_session_id
            .as_deref()
            .is_some_and(|id| id.starts_with("session:group:"))
}

async fn fanout_remote_agent_cancellation_status(
    manager: &DesktopBridgeManager,
    context: &ConversationContext,
    outreach: &DesktopBridgeOutreachMetadata,
    request_id: &str,
) {
    if !outreach_targets_group_session(outreach) {
        return;
    }
    if outreach.target_kind.trim() != "bridge-agent" {
        return;
    }
    let host_node_id = context.host.node_id.trim();
    let target_node_id = outreach.target_node_id.trim();
    let now = now_ms();

    let session_thread = serde_json::json!({
        "parentSessionId": outreach.parent_session_id.as_deref(),
        "parentSessionTitle": outreach.parent_session_title.as_deref(),
        "parentSessionKind": outreach.parent_session_kind.as_deref(),
        "parentGroupSpaceId": outreach.parent_group_space_id.as_deref(),
        "participants": &outreach.parent_session_participants,
        "parentTurnId": request_id,
        "parentMessageId": outreach.parent_message_id.as_deref(),
        "targetKind": outreach.target_kind.as_str(),
        "targetDisplayName": outreach.target_display_name.as_str(),
        "targetNodeId": outreach.target_node_id.as_str(),
        "requestText": outreach.request_text.as_str(),
        "contextPolicy": "session-relay",
    });

    for participant in &outreach.parent_session_participants {
        let Some(peer_node_id) = participant
            .bridge_node_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        if peer_node_id == host_node_id || peer_node_id == target_node_id {
            continue;
        }
        let payload = serde_json::json!({
            "from": context.host.node_id,
            "fromDisplayName": outreach.target_display_name,
            "fromOwnerName": outreach.target_owner_name,
            "fromRuntime": outreach.target_runtime.as_deref().unwrap_or("kordi-desktop"),
            "fromHumanId": outreach.target_human_id,
            "fromAgentId": outreach.target_agent_id,
            "projectId": outreach.project_id,
            "messageType": BRIDGE_MESSAGE_TYPE_RESPONSE,
            "requestId": request_id,
            "sentAtMs": now,
            "payload": {
                "message": "Stopped",
                "done": true,
                "deliveryState": "cancelled",
                "sessionThread": session_thread.clone(),
            },
        });
        if let Err(error) = send_realtime_or_relay(
            manager,
            &context.host,
            peer_node_id,
            outreach.project_id.as_deref(),
            &payload,
        )
        .await
        {
            eprintln!(
                "Bridge cancellation fanout failed; host={}, target={}, request_id={}, error={}",
                context.host.id, peer_node_id, request_id, error
            );
        }
    }
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
            true,
        )
        .await;
    } else {
        let _ = relay_with_contact_fallback(&context, &cancelled).await;
    }

    if let Some(outreach) = context.conversation.outreach.clone() {
        fanout_remote_agent_cancellation_status(manager, &context, &outreach, &request_id).await;
    }

    rebuild_state(manager, bridge_store, load_conversation_store()).await
}

pub(super) async fn desktop_bridge_send_message_impl(
    manager: &DesktopBridgeManager,
    conversation_id: String,
    text: String,
    attachment_paths: Vec<String>,
    attachment_names: Vec<String>,
) -> Result<DesktopBridgeState, String> {
    let message = text.trim();
    if message.is_empty() && attachment_paths.is_empty() {
        return Err("Bridge message cannot be empty".to_string());
    }

    let (store, _conversations, context) = load_conversation_context(&conversation_id)?;
    ensure_direct_person_contact_approved(&context).await?;
    let (attachments, attachment_payloads) =
        bridge_attachment_payloads_from_paths(&attachment_paths, &attachment_names)?;
    let fresh_outreach_for_message = context.conversation.outreach.clone().filter(|outreach| {
        outreach.request_text.trim() == message
            && now_ms().saturating_sub(outreach.created_at_ms) < 30_000
    });
    let request_id = fresh_outreach_for_message
        .as_ref()
        .and_then(|outreach| outreach.bridge_request_id.clone())
        .unwrap_or_else(|| format!("{}{}", BRIDGE_REQUEST_ID_PREFIX, Uuid::new_v4().simple()));
    let sent_at_ms = now_ms();
    let payload = outbound_payload(
        &context,
        &request_id,
        message,
        &attachment_payloads,
        fresh_outreach_for_message.as_ref(),
        sent_at_ms,
    );

    if is_realtime_direct_chat(&context.conversation, &context.host) {
        let realtime_result =
            send_realtime_with_contact_fallback(manager, &context, &payload, true).await;
        if let Err(error) = realtime_result {
            if should_fallback_direct_realtime_to_relay(fresh_outreach_for_message.as_ref()) {
                relay_with_contact_fallback(&context, &payload).await?;
            } else {
                return Err(error);
            }
        }
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

    append_conversation_message_to_storage_with_timestamp(
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
        attachments,
        false,
        Some(sent_at_ms),
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
    use crate::bridge::{DesktopBridgeAgentRouting, DesktopBridgeLocalServerStatus};

    fn test_conversation(
        messages: Vec<crate::bridge::DesktopBridgeConversationMessageRecord>,
    ) -> DesktopBridgeConversationRecord {
        test_conversation_with_runtime("person", None, messages)
    }

    fn test_conversation_with_runtime(
        peer_runtime: &str,
        project_id: Option<&str>,
        messages: Vec<crate::bridge::DesktopBridgeConversationMessageRecord>,
    ) -> DesktopBridgeConversationRecord {
        DesktopBridgeConversationRecord {
            id: "bridge:host-1:peer-1:person".to_string(),
            host_id: "host-1".to_string(),
            peer_node_id: "peer-1".to_string(),
            peer_display_name: Some("Peer".to_string()),
            peer_owner_name: Some("Peer".to_string()),
            peer_runtime: peer_runtime.to_string(),
            project_id: project_id.map(ToString::to_string),
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

    fn test_host(api_style: &str) -> DesktopBridgeHostConfig {
        DesktopBridgeHostConfig {
            id: "host-1".to_string(),
            coordination: "http://127.0.0.1:17080".to_string(),
            node_id: "self-1".to_string(),
            api_key: "secret".to_string(),
            display_name: Some("Self".to_string()),
            owner: Some("Self".to_string()),
            human_id: Some("human-self".to_string()),
            discovery_mode: "open".to_string(),
            human_visibility_policy: "server-approval".to_string(),
            contact_approval_policy: "approval-required".to_string(),
            active_agent_id: None,
            agents: Vec::new(),
            api_style: api_style.to_string(),
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
            attachments: Vec::new(),
        }
    }

    #[test]
    fn direct_realtime_agent_send_retries_contact_fallback_after_forbidden_keys() {
        let context = ConversationContext {
            conversation: test_conversation_with_runtime(DEFAULT_BRIDGE_RUNTIME, None, Vec::new()),
            host: test_host(API_STYLE_SERVE),
        };

        assert!(should_retry_direct_serve_with_contact_fallback(
            &context,
            "Unable to fetch bridge recipient keys: HTTP 403 Forbidden",
        ));
    }

    #[test]
    fn project_realtime_forbidden_keys_do_not_use_direct_contact_fallback() {
        let context = ConversationContext {
            conversation: test_conversation_with_runtime(
                DEFAULT_BRIDGE_RUNTIME,
                Some("project-1"),
                Vec::new(),
            ),
            host: test_host(API_STYLE_SERVE),
        };

        assert!(!should_retry_direct_serve_with_contact_fallback(
            &context,
            "Unable to fetch bridge recipient keys: HTTP 403 Forbidden",
        ));
    }

    fn test_peer_with_policy(
        node_id: &str,
        human_visibility_policy: &str,
        contact_approval_policy: &str,
    ) -> DesktopBridgePeer {
        DesktopBridgePeer {
            node_id: node_id.to_string(),
            display_name: Some("Peer".to_string()),
            runtime: "person".to_string(),
            endpoint: String::new(),
            owner_name: Some("Peer".to_string()),
            created_at: None,
            shared_projects: Vec::new(),
            human_id: Some("human-peer".to_string()),
            agent_id: None,
            is_default_agent: false,
            discovery_mode: None,
            human_visibility_policy: Some(human_visibility_policy.to_string()),
            contact_approval_policy: Some(contact_approval_policy.to_string()),
            agent_reachability_policy: Some("contacts".to_string()),
            is_contact: false,
            contact_request_status: None,
            contact_request_direction: None,
        }
    }

    fn test_contact_request(status: &str, direction: &str) -> DesktopBridgeContactRequest {
        let (requester_node_id, target_node_id) = if direction == "incoming" {
            ("peer-1".to_string(), "self-1".to_string())
        } else {
            ("self-1".to_string(), "peer-1".to_string())
        };
        DesktopBridgeContactRequest {
            request_id: "request-1".to_string(),
            requester_node_id,
            target_node_id,
            status: status.to_string(),
            message: None,
            created_at: "2026-05-05T00:00:00Z".to_string(),
            decided_at: None,
            direction: direction.to_string(),
        }
    }

    #[test]
    fn direct_person_contact_gate_sends_request_for_approval_required_non_contact() {
        let context = ConversationContext {
            conversation: test_conversation(Vec::new()),
            host: test_host(API_STYLE_SERVE),
        };
        let peer = test_peer_with_policy("peer-1", "server-approval", "approval-required");

        assert_eq!(
            direct_person_contact_gate_action(&context, &[], &[], Some(&peer)),
            DirectPersonContactGateAction::SendRequest,
        );
    }

    #[test]
    fn group_session_person_messages_bypass_direct_contact_gate() {
        let mut conversation = test_conversation(Vec::new());
        let mut outreach = test_outreach(None);
        outreach.parent_session_kind = Some("group".to_string());
        outreach.context_policy = Some("session-message".to_string());
        conversation.outreach = Some(outreach);
        let context = ConversationContext {
            conversation,
            host: test_host(API_STYLE_SERVE),
        };
        let peer = test_peer_with_policy("peer-1", "server-approval", "approval-required");

        assert_eq!(
            direct_person_contact_gate_action(&context, &[], &[], Some(&peer)),
            DirectPersonContactGateAction::Allow,
        );
    }

    #[test]
    fn direct_person_contact_gate_blocks_pending_or_rejected_requests() {
        let context = ConversationContext {
            conversation: test_conversation(Vec::new()),
            host: test_host(API_STYLE_SERVE),
        };
        let peer = test_peer_with_policy("peer-1", "server-approval", "approval-required");

        assert_eq!(
            direct_person_contact_gate_action(
                &context,
                &[],
                &[test_contact_request("pending", "outgoing")],
                Some(&peer),
            ),
            DirectPersonContactGateAction::BlockPendingOutgoing,
        );
        assert_eq!(
            direct_person_contact_gate_action(
                &context,
                &[],
                &[test_contact_request("rejected", "outgoing")],
                Some(&peer),
            ),
            DirectPersonContactGateAction::BlockRejected,
        );
    }

    #[test]
    fn direct_person_contact_gate_allows_approved_contact_or_open_auto_target() {
        let context = ConversationContext {
            conversation: test_conversation(Vec::new()),
            host: test_host(API_STYLE_SERVE),
        };
        let open_peer = test_peer_with_policy("peer-1", "server-open", "auto");
        let contact_peer = test_peer_with_policy("peer-1", "server-approval", "approval-required");

        assert_eq!(
            direct_person_contact_gate_action(&context, &[], &[], Some(&open_peer)),
            DirectPersonContactGateAction::Allow,
        );
        assert_eq!(
            direct_person_contact_gate_action(&context, &[contact_peer], &[], None),
            DirectPersonContactGateAction::Allow,
        );
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

    #[test]
    fn cancel_fanout_recognises_group_session_outreach() {
        let mut outreach = test_outreach(None);
        assert!(!outreach_targets_group_session(&outreach));

        outreach.parent_session_kind = Some("group".to_string());
        assert!(outreach_targets_group_session(&outreach));

        outreach.parent_session_kind = None;
        outreach.parent_group_space_id = Some("session:group:root".to_string());
        assert!(outreach_targets_group_session(&outreach));

        outreach.parent_group_space_id = None;
        outreach.parent_session_id = Some("session:group:abc".to_string());
        assert!(outreach_targets_group_session(&outreach));

        outreach.parent_session_id = Some("session:bridge:humans:foo".to_string());
        assert!(!outreach_targets_group_session(&outreach));
    }

    fn test_outreach(parent_turn_id: Option<&str>) -> DesktopBridgeOutreachMetadata {
        DesktopBridgeOutreachMetadata {
            target_kind: "bridge-person".to_string(),
            parent_session_id: Some("session-1".to_string()),
            parent_session_title: Some("Shared".to_string()),
            parent_session_kind: None,
            parent_group_space_id: None,
            parent_session_participants: Vec::new(),
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
    fn mailbox_poll_rebuild_skips_canonical_sync_when_no_storage_changed() {
        let storage_root = std::env::temp_dir().join(format!(
            "kordi-mailbox-no-change-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::env::set_var("KORDI_STORAGE_ROOT", &storage_root);
        let canonical_db_path = storage_root.join("canonical-sessions.sqlite3");
        let store = DesktopBridgeStore {
            active_host_id: Some("host-1".to_string()),
            local_agent_routing: DesktopBridgeAgentRouting::default(),
            hosts: vec![test_host("registry")],
        };
        let conversations = DesktopBridgeConversationStore {
            conversations: vec![test_conversation(Vec::new())],
        };

        let state = rebuild_conversation_state(
            store.clone(),
            conversations.clone(),
            DesktopBridgeLocalServerStatus::default(),
            false,
        );

        assert_eq!(state.conversations.len(), 1);
        assert!(
            !canonical_db_path.exists(),
            "empty mailbox polls should not open/sync the canonical sessions database"
        );

        let _synced_state = rebuild_conversation_state(
            store,
            conversations,
            DesktopBridgeLocalServerStatus::default(),
            true,
        );
        assert!(
            canonical_db_path.exists(),
            "changed mailbox polls should still sync canonical sessions"
        );

        std::env::remove_var("KORDI_STORAGE_ROOT");
        let _ = std::fs::remove_dir_all(storage_root);
    }

    #[test]
    fn bridge_agent_session_message_timeout_due_requires_stale_unanswered_agent_request() {
        fn agent_session_message(
            timestamp_ms: i64,
            delivery_state: &str,
        ) -> crate::bridge::DesktopBridgeConversationMessageRecord {
            let mut outreach = test_outreach(None);
            outreach.target_kind = "bridge-agent".to_string();
            outreach.target_runtime = Some("kordi-desktop".to_string());
            outreach.target_agent_id = Some("agent-peer".to_string());
            outreach.context_policy = Some("session-message".to_string());
            outreach.bridge_request_id = Some("bridge_req_timeout".to_string());
            outreach.delivery_state = Some(delivery_state.to_string());
            let mut message = test_message(
                BRIDGE_MESSAGE_DIRECTION_OUTBOUND,
                Some("bridge_req_timeout"),
            );
            message.timestamp_ms = timestamp_ms;
            message.delivery_state = Some(delivery_state.to_string());
            message.outreach = Some(outreach);
            message
        }

        let now = crate::bridge::BRIDGE_AGENT_SESSION_MESSAGE_TIMEOUT_MS + 2_000;
        let due = DesktopBridgeConversationStore {
            conversations: vec![test_conversation_with_runtime(
                "kordi-desktop",
                None,
                vec![agent_session_message(1, BRIDGE_DELIVERY_STATE_SENT)],
            )],
        };
        assert!(bridge_agent_session_message_timeout_due(&due, now));

        let read_but_unanswered = DesktopBridgeConversationStore {
            conversations: vec![test_conversation_with_runtime(
                "kordi-desktop",
                None,
                vec![agent_session_message(1, BRIDGE_DELIVERY_STATE_READ)],
            )],
        };
        assert!(bridge_agent_session_message_timeout_due(
            &read_but_unanswered,
            now
        ));

        let fresh = DesktopBridgeConversationStore {
            conversations: vec![test_conversation_with_runtime(
                "kordi-desktop",
                None,
                vec![agent_session_message(
                    now - 1_000,
                    BRIDGE_DELIVERY_STATE_SENT,
                )],
            )],
        };
        assert!(!bridge_agent_session_message_timeout_due(&fresh, now));

        let mut marked_message = agent_session_message(1, BRIDGE_DELIVERY_STATE_SENT);
        if let Some(outreach) = marked_message.outreach.as_mut() {
            outreach.status = "failed".to_string();
            outreach.error = Some(BRIDGE_AGENT_SESSION_MESSAGE_TIMEOUT_TEXT.to_string());
        }
        let already_marked = DesktopBridgeConversationStore {
            conversations: vec![test_conversation_with_runtime(
                "kordi-desktop",
                None,
                vec![marked_message],
            )],
        };
        assert!(!bridge_agent_session_message_timeout_due(
            &already_marked,
            now
        ));

        let mut response = test_message(
            BRIDGE_MESSAGE_DIRECTION_INBOUND_RESPONSE,
            Some("bridge_req_timeout"),
        );
        response.delivery_state = Some(BRIDGE_DELIVERY_STATE_RESPONDED.to_string());
        let answered = DesktopBridgeConversationStore {
            conversations: vec![test_conversation_with_runtime(
                "kordi-desktop",
                None,
                vec![
                    agent_session_message(1, BRIDGE_DELIVERY_STATE_SENT),
                    response,
                ],
            )],
        };
        assert!(!bridge_agent_session_message_timeout_due(&answered, now));
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
    fn session_transport_uses_relay_fallback_when_direct_realtime_is_unavailable() {
        let mut session_message = test_outreach(None);
        session_message.context_policy = Some("session-message".to_string());
        let mut session_invite = test_outreach(None);
        session_invite.context_policy = Some("session-invite".to_string());
        let mut session_title_update = test_outreach(None);
        session_title_update.context_policy = Some("session-title-update".to_string());
        let mut ordinary_outreach = test_outreach(None);
        ordinary_outreach.context_policy = Some("recent-window".to_string());

        assert!(should_fallback_direct_realtime_to_relay(Some(
            &session_message
        )));
        assert!(should_fallback_direct_realtime_to_relay(Some(
            &session_invite
        )));
        assert!(should_fallback_direct_realtime_to_relay(Some(
            &session_title_update
        )));
        assert!(!should_fallback_direct_realtime_to_relay(Some(
            &ordinary_outreach
        )));
        assert!(!should_fallback_direct_realtime_to_relay(None));
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
