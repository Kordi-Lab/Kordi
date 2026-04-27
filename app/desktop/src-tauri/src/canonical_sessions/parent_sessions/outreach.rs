use rusqlite::{params, Connection};

use super::super::bridge_routing::{
    canonical_bridge_message_status, outreach_is_session_message, outreach_is_session_relay,
    outreach_presence_status, outreach_status_to_exchange_status,
};
use super::super::message_reconcile;
use super::super::models::{
    AppendCanonicalMessageRequest, CreateCanonicalDelegatedExchangeRequest,
    UpdateCanonicalPresenceRequest,
};
use super::super::presence::update_presence_in_db;
use super::super::sanitization::sanitize_shared_agent_response_text_with_conn;
use super::super::schema::ensure_local_profile;
use super::super::{
    create_delegated_exchange_in_db, existing_delegation_join_message_id, hash_hex,
    identity_display_name, now_ms, select_session, session_has_participant, session_message_count,
};
use super::messages::{sync_parent_session_bridge_messages, sync_parent_session_snapshot_messages};
use super::participants::{
    ensure_parent_session_participants, update_parent_session_bridge_metadata,
};
use super::relay::{sync_parent_session_relay_join_event, sync_parent_session_relay_messages};

pub(in crate::canonical_sessions) fn sync_bridge_outreach_into_parent_session(
    conn: &Connection,
    conversation: &crate::bridge::DesktopBridgeConversation,
    messages: &[crate::bridge::DesktopBridgeConversationMessage],
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    relationship_identity_id: Option<&str>,
    remote_target_identity_id: &str,
    peer_is_agent: bool,
) -> Result<bool, String> {
    let Some(parent_session_id) = outreach
        .parent_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };

    let is_session_relay = outreach_is_session_relay(outreach);
    let is_session_message = outreach_is_session_message(outreach);
    if !is_session_relay
        && outreach
            .bridge_request_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Ok(true);
    }

    let parent_session_existed = select_session(conn, parent_session_id)?.is_some();
    let parent_had_messages =
        parent_session_existed && session_message_count(conn, parent_session_id)? > 0;
    let is_inbound_outreach = conversation.peer_node_id != outreach.target_node_id;
    let target_is_agent = if is_inbound_outreach {
        outreach.target_kind == "bridge-agent"
    } else {
        peer_is_agent
    };
    let prospective_target_identity_id = if is_inbound_outreach {
        if outreach.target_kind == "bridge-agent" {
            local_agent_identity_id.unwrap_or(local_human_identity_id)
        } else {
            local_human_identity_id
        }
    } else {
        remote_target_identity_id
    };
    let target_was_participant = parent_session_existed
        && session_has_participant(conn, parent_session_id, prospective_target_identity_id)?;
    if is_session_relay || is_session_message {
        sync_parent_session_relay_messages(
            conn,
            parent_session_id,
            conversation,
            messages,
            outreach,
            local_human_identity_id,
            local_agent_identity_id,
            relationship_identity_id,
            remote_target_identity_id,
            peer_is_agent,
        )?;
        sync_parent_session_relay_join_event(
            conn,
            parent_session_id,
            conversation,
            outreach,
            local_human_identity_id,
            local_agent_identity_id,
            relationship_identity_id,
            remote_target_identity_id,
            peer_is_agent,
        )?;
        if is_session_relay {
            sync_parent_session_bridge_messages(
                conn,
                parent_session_id,
                conversation,
                messages,
                outreach,
                local_human_identity_id,
                remote_target_identity_id,
            )?;
        }
        return Ok(!is_session_message);
    }
    let agent_authored = outreach.parent_turn_id.is_some();
    ensure_parent_session_participants(
        conn,
        parent_session_id,
        outreach.parent_session_title.as_deref(),
        local_human_identity_id,
        local_agent_identity_id,
        remote_target_identity_id,
        relationship_identity_id,
        agent_authored || (is_inbound_outreach && target_is_agent),
    )?;
    if is_inbound_outreach && !parent_had_messages {
        sync_parent_session_snapshot_messages(
            conn,
            parent_session_id,
            conversation,
            outreach,
            local_human_identity_id,
            local_agent_identity_id,
            remote_target_identity_id,
        )?;
    }

    let target_identity_id = prospective_target_identity_id;
    if is_inbound_outreach {
        update_parent_session_bridge_metadata(
            conn,
            parent_session_id,
            conversation,
            remote_target_identity_id,
            relationship_identity_id,
        )?;
    }
    update_presence_in_db(
        conn,
        UpdateCanonicalPresenceRequest {
            identity_id: target_identity_id.to_string(),
            status: outreach_presence_status(&outreach.status, target_is_agent),
            session_id: Some(parent_session_id.to_string()),
            detail: Some(outreach.target_display_name.clone()),
            expires_at_ms: None,
        },
    )?;

    let delegation_request_key = outreach
        .bridge_request_id
        .as_deref()
        .or(outreach.parent_message_id.as_deref())
        .unwrap_or(conversation.id.as_str());
    let delegation_id = format!(
        "delegation:bridge:{}:{}",
        conversation.id, delegation_request_key
    );
    let initiator_identity_id = if is_inbound_outreach {
        remote_target_identity_id
    } else if agent_authored {
        local_agent_identity_id.unwrap_or(local_human_identity_id)
    } else {
        local_human_identity_id
    };
    let initiator_name = identity_display_name(conn, initiator_identity_id)?.unwrap_or_else(|| {
        if agent_authored {
            "Kordi".to_string()
        } else {
            "You".to_string()
        }
    });
    let context_policy = outreach
        .context_policy
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "recent-window".to_string());
    let join_text = if agent_authored {
        format!(
            "{} involved {} via @mention",
            initiator_name, outreach.target_display_name
        )
    } else if target_is_agent {
        format!("{} joined via @mention", outreach.target_display_name)
    } else {
        format!("{} was invited via @mention", outreach.target_display_name)
    };
    let should_emit_join_event = !target_was_participant;
    store_outreach_context_snapshot(
        conn,
        parent_session_id,
        initiator_identity_id,
        target_identity_id,
        &delegation_id,
        outreach,
        &context_policy,
    )?;
    let matches_outreach_request = |message: &&crate::bridge::DesktopBridgeConversationMessage| {
        outreach.bridge_request_id.as_deref().map_or_else(
            || message.timestamp_ms >= outreach.created_at_ms.saturating_sub(2_000),
            |request_id| message.request_id.as_deref() == Some(request_id),
        )
    };
    let request_message_id = if is_inbound_outreach {
        messages
            .iter()
            .filter(matches_outreach_request)
            .find(|message| matches!(message.direction.as_str(), "inbound" | "inbound-response"))
            .map(|message| {
                message_reconcile::append_or_reconcile_message_from_sync(
                    conn,
                    AppendCanonicalMessageRequest {
                        id: None,
                        session_id: parent_session_id.to_string(),
                        sender_identity_id: initiator_identity_id.to_string(),
                        sender_role: if peer_is_agent {
                            "external-agent"
                        } else {
                            "person"
                        }
                        .to_string(),
                        message_kind: if peer_is_agent { "agent-turn" } else { "text" }.to_string(),
                        content_text: outreach
                            .trigger_text
                            .clone()
                            .unwrap_or_else(|| message.text.clone()),
                        content: Some(serde_json::json!({
                            "direction": message.direction,
                            "sender": message.sender,
                            "timeLabel": message.time_label,
                            "timestampMs": message.timestamp_ms,
                            "deliveryState": message.delivery_state,
                            "bridgeConversationId": conversation.id,
                            "delegatedExchangeId": delegation_id,
                            "kind": "mention-request",
                            "mentions": [{
                                "label": outreach.target_display_name,
                                "targetKind": outreach.target_kind,
                                "bridgeHostId": conversation.host_id,
                                "nodeId": outreach.target_node_id,
                            }],
                        })),
                        created_at_ms: Some(message.timestamp_ms),
                        parent_message_id: None,
                        delegated_exchange_id: Some(delegation_id.clone()),
                        status: Some(canonical_bridge_message_status(
                            message.delivery_state.as_deref(),
                        )),
                        source_transport: Some("desktop-bridge-outreach".to_string()),
                        source_event_id: Some(format!(
                            "desktop-bridge-outreach:{}:{}:request",
                            conversation.id, message.id
                        )),
                    },
                    "desktop-bridge-outreach-ui",
                    5_000,
                )
                .map(|message| message.id)
            })
            .transpose()?
    } else {
        outreach.parent_message_id.clone()
    };

    let join_message_id = if should_emit_join_event {
        if let Some(existing_join_message_id) = existing_delegation_join_message_id(
            conn,
            parent_session_id,
            target_identity_id,
            &outreach.target_kind,
            &outreach.target_display_name,
        )? {
            Some(existing_join_message_id)
        } else {
            Some(
                message_reconcile::append_or_reconcile_message_from_sync(
                    conn,
                    AppendCanonicalMessageRequest {
                        id: None,
                        session_id: parent_session_id.to_string(),
                        sender_identity_id: initiator_identity_id.to_string(),
                        sender_role: "system".to_string(),
                        message_kind: "status".to_string(),
                        content_text: join_text,
                        content: Some(serde_json::json!({
                            "kind": "delegation-join-event",
                            "bridgeConversationId": conversation.id,
                            "targetKind": outreach.target_kind,
                            "targetIdentityId": target_identity_id,
                            "targetDisplayName": outreach.target_display_name,
                            "targetNodeId": outreach.target_node_id,
                            "initiatorIdentityId": initiator_identity_id,
                            "requestText": outreach.request_text,
                            "contextPolicy": context_policy.clone(),
                        })),
                        created_at_ms: Some(outreach.created_at_ms),
                        parent_message_id: request_message_id.clone(),
                        delegated_exchange_id: Some(delegation_id.clone()),
                        status: Some("complete".to_string()),
                        source_transport: Some("desktop-bridge-outreach".to_string()),
                        source_event_id: Some(format!(
                            "desktop-bridge-outreach:{}:{}:{}:join",
                            parent_session_id, target_identity_id, outreach.target_kind
                        )),
                    },
                    "desktop-bridge-outreach-ui",
                    5_000,
                )?
                .id,
            )
        }
    } else {
        None
    };

    let mut response_message_id = None;
    let mut response_exchange_status = None;
    let mut response_exchange_error = None;
    for message in messages.iter().filter(matches_outreach_request) {
        let is_response = if is_inbound_outreach {
            matches!(message.direction.as_str(), "outbound" | "outbound-response")
        } else {
            matches!(message.direction.as_str(), "inbound" | "inbound-response")
        };
        if !is_response {
            continue;
        }
        let sender_identity_id = if is_inbound_outreach {
            target_identity_id
        } else {
            remote_target_identity_id
        };
        let sender_role = if is_inbound_outreach {
            if target_is_agent {
                "owned-agent"
            } else {
                "user"
            }
        } else if peer_is_agent {
            "external-agent"
        } else {
            "person"
        };
        let is_agent_turn = if is_inbound_outreach {
            target_is_agent
        } else {
            peer_is_agent
        };
        let content_text = if is_agent_turn {
            sanitize_shared_agent_response_text_with_conn(
                conn,
                Some(parent_session_id),
                &message.text,
                &[],
            )?
        } else {
            message.text.clone()
        };
        let canonical_message = message_reconcile::append_or_reconcile_message_from_sync(
            conn,
            AppendCanonicalMessageRequest {
                id: None,
                session_id: parent_session_id.to_string(),
                sender_identity_id: sender_identity_id.to_string(),
                sender_role: sender_role.to_string(),
                message_kind: if is_agent_turn { "agent-turn" } else { "text" }.to_string(),
                content_text,
                content: Some(serde_json::json!({
                    "direction": message.direction,
                    "sender": message.sender,
                    "timeLabel": message.time_label,
                    "timestampMs": message.timestamp_ms,
                    "deliveryState": message.delivery_state,
                    "bridgeConversationId": conversation.id,
                    "delegatedExchangeId": delegation_id,
                })),
                created_at_ms: Some(message.timestamp_ms),
                parent_message_id: join_message_id
                    .clone()
                    .or_else(|| request_message_id.clone()),
                delegated_exchange_id: Some(delegation_id.clone()),
                status: Some(canonical_bridge_message_status(
                    message.delivery_state.as_deref(),
                )),
                source_transport: Some("desktop-bridge-outreach".to_string()),
                source_event_id: Some(format!(
                    "desktop-bridge-outreach:{}:{}",
                    conversation.id, message.id
                )),
            },
            "desktop-bridge-outreach-ui",
            5_000,
        )?;
        response_message_id = Some(canonical_message.id);
        match message.delivery_state.as_deref() {
            Some("processing_failed") => {
                response_exchange_status = Some("failed".to_string());
                response_exchange_error = Some(message.text.clone());
            }
            Some("responded") | Some("read") => {
                if response_exchange_status.as_deref() != Some("failed") {
                    response_exchange_status = Some("complete".to_string());
                }
            }
            Some("processing") => {
                if response_exchange_status.is_none() {
                    response_exchange_status = Some("processing".to_string());
                }
            }
            _ => {}
        }
    }

    sync_parent_session_bridge_messages(
        conn,
        parent_session_id,
        conversation,
        messages,
        outreach,
        local_human_identity_id,
        remote_target_identity_id,
    )?;

    let default_exchange_status = if !target_is_agent && target_was_participant {
        "complete".to_string()
    } else {
        outreach_status_to_exchange_status(&outreach.status)
    };

    create_delegated_exchange_in_db(
        conn,
        CreateCanonicalDelegatedExchangeRequest {
            id: Some(delegation_id),
            session_id: parent_session_id.to_string(),
            initiator_identity_id: initiator_identity_id.to_string(),
            target_identity_id: target_identity_id.to_string(),
            trigger_message_id: request_message_id.clone(),
            request_message_id: request_message_id.or(join_message_id),
            response_message_id,
            transport: Some("bridge".to_string()),
            bridge_host_id: Some(conversation.host_id.clone()),
            bridge_conversation_id: Some(conversation.id.clone()),
            bridge_request_id: outreach.bridge_request_id.clone(),
            context_policy: Some(context_policy),
            status: Some(response_exchange_status.unwrap_or(default_exchange_status)),
            error: response_exchange_error.or_else(|| outreach.error.clone()),
        },
    )?;

    Ok(true)
}

