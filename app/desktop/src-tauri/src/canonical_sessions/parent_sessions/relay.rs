use rusqlite::Connection;

use super::super::bridge_routing::{
    canonical_bridge_message_status, outreach_is_session_message, outreach_is_session_relay,
};
use super::super::message_reconcile;
use super::super::models::AppendCanonicalMessageRequest;
use super::super::sanitization::sanitize_shared_agent_response_text_with_conn;
use super::super::schema::ensure_local_profile;
use super::super::{
    existing_delegation_join_message_id, identity_display_name, now_ms, session_has_participant,
    shared_agent_display_name, similar_agent_message_exists, upsert_participant,
};
use super::participants::{
    ensure_parent_group_session_participants, ensure_parent_session_participants,
    promote_session_message_parent_session,
};

fn is_processing_placeholder_text(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.eq_ignore_ascii_case("processing")
        || trimmed.eq_ignore_ascii_case("processing...")
        || trimmed.eq_ignore_ascii_case("processing…")
}

pub(super) fn sync_parent_session_relay_join_event(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    relationship_identity_id: Option<&str>,
    remote_target_identity_id: &str,
    peer_is_agent: bool,
) -> Result<(), String> {
    let target_identity_id = if peer_is_agent {
        remote_target_identity_id
    } else if outreach.parent_turn_id.is_some() {
        let Some(local_agent_identity_id) = local_agent_identity_id else {
            return Ok(());
        };
        local_agent_identity_id
    } else {
        return Ok(());
    };

    let initiator_identity_id = if peer_is_agent {
        relationship_identity_id.unwrap_or(remote_target_identity_id)
    } else {
        local_human_identity_id
    };
    let target_display_name = shared_agent_display_name(conn, target_identity_id)?
        .or_else(|| {
            identity_display_name(conn, target_identity_id)
                .ok()
                .flatten()
        })
        .or_else(|| {
            peer_is_agent
                .then(|| conversation.peer_display_name.clone())
                .flatten()
        })
        .unwrap_or_else(|| "Kordi".to_string());
    let target_kind = if peer_is_agent {
        "bridge-agent"
    } else {
        "local-agent"
    };
    let delegation_request_key = outreach
        .bridge_request_id
        .as_deref()
        .or(outreach.parent_turn_id.as_deref())
        .or(outreach.parent_message_id.as_deref())
        .unwrap_or(conversation.id.as_str());

    let target_was_participant =
        session_has_participant(conn, parent_session_id, target_identity_id)?;
    upsert_participant(
        conn,
        parent_session_id,
        target_identity_id,
        if peer_is_agent {
            "external-agent"
        } else {
            "owned-agent"
        },
        Some(initiator_identity_id),
        now_ms(),
    )?;

    if target_was_participant
        || existing_delegation_join_message_id(
            conn,
            parent_session_id,
            target_identity_id,
            target_kind,
            &target_display_name,
        )?
        .is_some()
    {
        return Ok(());
    }

    message_reconcile::append_or_reconcile_message_from_sync(
        conn,
        AppendCanonicalMessageRequest {
            id: None,
            session_id: parent_session_id.to_string(),
            sender_identity_id: initiator_identity_id.to_string(),
            sender_role: "system".to_string(),
            message_kind: "status".to_string(),
            content_text: format!("{} joined via @mention", target_display_name),
            content: Some(serde_json::json!({
                "kind": "delegation-join-event",
                "bridgeConversationId": conversation.id,
                "targetKind": target_kind,
                "targetDisplayName": target_display_name,
                "targetNodeId": if peer_is_agent { Some(conversation.peer_node_id.as_str()) } else { None },
                "initiatorIdentityId": initiator_identity_id,
                "requestText": outreach.trigger_text.as_deref().unwrap_or(outreach.request_text.as_str()),
                "contextPolicy": "session-relay",
            })),
            created_at_ms: Some(outreach.created_at_ms.saturating_sub(1)),
            parent_message_id: outreach.parent_message_id.clone(),
            delegated_exchange_id: None,
            status: Some("complete".to_string()),
            source_transport: Some("desktop-bridge-session-relay".to_string()),
            source_event_id: Some(format!(
                "desktop-bridge-session-relay:{}:{}:{}:join",
                parent_session_id, conversation.id, delegation_request_key
            )),
        },
        "desktop-bridge-session-relay-ui",
        5_000,
    )?;

    Ok(())
}

