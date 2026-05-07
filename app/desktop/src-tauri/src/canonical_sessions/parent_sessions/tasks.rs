use rusqlite::{params, Connection, OptionalExtension};

use super::super::bridge_routing::{outreach_is_session_message, outreach_is_session_relay};
use super::super::models::CreateCanonicalDelegatedExchangeRequest;
use super::super::{create_delegated_exchange_in_db, identity_display_name};

fn clean_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn is_group_parent_session(
    parent_session_id: &str,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> bool {
    outreach
        .parent_session_kind
        .as_deref()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
        || outreach
            .parent_group_space_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        || parent_session_id.starts_with("session:group:")
}

fn outreach_is_agent_task(
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    peer_is_agent: bool,
) -> bool {
    outreach.target_kind.eq_ignore_ascii_case("bridge-agent")
        || peer_is_agent
        || clean_text(outreach.target_agent_id.as_deref()).is_some()
        || outreach.target_runtime.as_deref().is_some_and(|runtime| {
            let normalized = runtime.to_lowercase();
            normalized.contains("kordi") || normalized.contains("agent")
        })
        || outreach.parent_turn_id.is_some()
}

fn group_task_request_key(
    conversation: &crate::bridge::DesktopBridgeConversation,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> String {
    clean_text(outreach.bridge_request_id.as_deref())
        .or_else(|| clean_text(outreach.parent_turn_id.as_deref()))
        .or_else(|| clean_text(outreach.parent_message_id.as_deref()))
        .unwrap_or_else(|| conversation.id.clone())
}

fn group_task_delegation_id(parent_session_id: &str, request_key: &str) -> String {
    format!("delegation:bridge-session-message:{parent_session_id}:{request_key}")
}

fn terminal_response_status(delivery_state: Option<&str>) -> Option<&'static str> {
    match delivery_state.map(str::trim) {
        Some("responded") | Some("read") | Some("complete") | Some("completed") => {
            Some("complete")
        }
        Some("processing_failed") | Some("failed") => Some("failed"),
        Some("cancelled") => Some("cancelled"),
        Some("timeout") => Some("timeout"),
        _ => None,
    }
}

fn is_processing_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.eq_ignore_ascii_case("processing")
        || trimmed.eq_ignore_ascii_case("processing...")
        || trimmed.eq_ignore_ascii_case("processing…")
}

fn outreach_task_status(
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> String {
    for message in messages {
        if matches!(
            message.direction.as_str(),
            "inbound-response" | "outbound-response"
        ) {
            if let Some(status) = terminal_response_status(message.delivery_state.as_deref()) {
                return status.to_string();
            }
            if !message.text.trim().is_empty() && !is_processing_text(&message.text) {
                return "complete".to_string();
            }
        }
    }

    match outreach.status.trim() {
        "completed" | "complete" => "complete".to_string(),
        "failed" | "processing_failed" => "failed".to_string(),
        "cancelled" => "cancelled".to_string(),
        "timeout" => "timeout".to_string(),
        "sending" | "awaitingReply" | "processing" => "processing".to_string(),
        _ => "processing".to_string(),
    }
}

fn message_has_request_id(
    message: &crate::bridge::DesktopBridgeConversationMessage,
    request_id: Option<&str>,
) -> bool {
    request_id.is_some_and(|request_id| {
        message
            .request_id
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| value == request_id)
    })
}