pub(in crate::canonical_sessions) fn store_outreach_context_snapshot(
    conn: &Connection,
    session_id: &str,
    agent_identity_id: &str,
    target_identity_id: &str,
    delegation_id: &str,
    outreach: &crate::bridge::DesktopBridgeOutreachMetadata,
    context_policy: &str,
) -> Result<(), String> {
    let Some(context_text) = outreach
        .context_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    let profile = ensure_local_profile(conn)?;
    let prompt_hash = hash_hex(&outreach.request_text, 16);
    let project_context_hash = outreach.project_id.as_ref().map(|project_id| {
        hash_hex(
            &format!(
                "{}|{}",
                project_id,
                outreach.project_name.as_deref().unwrap_or_default()
            ),
            16,
        )
    });
    let participant_hash = hash_hex(target_identity_id, 16);
    let message_range_hash = hash_hex(&format!("{context_policy}|{context_text}"), 16);
    let id = format!(
        "context:{}",
        hash_hex(
            &format!(
                "{}|{}|{}|{}",
                profile.id, session_id, delegation_id, message_range_hash
            ),
            16,
        )
    );
    let now = now_ms();
    conn.execute(
        "INSERT INTO context_snapshots(
             id, profile_id, session_id, agent_identity_id, provider, model, prompt_hash, project_context_hash,
             participant_hash, upto_message_id, message_range_hash, summary_text, summary_json, token_count, created_at_ms, invalidated_at_ms
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11, NULL, ?12, ?13, NULL)
         ON CONFLICT(id) DO UPDATE SET
             summary_text = excluded.summary_text,
             token_count = excluded.token_count,
             invalidated_at_ms = NULL",
        params![
            id,
            profile.id,
            session_id,
            agent_identity_id,
            "desktop-bridge",
            outreach
                .target_runtime
                .as_deref()
                .unwrap_or(outreach.target_kind.as_str()),
            prompt_hash,
            project_context_hash,
            participant_hash,
            message_range_hash,
            context_text,
            ((context_text.len() as i64) / 4).max(1),
            now,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}
