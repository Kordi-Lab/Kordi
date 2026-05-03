use rusqlite::{params, Connection, OptionalExtension};

use super::super::bridge_identities::upsert_bridge_agent_identity;
use super::super::bridge_routing::{
    canonical_bridge_message_status, outreach_is_session_message, outreach_is_session_relay,
};
use super::super::message_reconcile;
use super::super::models::AppendCanonicalMessageRequest;
use super::super::sanitization::sanitize_shared_agent_response_text_with_conn;
use super::super::schema::ensure_local_profile;
use super::super::{
    existing_delegation_join_message_id, hash_hex, identity_display_name, now_ms,
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

fn delete_stale_legacy_agent_response_request_row(
    conn: &Connection,
    parent_session_id: &str,
    conversation_id: &str,
    message_id: &str,
) -> Result<(), String> {
    let stale_source_event_id =
        format!("desktop-bridge-outreach:{conversation_id}:{message_id}:request");
    conn.execute(
        "DELETE FROM session_messages
         WHERE session_id = ?1
           AND source_transport = 'desktop-bridge-outreach'
           AND source_event_id = ?2
           AND message_kind = 'agent-turn'",
        params![parent_session_id, stale_source_event_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn relay_response_sender_label(
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
) -> Option<String> {
    messages
        .iter()
        .filter(|message| message.direction.as_str() == "inbound-response")
        .filter_map(|message| message.sender.as_deref())
        .map(str::trim)
        .find(|sender| !sender.is_empty())
        .map(ToString::to_string)
}

fn select_existing_relay_agent_identity(
    conn: &Connection,
    relationship_identity_id: Option<&str>,
    peer_node_id: &str,
    display_name: &str,
) -> Result<Option<String>, String> {
    if let Some(relationship_identity_id) = relationship_identity_id {
        let identity_id = conn
            .query_row(
                "SELECT id
                 FROM identities
                 WHERE kind = 'agent'
                   AND owner_identity_id = ?1
                   AND display_name = ?2
                 ORDER BY updated_at_ms DESC
                 LIMIT 1",
                params![relationship_identity_id, display_name],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?;
        if identity_id.is_some() {
            return Ok(identity_id);
        }
    }

    conn.query_row(
        "SELECT id
         FROM identities
         WHERE kind = 'agent'
           AND bridge_node_id = ?1
           AND display_name = ?2
         ORDER BY updated_at_ms DESC
         LIMIT 1",
        params![peer_node_id, display_name],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn upsert_relay_agent_identity(
    conn: &Connection,
    conversation: &crate::bridge::DesktopBridgeConversation,
    relationship_identity_id: Option<&str>,
    display_name: &str,
) -> Result<String, String> {
    if let Some(existing_id) = select_existing_relay_agent_identity(
        conn,
        relationship_identity_id,
        &conversation.peer_node_id,
        display_name,
    )? {
        return Ok(existing_id);
    }

    let fallback_agent_id = format!(
        "bridge-relay:{}",
        hash_hex(
            &format!("{}|{}", conversation.peer_node_id, display_name),
            16
        )
    );
    Ok(upsert_bridge_agent_identity(
        conn,
        Some(&conversation.host_id),
        display_name,
        relationship_identity_id.map(ToString::to_string),
        Some(conversation.peer_node_id.clone()),
        None,
        Some(fallback_agent_id),
        Some("kordi-desktop".to_string()),
    )?
    .id)
}

fn inbound_relay_agent_from_response_sender(
    conn: &Connection,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    relationship_identity_id: Option<&str>,
    peer_is_agent: bool,
) -> Result<Option<(String, String)>, String> {
    if peer_is_agent || outreach.parent_turn_id.is_none() {
        return Ok(None);
    }
    let Some(display_name) = relay_response_sender_label(messages) else {
        return Ok(None);
    };
    let peer_owner_name = conversation
        .peer_owner_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if peer_owner_name.is_some_and(|owner| owner == display_name) {
        return Ok(None);
    }

    let identity_id =
        upsert_relay_agent_identity(conn, conversation, relationship_identity_id, &display_name)?;
    Ok(Some((identity_id, display_name)))
}

pub(super) fn sync_parent_session_relay_join_event(
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
    let inbound_remote_agent_relay = inbound_relay_agent_from_response_sender(
        conn,
        conversation,
        messages,
        outreach,
        relationship_identity_id,
        peer_is_agent,
    )?;
    let is_local_bridge_agent_request = !peer_is_agent
        && inbound_remote_agent_relay.is_none()
        && outreach.target_kind == "bridge-agent"
        && outreach.parent_turn_id.is_none();
    let target_identity_id = if peer_is_agent {
        remote_target_identity_id
    } else if let Some((remote_relay_agent_identity_id, _)) = inbound_remote_agent_relay.as_ref() {
        remote_relay_agent_identity_id.as_str()
    } else if is_local_bridge_agent_request {
        local_agent_identity_id.unwrap_or(local_human_identity_id)
    } else if outreach.parent_turn_id.is_some() {
        let Some(local_agent_identity_id) = local_agent_identity_id else {
            return Ok(());
        };
        local_agent_identity_id
    } else {
        return Ok(());
    };

    let is_remote_agent_relay = inbound_remote_agent_relay.is_some();
    let initiator_identity_id =
        if peer_is_agent || is_remote_agent_relay || is_local_bridge_agent_request {
            relationship_identity_id.unwrap_or(remote_target_identity_id)
        } else {
            local_human_identity_id
        };
    let shared_target_display_name = if is_remote_agent_relay || is_local_bridge_agent_request {
        None
    } else {
        shared_agent_display_name(conn, target_identity_id)?
    };
    let target_display_name = inbound_remote_agent_relay
        .as_ref()
        .map(|(_, display_name)| display_name.clone())
        .or_else(|| {
            is_local_bridge_agent_request
                .then(|| outreach.target_display_name.trim())
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
        .or(shared_target_display_name)
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
    let target_kind = if peer_is_agent || is_remote_agent_relay || is_local_bridge_agent_request {
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

    upsert_participant(
        conn,
        parent_session_id,
        target_identity_id,
        if peer_is_agent || is_remote_agent_relay {
            "external-agent"
        } else {
            "owned-agent"
        },
        Some(initiator_identity_id),
        now_ms(),
    )?;

    if existing_delegation_join_message_id(
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
                "targetNodeId": if peer_is_agent || is_remote_agent_relay { Some(conversation.peer_node_id.as_str()) } else if is_local_bridge_agent_request { Some(outreach.target_node_id.as_str()) } else { None },
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
            outreach.parent_group_space_id.as_deref(),
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
            outreach.parent_group_space_id.as_deref(),
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

fn canonical_delivery_state_for_parent_session_relay(
    message: &crate::bridge::DesktopBridgeConversationMessage,
    is_group_session_message: bool,
) -> Option<String> {
    let delivery_state = message
        .delivery_state
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    // Group chat has no per-participant read aggregate yet. For the parent group
    // row, a successful Bridge fanout is the strongest durable signal we have, so
    // surface sender-side `sent` as group-level `delivered` while preserving any
    // explicit future `read` / failure states.
    if is_group_session_message
        && matches!(message.direction.as_str(), "outbound")
        && delivery_state.is_some_and(|state| state.eq_ignore_ascii_case("sent"))
    {
        return Some("delivered".to_string());
    }

    delivery_state.map(ToString::to_string)
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
            || outreach
                .parent_group_space_id
                .as_deref()
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
            || parent_session_id.starts_with("session:group:"));
    if is_group_session_message {
        ensure_parent_group_session_participants(
            conn,
            parent_session_id,
            outreach.parent_session_title.as_deref(),
            outreach.parent_group_space_id.as_deref(),
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
    let remote_relay_agent_identity_id = inbound_relay_agent_from_response_sender(
        conn,
        conversation,
        messages,
        outreach,
        relationship_identity_id,
        peer_is_agent,
    )?
    .map(|(identity_id, _)| identity_id);
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
                remote_relay_agent_identity_id
                    .clone()
                    .unwrap_or_else(|| remote_target_identity_id.to_string()),
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
        let is_agent_response_message = matches!(
            message.direction.as_str(),
            "inbound-response" | "outbound-response"
        );
        if is_session_message && is_agent_response_message {
            delete_stale_legacy_agent_response_request_row(
                conn,
                parent_session_id,
                &conversation.id,
                &message.id,
            )?;
        }
        let source_event_id = if is_session_message && is_agent_response_message {
            message
                .request_id
                .as_deref()
                .or(outreach.bridge_request_id.as_deref())
                .or(outreach.parent_turn_id.as_deref())
                .or(outreach.parent_message_id.as_deref())
                .map(|stable_id| format!("agent-response:{stable_id}"))
                .unwrap_or_else(|| format!("{}:{}", conversation.id, message.id))
        } else if is_session_message {
            outreach
                .parent_message_id
                .as_deref()
                .or(message.request_id.as_deref())
                .unwrap_or(message.id.as_str())
                .to_string()
        } else if relay_is_local_agent_response && is_outbound {
            message
                .request_id
                .as_deref()
                .or(outreach.bridge_request_id.as_deref())
                .or(outreach.parent_turn_id.as_deref())
                .map(|stable_id| format!("agent-response:{stable_id}"))
                .unwrap_or_else(|| format!("{}:{}", conversation.id, message.id))
        } else {
            format!("{}:{}", conversation.id, message.id)
        };
        let canonical_delivery_state =
            canonical_delivery_state_for_parent_session_relay(message, is_group_session_message);
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
                    "deliveryState": canonical_delivery_state,
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
                    canonical_delivery_state.as_deref(),
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
