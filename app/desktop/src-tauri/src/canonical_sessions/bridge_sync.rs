use std::collections::HashSet;

use super::bridge_identities::{
    archive_replaced_bridge_transport_session, bridge_host_identities,
    bridge_message_sender_identity, bridge_peer_identities,
    cleanup_bridge_fallback_identity_for_session, cleanup_unmentioned_agent_participants,
};
use super::bridge_routing::{
    bridge_conversation_has_unrouted_direct_messages, bridge_delegated_request_ids,
    canonical_bridge_message_status, message_scoped_outreach_groups,
    valid_message_parent_session_id,
};
use super::message_reconcile;
use super::models::{
    AppendCanonicalMessageRequest, OpenCanonicalSessionRequest, UpdateCanonicalPresenceRequest,
    UpsertCanonicalIdentityRequest,
};
use super::parent_sessions::sync_bridge_outreach_into_parent_session;
use super::presence::update_presence_in_db;
use super::sanitization::sanitize_shared_agent_response_text_with_conn;
use super::{
    open_db, open_or_create_session_in_db, reassign_stale_local_human_identities,
    runtime_is_agent_like, update_local_profile_identities, upsert_identity_in_db,
};

pub(crate) fn sync_bridge_state_identities(
    state: &crate::bridge::DesktopBridgeState,
) -> Result<(), String> {
    let conn = open_db()?;

    for host in &state.hosts {
        let host_human = upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: None,
                kind: "human".to_string(),
                display_name: host.owner_name.clone(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some(host.id.clone()),
                bridge_node_id: host.node_id.clone(),
                human_id: Some(host.human_id.clone()),
                agent_id: None,
                avatar_key: Some(host.human_id.clone()),
                profile_image_url: None,
                metadata: None,
            },
        )?;
        update_presence_in_db(
            &conn,
            UpdateCanonicalPresenceRequest {
                identity_id: host_human.id.clone(),
                status: if host.connected { "online" } else { "offline" }.to_string(),
                session_id: None,
                detail: Some(host.server_url.clone()),
                expires_at_ms: None,
            },
        )?;

        let mut active_agent_identity_id = None;
        for agent in &host.agents {
            let agent_identity = upsert_identity_in_db(
                &conn,
                UpsertCanonicalIdentityRequest {
                    id: None,
                    kind: "agent".to_string(),
                    display_name: agent.label.clone(),
                    owner_identity_id: Some(host_human.id.clone()),
                    source: Some("bridge".to_string()),
                    source_host_id: Some(host.id.clone()),
                    bridge_node_id: agent.node_id.clone(),
                    human_id: Some(host.human_id.clone()),
                    agent_id: Some(agent.id.clone()),
                    avatar_key: Some(agent.id.clone()),
                    profile_image_url: None,
                    metadata: Some(serde_json::json!({
                        "runtime": agent.runtime,
                        "isDefault": agent.is_default,
                        "isActive": agent.is_active,
                        "registered": agent.registered,
                    })),
                },
            )?;
            update_presence_in_db(
                &conn,
                UpdateCanonicalPresenceRequest {
                    identity_id: agent_identity.id.clone(),
                    status: if host.connected {
                        "available"
                    } else {
                        "offline"
                    }
                    .to_string(),
                    session_id: None,
                    detail: Some(agent.runtime.clone()),
                    expires_at_ms: None,
                },
            )?;
            if agent.is_active || host.active_agent_id.as_deref() == Some(agent.id.as_str()) {
                active_agent_identity_id = Some(agent_identity.id.clone());
            }
        }

        if state.active_host_id.as_deref() == Some(host.id.as_str()) {
            reassign_stale_local_human_identities(&conn, host_human.id.as_str())?;
            update_local_profile_identities(
                &conn,
                Some(host_human.id.as_str()),
                active_agent_identity_id.as_deref(),
                Some(host.owner_name.as_str()),
            )?;
        }

        for peer in &host.visible_peers {
            let peer_human_identity_id =
                match (peer.human_id.as_deref(), peer.owner_name.as_deref()) {
                    (Some(human_id), Some(owner_name))
                        if !human_id.trim().is_empty() && !owner_name.trim().is_empty() =>
                    {
                        Some(
                            upsert_identity_in_db(
                                &conn,
                                UpsertCanonicalIdentityRequest {
                                    id: None,
                                    kind: "human".to_string(),
                                    display_name: owner_name.to_string(),
                                    owner_identity_id: None,
                                    source: Some("bridge".to_string()),
                                    source_host_id: Some(host.id.clone()),
                                    bridge_node_id: Some(peer.node_id.clone()),
                                    human_id: Some(human_id.to_string()),
                                    agent_id: None,
                                    avatar_key: Some(human_id.to_string()),
                                    profile_image_url: None,
                                    metadata: Some(serde_json::json!({
                                        "discoveryMode": peer.discovery_mode,
                                        "sharedProjects": peer.shared_projects,
                                    })),
                                },
                            )?
                            .id,
                        )
                    }
                    _ => None,
                };

            if let Some(peer_human_identity_id) = peer_human_identity_id.as_deref() {
                update_presence_in_db(
                    &conn,
                    UpdateCanonicalPresenceRequest {
                        identity_id: peer_human_identity_id.to_string(),
                        status: if host.connected { "online" } else { "offline" }.to_string(),
                        session_id: None,
                        detail: peer.discovery_mode.clone(),
                        expires_at_ms: None,
                    },
                )?;
            }

            if peer.agent_id.is_some() || runtime_is_agent_like(&peer.runtime) {
                let display_name = peer
                    .display_name
                    .clone()
                    .or_else(|| peer.owner_name.clone())
                    .unwrap_or_else(|| peer.node_id.clone());
                let peer_agent = upsert_identity_in_db(
                    &conn,
                    UpsertCanonicalIdentityRequest {
                        id: None,
                        kind: "agent".to_string(),
                        display_name,
                        owner_identity_id: peer_human_identity_id,
                        source: Some("bridge".to_string()),
                        source_host_id: Some(host.id.clone()),
                        bridge_node_id: Some(peer.node_id.clone()),
                        human_id: peer.human_id.clone(),
                        agent_id: peer.agent_id.clone(),
                        avatar_key: peer.agent_id.clone().or_else(|| Some(peer.node_id.clone())),
                        profile_image_url: None,
                        metadata: Some(serde_json::json!({
                            "runtime": peer.runtime,
                            "isDefaultAgent": peer.is_default_agent,
                            "discoveryMode": peer.discovery_mode,
                            "sharedProjects": peer.shared_projects,
                        })),
                    },
                )?;
                update_presence_in_db(
                    &conn,
                    UpdateCanonicalPresenceRequest {
                        identity_id: peer_agent.id,
                        status: if host.connected {
                            "available"
                        } else {
                            "offline"
                        }
                        .to_string(),
                        session_id: None,
                        detail: Some(peer.runtime.clone()),
                        expires_at_ms: None,
                    },
                )?;
            }
        }
    }

    Ok(())
}

