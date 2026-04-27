use rusqlite::{params, Connection, OptionalExtension};

use super::models::{CanonicalIdentity, UpsertCanonicalIdentityRequest};
use super::schema::ensure_local_profile;
use super::{
    canonical_bridge_session_id, local_profile_human_identity_id, now_ms, runtime_is_agent_like,
    select_identity, upsert_identity_in_db,
};

pub(super) fn bridge_human_display_name(display_name: &str) -> String {
    let trimmed = display_name.trim();
    if trimmed.is_empty() {
        return "Person".to_string();
    }
    let lower = trimmed.to_lowercase();
    for suffix in ["'s kordi", "’s kordi"] {
        if lower.ends_with(suffix) {
            let owner = trimmed[..trimmed.len().saturating_sub(suffix.len())].trim();
            if !owner.is_empty() {
                return owner.to_string();
            }
        }
    }
    trimmed.to_string()
}

pub(super) fn upsert_bridge_human_identity(
    conn: &Connection,
    host_id: Option<&str>,
    display_name: &str,
    bridge_node_id: Option<String>,
    human_id: Option<String>,
) -> Result<CanonicalIdentity, String> {
    let fallback_name = bridge_human_display_name(display_name);
    upsert_identity_in_db(
        conn,
        UpsertCanonicalIdentityRequest {
            id: None,
            kind: "human".to_string(),
            display_name: fallback_name,
            owner_identity_id: None,
            source: Some("bridge".to_string()),
            source_host_id: host_id.map(ToString::to_string),
            bridge_node_id,
            human_id: human_id.clone(),
            agent_id: None,
            avatar_key: human_id,
            profile_image_url: None,
            metadata: None,
        },
    )
}

pub(super) fn upsert_bridge_agent_identity(
    conn: &Connection,
    host_id: Option<&str>,
    display_name: &str,
    owner_identity_id: Option<String>,
    bridge_node_id: Option<String>,
    human_id: Option<String>,
    agent_id: Option<String>,
    runtime: Option<String>,
) -> Result<CanonicalIdentity, String> {
    let fallback_name = display_name.trim();
    upsert_identity_in_db(
        conn,
        UpsertCanonicalIdentityRequest {
            id: None,
            kind: "agent".to_string(),
            display_name: if fallback_name.is_empty() {
                "Agent".to_string()
            } else {
                fallback_name.to_string()
            },
            owner_identity_id,
            source: Some("bridge".to_string()),
            source_host_id: host_id.map(ToString::to_string),
            bridge_node_id: bridge_node_id.clone(),
            human_id,
            agent_id: agent_id.clone(),
            avatar_key: agent_id.or(bridge_node_id),
            profile_image_url: None,
            metadata: Some(serde_json::json!({ "runtime": runtime })),
        },
    )
}

pub(super) fn bridge_host_identities(
    conn: &Connection,
    state: &crate::bridge::DesktopBridgeState,
    host_id: &str,
) -> Result<(String, Option<String>), String> {
    if let Some(host) = state.hosts.iter().find(|host| host.id == host_id) {
        let human_identity = upsert_bridge_human_identity(
            conn,
            Some(&host.id),
            &host.owner_name,
            host.node_id.clone(),
            Some(host.human_id.clone()),
        )?;
        let active_agent = host
            .active_agent_id
            .as_deref()
            .and_then(|active_id| host.agents.iter().find(|agent| agent.id == active_id))
            .or_else(|| host.agents.iter().find(|agent| agent.is_default))
            .or_else(|| host.agents.first());
        let agent_identity_id = active_agent
            .map(|agent| {
                upsert_bridge_agent_identity(
                    conn,
                    Some(&host.id),
                    &agent.label,
                    Some(human_identity.id.clone()),
                    agent.node_id.clone(),
                    Some(host.human_id.clone()),
                    Some(agent.id.clone()),
                    Some(agent.runtime.clone()),
                )
                .map(|identity| identity.id)
            })
            .transpose()?;
        return Ok((human_identity.id, agent_identity_id));
    }

    let profile = ensure_local_profile(conn)?;
    let human_identity_id = match profile
        .human_identity_id
        .clone()
        .filter(|value| !value.trim().is_empty())
    {
        Some(identity_id) => identity_id,
        None => local_profile_human_identity_id(conn, "You")?,
    };
    Ok((human_identity_id, profile.active_agent_identity_id))
}

