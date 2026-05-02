use base64::Engine;
use serde_json::Value;

use super::constants::{is_agent_like_runtime, BRIDGE_MESSAGE_TYPE_RAW};
use super::{
    default_display_name, default_owner_name, now_ms, DesktopBridgeHostConfig,
    DesktopBridgeIdentitySnapshot, DesktopBridgeMessageAttachment, DesktopBridgeOutreachMetadata,
};

const MAX_BRIDGE_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;

pub(super) struct ParsedMailboxEvent {
    pub(super) from_node_id: String,
    pub(super) from_display_name: Option<String>,
    pub(super) from_owner_name: Option<String>,
    pub(super) from_runtime: Option<String>,
    pub(super) from_human_id: Option<String>,
    pub(super) from_agent_id: Option<String>,
    pub(super) message_type: String,
    pub(super) payload: Value,
    pub(super) request_id: Option<String>,
    pub(super) project_id: Option<String>,
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

fn event_parent_session_id(event: &ParsedMailboxEvent) -> Option<String> {
    event
        .payload
        .get("sessionThread")
        .and_then(|thread| thread.get("parentSessionId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn sanitize_agent_response_for_event(
    event: &ParsedMailboxEvent,
    response_text: &str,
) -> String {
    let extra_labels = [
        event.from_owner_name.clone(),
        event.from_display_name.clone(),
    ]
    .into_iter()
    .flatten()
    .map(|label| label.trim().to_string())
    .filter(|label| !label.is_empty())
    .collect::<Vec<_>>();
    crate::canonical_sessions::sanitize_shared_agent_response_text(
        event_parent_session_id(event).as_deref(),
        response_text,
        &extra_labels,
    )
    .or_else(|_| {
        crate::canonical_sessions::sanitize_shared_agent_response_text(
            None,
            response_text,
            &extra_labels,
        )
    })
    .unwrap_or_else(|_| response_text.trim().to_string())
}

fn attachment_string_field<'a>(attachment: &'a Value, key: &str) -> Option<&'a str> {
    attachment
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn mailbox_payload_attachments(
    payload: &Value,
) -> Result<Vec<DesktopBridgeMessageAttachment>, String> {
    let Some(items) = payload
        .get("attachments")
        .and_then(|value| value.as_array())
    else {
        return Ok(Vec::new());
    };

    let mut attachments = Vec::new();
    for item in items {
        let name = attachment_string_field(item, "name").unwrap_or("attachment.bin");
        let decoded = attachment_string_field(item, "dataBase64")
            .map(|data| {
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|err| format!("Invalid bridge attachment data for {name}: {err}"))
            })
            .transpose()?;
        if decoded
            .as_ref()
            .is_some_and(|data| data.len() > MAX_BRIDGE_ATTACHMENT_BYTES)
        {
            return Err(format!(
                "Bridge attachment is too large: {name} exceeds {} MB",
                MAX_BRIDGE_ATTACHMENT_BYTES / 1024 / 1024
            ));
        }
        let stored = decoded
            .as_ref()
            .map(|data| crate::chat::store_chat_attachment_bytes(name, data))
            .transpose()?;

        let kind = attachment_string_field(item, "kind")
            .map(ToString::to_string)
            .or_else(|| stored.as_ref().map(|attachment| attachment.kind.clone()))
            .unwrap_or_else(|| "file".to_string());
        let stored_name = name.to_string();
        let format_label = attachment_string_field(item, "formatLabel")
            .map(ToString::to_string)
            .or_else(|| {
                stored
                    .as_ref()
                    .and_then(|attachment| attachment.format_label.clone())
            });
        let mime_type = attachment_string_field(item, "mimeType")
            .map(ToString::to_string)
            .or_else(|| {
                stored
                    .as_ref()
                    .and_then(|attachment| attachment.mime_type.clone())
            });
        let size_bytes = item
            .get("sizeBytes")
            .and_then(|value| value.as_u64())
            .or_else(|| stored.as_ref().and_then(|attachment| attachment.size_bytes));
        let local_path = stored.map(|attachment| attachment.path);

        attachments.push(DesktopBridgeMessageAttachment {
            kind,
            name: stored_name,
            format_label,
            mime_type,
            size_bytes,
            local_path,
        });
    }

    Ok(attachments)
}

pub(super) fn mailbox_payload_agent_prompt_text(payload: &Value) -> String {
    let request = mailbox_payload_text(payload);
    let context = payload
        .get("contextText")
        .or_else(|| payload.get("context"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(thread) = payload.get("sessionThread") {
        let parent_session_id = thread
            .get("parentSessionId")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let target_display_name = thread
            .get("targetDisplayName")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("Kordi");
        if let Ok(prompt) = crate::canonical_sessions::bridge_agent_parent_session_prompt(
            parent_session_id,
            target_display_name,
            None,
            request.trim(),
            context,
        ) {
            return prompt;
        }
    }

    if request.trim_start().starts_with("Context:\n") {
        return request;
    }

    match context {
        Some(context) => format!("Context:\n{context}\n\nRequest:\n{}", request.trim()),
        None => request,
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
        from_human_id: parsed
            .get("fromHumanId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        from_agent_id: parsed
            .get("fromAgentId")
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

pub(super) fn identity_snapshot_for_event(
    host: &DesktopBridgeHostConfig,
    event: &ParsedMailboxEvent,
    peer_runtime: &str,
) -> DesktopBridgeIdentitySnapshot {
    let active_agent = host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| host.agents.iter().find(|agent| agent.id == active_id))
        .or_else(|| host.agents.iter().find(|agent| agent.is_default))
        .or_else(|| host.agents.first());
    let is_agent = is_agent_like_runtime(peer_runtime);
    let remote_human_name = event.from_owner_name.clone().or_else(|| {
        (!is_agent)
            .then(|| event.from_display_name.clone())
            .flatten()
    });
    let remote_agent_name = is_agent.then(|| {
        event
            .from_display_name
            .clone()
            .or_else(|| event.from_owner_name.clone())
            .unwrap_or_else(|| event.from_node_id.clone())
    });

    DesktopBridgeIdentitySnapshot {
        bridge_host_id: host.id.clone(),
        local_human_id: host
            .human_id
            .clone()
            .unwrap_or_else(|| format!("host:{}", host.id)),
        local_human_name: host.owner.clone().unwrap_or_else(default_owner_name),
        local_agent_id: active_agent.map(|agent| agent.id.clone()),
        local_agent_name: active_agent.map(|agent| agent.label.clone()),
        local_agent_node_id: active_agent.map(|agent| agent.node_id.clone()),
        remote_human_id: event.from_human_id.clone(),
        remote_human_name,
        remote_human_node_id: Some(event.from_node_id.clone()),
        remote_agent_id: is_agent.then(|| event.from_agent_id.clone()).flatten(),
        remote_agent_name,
        remote_agent_node_id: is_agent.then(|| event.from_node_id.clone()),
        remote_agent_runtime: is_agent.then(|| peer_runtime.to_string()),
    }
}

pub(super) fn outreach_metadata_for_event(
    host: &DesktopBridgeHostConfig,
    event: &ParsedMailboxEvent,
    peer_runtime: &str,
) -> Option<DesktopBridgeOutreachMetadata> {
    let thread = event.payload.get("sessionThread")?;
    let parent_session_id = thread
        .get("parentSessionId")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let target_kind = thread
        .get("targetKind")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("bridge-agent")
        .to_string();
    let active_agent = host
        .active_agent_id
        .as_deref()
        .and_then(|active_id| host.agents.iter().find(|agent| agent.id == active_id))
        .or_else(|| host.agents.iter().find(|agent| agent.is_default))
        .or_else(|| host.agents.first());
    let local_human_id = host
        .human_id
        .clone()
        .unwrap_or_else(|| format!("host:{}", host.id));
    let local_owner_name = host.owner.clone().unwrap_or_else(default_owner_name);
    let target_agent_id = (target_kind == "bridge-agent")
        .then(|| active_agent.map(|agent| agent.id.clone()))
        .flatten();
    let target_display_name = thread
        .get("targetDisplayName")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            if target_kind == "bridge-agent" {
                active_agent.map(|agent| agent.label.clone())
            } else {
                Some(local_owner_name.clone())
            }
        })
        .unwrap_or_else(default_display_name);
    let context_policy = event
        .payload
        .get("contextPolicy")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let is_session_transport = context_policy.as_deref().is_some_and(|value| {
        value.eq_ignore_ascii_case("session-relay")
            || value.eq_ignore_ascii_case("session-message")
            || value.eq_ignore_ascii_case("session-invite")
            || value.eq_ignore_ascii_case("session-update")
    });
    let now = now_ms();

    Some(DesktopBridgeOutreachMetadata {
        target_kind: target_kind.clone(),
        parent_session_id: Some(parent_session_id),
        parent_session_title: thread
            .get("parentSessionTitle")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_session_kind: thread
            .get("parentSessionKind")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_group_space_id: thread
            .get("parentGroupSpaceId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_session_participants: thread
            .get("participants")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
        parent_session_messages: thread
            .get("messages")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
        parent_turn_id: thread
            .get("parentTurnId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        parent_message_id: thread
            .get("parentMessageId")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        bridge_host_id: host.id.clone(),
        bridge_conversation_id: None,
        bridge_request_id: event.request_id.clone(),
        delivery_state: event
            .payload
            .get("deliveryState")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        target_node_id: host.node_id.clone(),
        target_human_id: Some(local_human_id),
        target_agent_id,
        target_display_name,
        target_owner_name: Some(local_owner_name),
        target_runtime: if target_kind == "bridge-agent" {
            active_agent.map(|agent| agent.runtime.clone())
        } else {
            Some("person".to_string())
        }
        .or_else(|| Some(peer_runtime.to_string())),
        request_text: mailbox_payload_text(&event.payload),
        trigger_text: thread
            .get("triggerText")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        context_text: event
            .payload
            .get("contextText")
            .or_else(|| event.payload.get("context"))
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        context_policy,
        project_id: event.project_id.clone(),
        project_name: thread
            .get("projectName")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        status: if is_session_transport {
            "completed"
        } else {
            "processing"
        }
        .to_string(),
        created_at_ms: now,
        updated_at_ms: now,
        completed_at_ms: is_session_transport.then_some(now),
        error: None,
    })
}
