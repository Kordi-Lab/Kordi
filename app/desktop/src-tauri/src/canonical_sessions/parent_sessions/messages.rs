use rusqlite::Connection;

use super::super::bridge_routing::canonical_bridge_message_status;
use super::super::message_reconcile;
use super::super::models::{AppendCanonicalMessageRequest, UpsertCanonicalIdentityRequest};
use super::super::{
    append_message_in_db, hash_hex, identity_display_name, upsert_identity_in_db,
    upsert_participant,
};

pub(in crate::canonical_sessions) fn sync_parent_session_snapshot_messages(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    remote_target_identity_id: &str,
) -> Result<(), String> {
    if outreach.parent_session_messages.is_empty() {
        return Ok(());
    }

    let snapshot_needs_agent_identity = outreach.parent_session_messages.iter().any(|message| {
        matches!(
            message.role.as_str(),
            "owned-agent" | "external-agent" | "system"
        )
    });
    let snapshot_agent_display_name = outreach
        .parent_session_messages
        .iter()
        .find(|message| {
            matches!(
                message.role.as_str(),
                "owned-agent" | "external-agent" | "system"
            )
        })
        .and_then(|message| message.sender.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Kordi");
    let snapshot_agent_identity_id = snapshot_needs_agent_identity.then(|| {
        format!(
            "agent:thread:{}",
            hash_hex(
                &format!(
                    "{}|{}|{}|{}",
                    parent_session_id,
                    remote_target_identity_id,
                    conversation.peer_node_id,
                    snapshot_agent_display_name
                ),
                16,
            )
        )
    });
    if let Some(snapshot_agent_identity_id) = snapshot_agent_identity_id.as_ref() {
        let snapshot_agent_id = format!(
            "thread:{}",
            hash_hex(
                &format!("{}|{}", parent_session_id, snapshot_agent_display_name),
                16
            )
        );
        upsert_identity_in_db(
            conn,
            UpsertCanonicalIdentityRequest {
                id: Some(snapshot_agent_identity_id.clone()),
                kind: "agent".to_string(),
                display_name: snapshot_agent_display_name.to_string(),
                owner_identity_id: Some(remote_target_identity_id.to_string()),
                source: Some("bridge".to_string()),
                source_host_id: Some(conversation.host_id.clone()),
                bridge_node_id: Some(conversation.peer_node_id.clone()),
                human_id: None,
                agent_id: Some(snapshot_agent_id),
                avatar_key: Some(snapshot_agent_identity_id.clone()),
                profile_image_url: None,
                metadata: Some(serde_json::json!({
                    "source": "bridge-session-thread-snapshot",
                    "parentSessionId": parent_session_id,
                })),
            },
        )?;
        upsert_participant(
            conn,
            parent_session_id,
            snapshot_agent_identity_id,
            "external-agent",
            Some(remote_target_identity_id),
            outreach.created_at_ms,
        )?;
    }

    let total = outreach.parent_session_messages.len() as i64;
    for (index, snapshot) in outreach.parent_session_messages.iter().enumerate() {
        let text = snapshot.text.trim();
        if text.is_empty() || matches!(snapshot.role.as_str(), "action" | "edit") {
            continue;
        }
        let role = snapshot.role.trim();
        let (sender_identity_id, sender_role, message_kind) = match role {
            "owned-agent" | "external-agent" => (
                snapshot_agent_identity_id.clone().unwrap_or_else(|| {
                    local_agent_identity_id
                        .map(ToString::to_string)
                        .unwrap_or_else(|| local_human_identity_id.to_string())
                }),
                "external-agent".to_string(),
                "agent-turn".to_string(),
            ),
            "system" => (
                snapshot_agent_identity_id.clone().unwrap_or_else(|| {
                    local_agent_identity_id
                        .map(ToString::to_string)
                        .unwrap_or_else(|| local_human_identity_id.to_string())
                }),
                "system".to_string(),
                "system".to_string(),
            ),
            "user" | "person" => (
                remote_target_identity_id.to_string(),
                "person".to_string(),
                "text".to_string(),
            ),
            _ => (
                local_agent_identity_id
                    .map(ToString::to_string)
                    .unwrap_or_else(|| local_human_identity_id.to_string()),
                "system".to_string(),
                "system".to_string(),
            ),
        };
        let content_sender = if matches!(sender_role.as_str(), "person" | "user")
            && snapshot
                .sender
                .as_deref()
                .map(str::trim)
                .is_some_and(|sender| sender.eq_ignore_ascii_case("you"))
            && sender_identity_id != local_human_identity_id
        {
            identity_display_name(conn, &sender_identity_id)?
        } else {
            snapshot.sender.clone()
        };
        let created_at_ms = outreach
            .created_at_ms
            .saturating_sub((total - index as i64 + 1).max(1) * 1_000);
        let source_key = hash_hex(
            &format!(
                "{}|{}|{}|{}|{}",
                parent_session_id,
                index,
                role,
                snapshot.sender.as_deref().unwrap_or_default(),
                text
            ),
            16,
        );
        append_message_in_db(
            conn,
            AppendCanonicalMessageRequest {
                id: None,
                session_id: parent_session_id.to_string(),
                sender_identity_id,
                sender_role,
                message_kind,
                content_text: text.to_string(),
                content: Some(serde_json::json!({
                    "sender": content_sender,
                    "timeLabel": snapshot.time_label,
                    "snapshot": "bridge-session-thread",
                    "bridgeConversationId": conversation.id,
                })),
                created_at_ms: Some(created_at_ms),
                parent_message_id: None,
                delegated_exchange_id: None,
                status: Some("complete".to_string()),
                source_transport: Some("desktop-bridge-thread-snapshot".to_string()),
                source_event_id: Some(format!(
                    "desktop-bridge-thread-snapshot:{}:{}:{}",
                    parent_session_id, conversation.id, source_key
                )),
            },
        )?;
    }

    Ok(())
}

pub(super) fn sync_parent_session_bridge_messages(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    local_human_identity_id: &str,
    remote_target_identity_id: &str,
) -> Result<(), String> {
    let cutoff_ms = outreach.created_at_ms.saturating_sub(2_000);
    for message in messages {
        if message.timestamp_ms < cutoff_ms {
            continue;
        }
        if !matches!(message.direction.as_str(), "inbound" | "outbound") {
            continue;
        }
        if outreach
            .bridge_request_id
            .as_deref()
            .is_some_and(|request_id| message.request_id.as_deref() == Some(request_id))
        {
            continue;
        }
        if message.text.trim().is_empty() {
            continue;
        }

        let is_outbound = message.direction == "outbound";
        let (sender_identity_id, sender_role) = if is_outbound {
            (local_human_identity_id.to_string(), "user".to_string())
        } else {
            (remote_target_identity_id.to_string(), "person".to_string())
        };
        message_reconcile::append_or_reconcile_message_from_sync(
            conn,
            AppendCanonicalMessageRequest {
                id: None,
                session_id: parent_session_id.to_string(),
                sender_identity_id,
                sender_role,
                message_kind: "text".to_string(),
                content_text: message.text.clone(),
                content: Some(serde_json::json!({
                    "direction": message.direction,
                    "sender": message.sender,
                    "timeLabel": message.time_label,
                    "timestampMs": message.timestamp_ms,
                    "deliveryState": message.delivery_state,
                    "requestId": message.request_id,
                    "bridgeConversationId": conversation.id,
                })),
                created_at_ms: Some(message.timestamp_ms),
                parent_message_id: None,
                delegated_exchange_id: None,
                status: Some(canonical_bridge_message_status(
                    message.delivery_state.as_deref(),
                )),
                source_transport: Some("desktop-bridge-parent".to_string()),
                source_event_id: Some(format!(
                    "desktop-bridge-parent:{}:{}:{}",
                    parent_session_id, conversation.id, message.id
                )),
            },
            "desktop-bridge-ui",
            10_000,
        )?;
    }
    Ok(())
}