pub(super) fn bridge_human_identity_for_node(
    conn: &Connection,
    host_id: &str,
    node_id: &str,
) -> Result<Option<CanonicalIdentity>, String> {
    let identity_id = conn
        .query_row(
            "SELECT id
             FROM identities
             WHERE kind = 'human'
               AND bridge_node_id = ?1
               AND COALESCE(human_id, '') <> ''
               AND (source_host_id = ?2 OR source_host_id IS NULL)
             ORDER BY source_host_id = ?2 DESC, updated_at_ms DESC
             LIMIT 1",
            params![node_id, host_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;

    identity_id
        .as_deref()
        .map(|id| select_identity(conn, id))
        .transpose()
        .map(|identity| identity.flatten())
}

pub(super) fn bridge_peer_identities(
    conn: &Connection,
    state: &crate::bridge::DesktopBridgeState,
    conversation: &crate::bridge::DesktopBridgeConversation,
) -> Result<(Option<String>, String), String> {
    if let Some(identity) = &conversation.identity {
        let remote_human_identity = match (
            identity.remote_human_id.as_deref(),
            identity.remote_human_name.as_deref(),
        ) {
            (Some(human_id), Some(name)) if !human_id.trim().is_empty() => Some(
                upsert_bridge_human_identity(
                    conn,
                    Some(&identity.bridge_host_id),
                    name,
                    identity.remote_human_node_id.clone(),
                    Some(human_id.to_string()),
                )?
                .id,
            ),
            _ => None,
        };

        if let Some(agent_id) = identity
            .remote_agent_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let display_name = identity.remote_agent_name.as_deref().unwrap_or(agent_id);
            let agent_identity = upsert_bridge_agent_identity(
                conn,
                Some(&identity.bridge_host_id),
                display_name,
                remote_human_identity.clone(),
                identity.remote_agent_node_id.clone(),
                identity.remote_human_id.clone(),
                Some(agent_id.to_string()),
                identity.remote_agent_runtime.clone(),
            )?;
            return Ok((remote_human_identity, agent_identity.id));
        }

        if let Some(human_identity_id) = remote_human_identity {
            return Ok((Some(human_identity_id.clone()), human_identity_id));
        }
    }

    let peer = state
        .hosts
        .iter()
        .find(|host| host.id == conversation.host_id)
        .and_then(|host| {
            host.visible_peers
                .iter()
                .find(|peer| peer.node_id == conversation.peer_node_id)
        });
    let known_peer_human =
        bridge_human_identity_for_node(conn, &conversation.host_id, &conversation.peer_node_id)?;
    let owner_name = conversation
        .peer_owner_name
        .as_deref()
        .or_else(|| peer.and_then(|peer| peer.owner_name.as_deref()))
        .or_else(|| {
            known_peer_human
                .as_ref()
                .map(|identity| identity.display_name.as_str())
        })
        .unwrap_or(&conversation.title);
    let display_name = conversation
        .peer_display_name
        .as_deref()
        .or_else(|| peer.and_then(|peer| peer.display_name.as_deref()))
        .or_else(|| {
            known_peer_human
                .as_ref()
                .map(|identity| identity.display_name.as_str())
        })
        .unwrap_or(owner_name);
    let human_id = peer
        .and_then(|peer| peer.human_id.clone())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            known_peer_human
                .as_ref()
                .and_then(|identity| identity.human_id.clone())
        });
    let agent_id = peer
        .and_then(|peer| peer.agent_id.clone())
        .filter(|value| !value.trim().is_empty());
    let is_agent = runtime_is_agent_like(&conversation.peer_runtime);

    let remote_human_identity =
        if human_id.is_some() || !is_agent || conversation.peer_owner_name.is_some() {
            Some(
                upsert_bridge_human_identity(
                    conn,
                    Some(&conversation.host_id),
                    owner_name,
                    Some(conversation.peer_node_id.clone()),
                    human_id.clone(),
                )?
                .id,
            )
        } else {
            None
        };

    if is_agent {
        let agent_identity = upsert_bridge_agent_identity(
            conn,
            Some(&conversation.host_id),
            display_name,
            remote_human_identity.clone(),
            Some(conversation.peer_node_id.clone()),
            human_id,
            agent_id,
            Some(conversation.peer_runtime.clone()),
        )?;
        Ok((remote_human_identity, agent_identity.id))
    } else if let Some(human_identity_id) = remote_human_identity {
        Ok((Some(human_identity_id.clone()), human_identity_id))
    } else {
        let fallback = upsert_bridge_human_identity(
            conn,
            Some(&conversation.host_id),
            &conversation.title,
            Some(conversation.peer_node_id.clone()),
            None,
        )?;
        Ok((Some(fallback.id.clone()), fallback.id))
    }
}