fn outreach_targets_group_parent(
    parent_session_id: &str,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
) -> bool {
    outreach
        .parent_session_kind
        .as_deref()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
        || parent_session_id.starts_with("session:group:")
}

pub(super) fn sync_parent_session_invite(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    relationship_identity_id: Option<&str>,
    remote_target_identity_id: &str,
) -> Result<(), String> {
    if outreach_targets_group_parent(parent_session_id, outreach) {
        ensure_parent_group_session_participants(
            conn,
            parent_session_id,
            outreach.parent_session_title.as_deref(),
            local_human_identity_id,
            remote_target_identity_id,
            relationship_identity_id,
            &conversation.host_id,
            &outreach.parent_session_participants,
        )
    } else {
        ensure_parent_session_participants(
            conn,
            parent_session_id,
            outreach.parent_session_title.as_deref(),
            local_human_identity_id,
            local_agent_identity_id,
            remote_target_identity_id,
            relationship_identity_id,
            false,
        )
    }
}

pub(super) fn sync_parent_session_update(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    relationship_identity_id: Option<&str>,
    remote_target_identity_id: &str,
) -> Result<(), String> {
    if outreach_targets_group_parent(parent_session_id, outreach) {
        ensure_parent_group_session_participants(
            conn,
            parent_session_id,
            outreach.parent_session_title.as_deref(),
            local_human_identity_id,
            remote_target_identity_id,
            relationship_identity_id,
            &conversation.host_id,
            &outreach.parent_session_participants,
        )
    } else {
        ensure_parent_session_participants(
            conn,
            parent_session_id,
            outreach.parent_session_title.as_deref(),
            local_human_identity_id,
            local_agent_identity_id,
            remote_target_identity_id,
            relationship_identity_id,
            false,
        )
    }
}