fn first_direct_person_message_title(
    conversation: &crate::bridge::DesktopBridgeConversation,
    handled_parent_session_message_ids: &HashSet<String>,
) -> Option<String> {
    if runtime_is_agent_like(&conversation.peer_runtime) {
        return None;
    }

    conversation
        .messages
        .iter()
        .filter(|message| !handled_parent_session_message_ids.contains(&message.id))
        .filter(|message| valid_message_parent_session_id(message).is_none())
        .filter(|message| matches!(message.direction.as_str(), "outbound" | "inbound"))
        .filter_map(|message| {
            let text = message.text.trim();
            (!text.is_empty()).then(|| (message.timestamp_ms, text.to_string()))
        })
        .min_by_key(|(timestamp_ms, _)| *timestamp_ms)
        .map(|(_, text)| text)
}

pub(crate) fn sync_bridge_state_sessions(
    state: &crate::bridge::DesktopBridgeState,
) -> Result<(), String> {
    let conn = open_db()?;

    for conversation in &state.conversations {
        let (local_human_identity_id, local_agent_identity_id) =
            bridge_host_identities(&conn, state, &conversation.host_id)?;
        let (relationship_identity_id, remote_target_identity_id) =
            bridge_peer_identities(&conn, state, conversation)?;
        let peer_is_agent = runtime_is_agent_like(&conversation.peer_runtime);
        let peer_is_default_agent = state
            .hosts
            .iter()
            .find(|host| host.id == conversation.host_id)
            .and_then(|host| {
                host.visible_peers
                    .iter()
                    .find(|peer| peer.node_id == conversation.peer_node_id)
            })
            .is_some_and(|peer| peer.is_default_agent);

        let mut handled_parent_session_message_ids = HashSet::new();
        for (outreach, messages) in message_scoped_outreach_groups(conversation) {
            let _ = sync_bridge_outreach_into_parent_session(
                &conn,
                conversation,
                &messages,
                &outreach,
                &local_human_identity_id,
                local_agent_identity_id.as_deref(),
                relationship_identity_id.as_deref(),
                &remote_target_identity_id,
                peer_is_agent,
            )?;
            handled_parent_session_message_ids
                .extend(messages.into_iter().map(|message| message.id));
        }

        let synced_outreach = if handled_parent_session_message_ids.is_empty() {
            conversation
                .outreach
                .as_ref()
                .map(|outreach| {
                    sync_bridge_outreach_into_parent_session(
                        &conn,
                        conversation,
                        &conversation.messages,
                        outreach,
                        &local_human_identity_id,
                        local_agent_identity_id.as_deref(),
                        relationship_identity_id.as_deref(),
                        &remote_target_identity_id,
                        peer_is_agent,
                    )
                })
                .transpose()?
                .unwrap_or(false)
        } else {
            false
        };
        if synced_outreach {
            continue;
        }

        if !bridge_conversation_has_unrouted_direct_messages(
            conversation,
            &handled_parent_session_message_ids,
        ) && (!conversation.messages.is_empty()
            || conversation
                .outreach
                .as_ref()
                .and_then(|outreach| outreach.parent_session_id.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_some())
        {
            continue;
        }

        let mut participants = Vec::new();
        if let Some(relationship_identity_id) = relationship_identity_id.clone() {
            participants.push(relationship_identity_id);
        }
        participants.push(remote_target_identity_id.clone());
        participants.sort();
        participants.dedup();

        let primary_identity_id = if peer_is_agent && peer_is_default_agent {
            relationship_identity_id
                .clone()
                .unwrap_or_else(|| remote_target_identity_id.clone())
        } else {
            remote_target_identity_id.clone()
        };

        let represents_human_relationship =
            peer_is_agent && peer_is_default_agent && relationship_identity_id.is_some();

        let session_title =
            first_direct_person_message_title(conversation, &handled_parent_session_message_ids);

        open_or_create_session_in_db(
            &conn,
            OpenCanonicalSessionRequest {
                id: Some(conversation.canonical_session_id.clone()),
                kind: if peer_is_agent && !represents_human_relationship {
                    "direct-agent".to_string()
                } else {
                    "direct-person".to_string()
                },
                title: session_title,
                status: Some("active".to_string()),
                created_by_identity_id: local_human_identity_id.clone(),
                primary_identity_id: Some(primary_identity_id),
                project_id: conversation.project_id.clone(),
                project_name: conversation.project_name.clone(),
                relationship_identity_id,
                participant_identity_ids: participants,
                metadata: Some(serde_json::json!({
                    "source": "desktop-bridge-conversation",
                    "bridgeConversationId": conversation.id,
                    "bridgeHostId": conversation.host_id,
                    "peerNodeId": conversation.peer_node_id,
                    "peerRuntime": conversation.peer_runtime,
                    "outreach": conversation.outreach,
                })),
            },
        )?;
        cleanup_bridge_fallback_identity_for_session(
            &conn,
            &conversation.canonical_session_id,
            &conversation.peer_node_id,
            &remote_target_identity_id,
        )?;
        if !peer_is_agent {
            cleanup_unmentioned_agent_participants(&conn, &conversation.canonical_session_id)?;
        }
        archive_replaced_bridge_transport_session(&conn, conversation)?;

        let mut delegated_bridge_request_ids = bridge_delegated_request_ids(
            &conn,
            &conversation.canonical_session_id,
            &conversation.id,
        )?;
        if !peer_is_agent {
            for message in &conversation.messages {
                if matches!(
                    message.direction.as_str(),
                    "inbound-response" | "outbound-response"
                ) {
                    if let Some(request_id) = message.request_id.as_deref() {
                        delegated_bridge_request_ids.insert(request_id.to_string());
                    }
                }
            }
        }
        if let Some(outreach_request_id) = conversation
            .outreach
            .as_ref()
            .and_then(|outreach| outreach.bridge_request_id.as_deref())
        {
            delegated_bridge_request_ids.insert(outreach_request_id.to_string());
        }

        for message in &conversation.messages {
            if handled_parent_session_message_ids.contains(&message.id)
                || valid_message_parent_session_id(message).is_some()
            {
                continue;
            }
            if message
                .request_id
                .as_deref()
                .is_some_and(|request_id| delegated_bridge_request_ids.contains(request_id))
            {
                continue;
            }
            let (sender_identity_id, sender_role) = bridge_message_sender_identity(
                &message.direction,
                peer_is_agent,
                &local_human_identity_id,
                local_agent_identity_id.as_deref(),
                &remote_target_identity_id,
            );
            let message_kind = if sender_role == "external-agent" || sender_role == "owned-agent" {
                "agent-turn"
            } else {
                "text"
            };
            let content_text = if message_kind == "agent-turn" {
                sanitize_shared_agent_response_text_with_conn(
                    &conn,
                    Some(&conversation.canonical_session_id),
                    &message.text,
                    &[],
                )?
            } else {
                message.text.clone()
            };
            let request = AppendCanonicalMessageRequest {
                id: None,
                session_id: conversation.canonical_session_id.clone(),
                sender_identity_id,
                sender_role: sender_role.clone(),
                message_kind: message_kind.to_string(),
                content_text,
                content: Some(serde_json::json!({
                    "direction": message.direction,
                    "sender": message.sender,
                    "timeLabel": message.time_label,
                    "timestampMs": message.timestamp_ms,
                    "deliveryState": message.delivery_state,
                    "bridgeConversationId": conversation.id,
                })),
                created_at_ms: Some(message.timestamp_ms),
                parent_message_id: None,
                delegated_exchange_id: None,
                status: Some(canonical_bridge_message_status(
                    message.delivery_state.as_deref(),
                )),
                source_transport: Some("desktop-bridge".to_string()),
                source_event_id: Some(format!("desktop-bridge:{}:{}", conversation.id, message.id)),
            };
            message_reconcile::append_or_reconcile_message_from_sync(
                &conn,
                request,
                "desktop-bridge-ui",
                5_000,
            )?;
        }
    }

    Ok(())
}