fn request_message_source_ids(
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> Vec<String> {
    let request_id = outreach
        .bridge_request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut ids = Vec::new();
    for message in messages {
        if request_id.is_some() && !message_has_request_id(message, request_id) {
            continue;
        }
        if matches!(message.direction.as_str(), "outbound" | "inbound") {
            let stable = outreach
                .parent_message_id
                .as_deref()
                .or(message.request_id.as_deref())
                .unwrap_or(message.id.as_str());
            ids.push(format!("desktop-bridge-parent:{parent_session_id}:{stable}"));
            ids.push(format!(
                "desktop-bridge-session-relay:{parent_session_id}:{}:{}",
                conversation.id, message.id
            ));
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn response_message_source_ids(
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> Vec<String> {
    let request_id = outreach
        .bridge_request_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let mut ids = Vec::new();
    for message in messages {
        if request_id.is_some() && !message_has_request_id(message, request_id) {
            continue;
        }
        if matches!(
            message.direction.as_str(),
            "inbound-response" | "outbound-response"
        ) {
            let stable_id = message
                .request_id
                .as_deref()
                .or(outreach.bridge_request_id.as_deref())
                .or(outreach.parent_turn_id.as_deref())
                .or(outreach.parent_message_id.as_deref())
                .map(|value| format!("agent-response:{value}"))
                .unwrap_or_else(|| format!("{}:{}", conversation.id, message.id));
            ids.push(format!("desktop-bridge-parent:{parent_session_id}:{stable_id}"));
            ids.push(format!(
                "desktop-bridge-session-relay:{parent_session_id}:{stable_id}"
            ));
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn first_message_id_for_sources(
    conn: &Connection,
    source_event_ids: &[String],
) -> Result<Option<String>, String> {
    for source_event_id in source_event_ids {
        let found = conn
            .query_row(
                "SELECT id FROM session_messages WHERE source_event_id = ?1 ORDER BY created_at_ms ASC, sequence_num ASC LIMIT 1",
                params![source_event_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn backfill_message_delegation_ids(
    conn: &Connection,
    delegation_id: &str,
    source_event_ids: &[String],
) -> Result<(), String> {
    for source_event_id in source_event_ids {
        conn.execute(
            "UPDATE session_messages
             SET delegated_exchange_id = ?1
             WHERE source_event_id = ?2
               AND (delegated_exchange_id IS NULL OR delegated_exchange_id = ?1)",
            params![delegation_id, source_event_id],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub(super) fn sync_group_agent_task_activity(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    relationship_identity_id: Option<&str>,
    remote_target_identity_id: &str,
    peer_is_agent: bool,
) -> Result<(), String> {
    if !(outreach_is_session_message(outreach) || outreach_is_session_relay(outreach)) {
        return Ok(());
    }
    if !is_group_parent_session(parent_session_id, outreach) {
        return Ok(());
    }
    if !outreach_is_agent_task(outreach, peer_is_agent) {
        return Ok(());
    }

    let request_key = group_task_request_key(conversation, outreach);
    let delegation_id = group_task_delegation_id(parent_session_id, &request_key);
    let request_source_ids = request_message_source_ids(parent_session_id, conversation, messages, outreach);
    let response_source_ids = response_message_source_ids(parent_session_id, conversation, messages, outreach);
    let request_message_id = first_message_id_for_sources(conn, &request_source_ids)?
        .or_else(|| clean_text(outreach.parent_message_id.as_deref()));
    let response_message_id = first_message_id_for_sources(conn, &response_source_ids)?;
    let initiator_identity_id = if outreach.parent_turn_id.is_some() {
        local_agent_identity_id
            .map(ToString::to_string)
            .unwrap_or_else(|| local_human_identity_id.to_string())
    } else {
        relationship_identity_id
            .map(ToString::to_string)
            .unwrap_or_else(|| local_human_identity_id.to_string())
    };
    let target_identity_id = if outreach.parent_turn_id.is_some() {
        local_agent_identity_id
            .map(ToString::to_string)
            .unwrap_or_else(|| local_human_identity_id.to_string())
    } else {
        remote_target_identity_id.to_string()
    };

    if identity_display_name(conn, &target_identity_id)?.is_none() {
        return Ok(());
    }

    create_delegated_exchange_in_db(
        conn,
        CreateCanonicalDelegatedExchangeRequest {
            id: Some(delegation_id.clone()),
            session_id: parent_session_id.to_string(),
            initiator_identity_id,
            target_identity_id,
            trigger_message_id: clean_text(outreach.parent_message_id.as_deref()),
            request_message_id,
            response_message_id,
            transport: Some("bridge".to_string()),
            bridge_host_id: Some(conversation.host_id.clone()),
            bridge_conversation_id: outreach
                .bridge_conversation_id
                .clone()
                .or_else(|| Some(conversation.id.clone())),
            bridge_request_id: clean_text(outreach.bridge_request_id.as_deref()),
            context_policy: Some(
                if outreach_is_session_message(outreach) {
                    "session-message"
                } else {
                    "session-relay"
                }
                .to_string(),
            ),
            status: Some(outreach_task_status(messages, outreach)),
            error: outreach.error.clone(),
        },
    )?;

    backfill_message_delegation_ids(conn, &delegation_id, &request_source_ids)?;
    backfill_message_delegation_ids(conn, &delegation_id, &response_source_ids)?;

    Ok(())
}