pub(super) fn sync_parent_session_relay_messages(
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
    let is_session_message = outreach_is_session_message(outreach);
    let is_group_session_message = is_session_message
        && (outreach
            .parent_session_kind
            .as_deref()
            .is_some_and(|kind| kind.eq_ignore_ascii_case("group"))
            || parent_session_id.starts_with("session:group:"));
    if is_group_session_message {
        ensure_parent_group_session_participants(
            conn,
            parent_session_id,
            outreach.parent_session_title.as_deref(),
            local_human_identity_id,
            remote_target_identity_id,
            relationship_identity_id,
            &conversation.host_id,
            &outreach.parent_session_participants,
        )?;
    } else {
        ensure_parent_session_participants(
            conn,
            parent_session_id,
            outreach.parent_session_title.as_deref(),
            local_human_identity_id,
            local_agent_identity_id,
            remote_target_identity_id,
            relationship_identity_id,
            false,
        )?;
    }

    let matches_relay_message = |message: &&crate::bridge::DesktopBridgeConversationMessage| {
        outreach.bridge_request_id.as_deref().map_or_else(
            || message.timestamp_ms >= outreach.created_at_ms.saturating_sub(2_000),
            |request_id| message.request_id.as_deref() == Some(request_id),
        )
    };

    if is_session_message && !is_group_session_message {
        let first_message_text = messages
            .iter()
            .filter(matches_relay_message)
            .map(|message| message.text.trim())
            .find(|text| !text.is_empty());
        promote_session_message_parent_session(
            conn,
            parent_session_id,
            conversation,
            remote_target_identity_id,
            relationship_identity_id,
            peer_is_agent,
            first_message_text,
        )?;
    }

    let relay_is_local_agent_response =
        outreach_is_session_relay(outreach) && outreach.parent_turn_id.is_some();
    let include_outbound = is_session_message || relay_is_local_agent_response;
    let relay_source_transport = if is_session_message {
        "desktop-bridge-parent"
    } else {
        "desktop-bridge-session-relay"
    };
    let relay_local_agent_identity_id = if relay_is_local_agent_response {
        ensure_local_profile(conn)?
            .active_agent_identity_id
            .or_else(|| local_agent_identity_id.map(ToString::to_string))
    } else {
        None
    };
    for message in messages.iter().filter(matches_relay_message) {
        let is_outbound = matches!(message.direction.as_str(), "outbound" | "outbound-response");
        let is_inbound = matches!(message.direction.as_str(), "inbound" | "inbound-response");
        if !is_inbound && !(include_outbound && is_outbound) {
            continue;
        }
        if message.text.trim().is_empty() && message.attachments.is_empty() {
            continue;
        }
        let is_processing_placeholder = message
            .delivery_state
            .as_deref()
            .is_some_and(|state| state.eq_ignore_ascii_case("processing"))
            && is_processing_placeholder_text(&message.text);
        if relay_is_local_agent_response && is_outbound && is_processing_placeholder {
            continue;
        }

        let relay_agent_text = if relay_is_local_agent_response && is_outbound {
            sanitize_shared_agent_response_text_with_conn(
                conn,
                Some(parent_session_id),
                &message.text,
                &[],
            )?
        } else {
            message.text.clone()
        };

        if relay_is_local_agent_response
            && is_outbound
            && similar_agent_message_exists(
                conn,
                parent_session_id,
                &relay_agent_text,
                "desktop-chat",
                message.timestamp_ms,
                30_000,
            )?
        {
            continue;
        }

        let (sender_identity_id, sender_role) = match message.direction.as_str() {
            "outbound" if relay_is_local_agent_response => (
                relay_local_agent_identity_id
                    .clone()
                    .unwrap_or_else(|| local_human_identity_id.to_string()),
                "owned-agent".to_string(),
            ),
            "outbound" => (local_human_identity_id.to_string(), "user".to_string()),
            "outbound-response" => (
                local_agent_identity_id
                    .map(ToString::to_string)
                    .unwrap_or_else(|| local_human_identity_id.to_string()),
                "owned-agent".to_string(),
            ),
            "inbound-response" => (
                remote_target_identity_id.to_string(),
                "external-agent".to_string(),
            ),
            _ if peer_is_agent => (
                remote_target_identity_id.to_string(),
                "external-agent".to_string(),
            ),
            _ => (remote_target_identity_id.to_string(), "person".to_string()),
        };
        let content_text = if sender_role == "external-agent" || sender_role == "owned-agent" {
            sanitize_shared_agent_response_text_with_conn(
                conn,
                Some(parent_session_id),
                &message.text,
                &[],
            )?
        } else {
            message.text.clone()
        };
        let source_event_id = if is_session_message {
            outreach
                .parent_message_id
                .as_deref()
                .or(message.request_id.as_deref())
                .unwrap_or(message.id.as_str())
                .to_string()
        } else {
            format!("{}:{}", conversation.id, message.id)
        };
        message_reconcile::append_or_reconcile_message_from_sync(
            conn,
            AppendCanonicalMessageRequest {
                id: None,
                session_id: parent_session_id.to_string(),
                sender_identity_id,
                sender_role: sender_role.clone(),
                message_kind: if sender_role == "external-agent" || sender_role == "owned-agent" {
                    "agent-turn".to_string()
                } else {
                    "text".to_string()
                },
                content_text,
                content: Some(serde_json::json!({
                    "kind": if is_session_message { "session-message" } else { "session-relay" },
                    "direction": message.direction,
                    "sender": message.sender,
                    "timeLabel": message.time_label,
                    "timestampMs": message.timestamp_ms,
                    "deliveryState": message.delivery_state,
                    "requestId": message.request_id,
                    "bridgeConversationId": conversation.id,
                    "attachments": message.attachments,
                    "mentions": [{
                        "label": outreach.target_display_name,
                        "targetKind": outreach.target_kind,
                        "bridgeHostId": conversation.host_id,
                        "nodeId": outreach.target_node_id,
                        "humanId": outreach.target_human_id,
                        "agentId": outreach.target_agent_id,
                    }],
                })),
                created_at_ms: Some(message.timestamp_ms),
                parent_message_id: outreach.parent_message_id.clone(),
                delegated_exchange_id: None,
                status: Some(canonical_bridge_message_status(
                    message.delivery_state.as_deref(),
                )),
                source_transport: Some(relay_source_transport.to_string()),
                source_event_id: Some(format!(
                    "{}:{}:{}",
                    relay_source_transport, parent_session_id, source_event_id
                )),
            },
            "desktop-bridge-ui",
            10_000,
        )?;
    }

    Ok(())
}