pub(super) fn bridge_message_sender_identity(
    direction: &str,
    peer_is_agent: bool,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    remote_target_identity_id: &str,
) -> (String, String) {
    match direction {
        "outbound-response" => (
            local_agent_identity_id
                .unwrap_or(local_human_identity_id)
                .to_string(),
            "owned-agent".to_string(),
        ),
        "outbound" => (local_human_identity_id.to_string(), "user".to_string()),
        "inbound" | "inbound-response" => (
            remote_target_identity_id.to_string(),
            if peer_is_agent {
                "external-agent".to_string()
            } else {
                "person".to_string()
            },
        ),
        _ => (remote_target_identity_id.to_string(), "person".to_string()),
    }
}

pub(super) fn cleanup_unmentioned_agent_participants(
    conn: &Connection,
    session_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM session_participants
         WHERE session_id = ?1
           AND identity_id IN (SELECT id FROM identities WHERE kind = 'agent')
           AND NOT EXISTS (
             SELECT 1
             FROM delegated_exchanges
             WHERE delegated_exchanges.session_id = session_participants.session_id
               AND (
                 delegated_exchanges.target_identity_id = session_participants.identity_id
                 OR delegated_exchanges.initiator_identity_id = session_participants.identity_id
               )
           )",
        params![session_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn cleanup_bridge_fallback_identity_for_session(
    conn: &Connection,
    session_id: &str,
    peer_node_id: &str,
    resolved_identity_id: &str,
) -> Result<(), String> {
    let fallback_identity_id = format!("human:bridge-node:{peer_node_id}");
    if resolved_identity_id == fallback_identity_id {
        return Ok(());
    }

    conn.execute(
        "UPDATE session_messages
         SET sender_identity_id = ?1, updated_at_ms = ?2
         WHERE session_id = ?3 AND sender_identity_id = ?4",
        params![
            resolved_identity_id,
            now_ms(),
            session_id,
            fallback_identity_id
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM session_participants
         WHERE session_id = ?1 AND identity_id = ?2",
        params![session_id, fallback_identity_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn archive_replaced_bridge_transport_session(
    conn: &Connection,
    conversation: &crate::bridge::DesktopBridgeConversation,
) -> Result<(), String> {
    let legacy_session_id = canonical_bridge_session_id(&conversation.id);
    if legacy_session_id == conversation.canonical_session_id {
        return Ok(());
    }

    conn.execute(
        "UPDATE sessions
         SET status = 'archived', updated_at_ms = ?1
         WHERE id = ?2
           AND status <> 'archived'
           AND EXISTS (
             SELECT 1
             FROM sessions AS next_session
             WHERE next_session.id = ?3
           )",
        params![
            now_ms(),
            legacy_session_id,
            conversation.canonical_session_id
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}
