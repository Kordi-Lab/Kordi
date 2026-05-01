use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::super::models::{OpenCanonicalSessionRequest, UpsertCanonicalIdentityRequest};
use super::super::{
    clean_optional, identity_display_name, json_to_db, now_ms, open_or_create_session_in_db,
    select_session, upsert_identity_in_db, upsert_participant,
};

fn clean_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn identity_exists(conn: &Connection, identity_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM identities WHERE id = ?1)",
        params![identity_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|value| value != 0)
    .map_err(|err| err.to_string())
}

fn existing_self_participant(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT identity_id FROM session_participants
         WHERE session_id = ?1 AND role = 'self' AND state = 'active'
         ORDER BY added_at_ms ASC, identity_id ASC
         LIMIT 1",
        params![session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn metadata_object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default()
}

fn metadata_string_array(metadata: &Map<String, Value>, key: &str) -> Vec<String> {
    metadata
        .get(key)
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn group_participant_identity_id(
    conn: &Connection,
    bridge_host_id: &str,
    participant: &crate::bridge::DesktopBridgeSessionParticipant,
) -> Result<Option<String>, String> {
    let Some(display_name) = clean_text(Some(participant.display_name.as_str())) else {
        return Ok(None);
    };
    if let Some(identity_id) = clean_text(participant.identity_id.as_deref()) {
        if identity_exists(conn, &identity_id)? {
            return Ok(Some(identity_id));
        }
    }
    let human_id = clean_text(participant.human_id.as_deref());
    let bridge_node_id = clean_text(participant.bridge_node_id.as_deref());
    if human_id.is_none() && bridge_node_id.is_none() {
        return Ok(None);
    }

    Ok(Some(
        upsert_identity_in_db(
            conn,
            UpsertCanonicalIdentityRequest {
                id: None,
                kind: "human".to_string(),
                display_name,
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some(bridge_host_id.to_string()),
                bridge_node_id,
                human_id: human_id.clone(),
                agent_id: None,
                avatar_key: human_id,
                profile_image_url: None,
                metadata: None,
            },
        )?
        .id,
    ))
}

pub(super) fn ensure_parent_group_session_participants(
    conn: &Connection,
    parent_session_id: &str,
    parent_session_title: Option<&str>,
    local_human_identity_id: &str,
    remote_target_identity_id: &str,
    relationship_identity_id: Option<&str>,
    bridge_host_id: &str,
    participants: &[crate::bridge::DesktopBridgeSessionParticipant],
) -> Result<(), String> {
    let now = now_ms();
    let cleaned_parent_title = parent_session_title
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let existing_session = select_session(conn, parent_session_id)?;
    let mut metadata = metadata_object(
        existing_session
            .as_ref()
            .and_then(|session| session.metadata.as_ref()),
    );
    let self_identity_id = existing_self_participant(conn, parent_session_id)?
        .unwrap_or_else(|| local_human_identity_id.to_string());
    let mut participant_ids = vec![
        self_identity_id.clone(),
        remote_target_identity_id.to_string(),
    ];
    let mut admin_identity_ids = metadata_string_array(&metadata, "adminIdentityIds");
    if let Some(relationship_identity_id) = relationship_identity_id {
        participant_ids.push(relationship_identity_id.to_string());
    }
    for participant in participants {
        if let Some(identity_id) = group_participant_identity_id(conn, bridge_host_id, participant)?
        {
            if participant
                .role
                .as_deref()
                .is_some_and(|role| role.eq_ignore_ascii_case("admin"))
            {
                admin_identity_ids.push(identity_id.clone());
            }
            participant_ids.push(identity_id);
        }
    }
    participant_ids.sort();
    participant_ids.dedup();
    admin_identity_ids.sort();
    admin_identity_ids.dedup();
    metadata
        .entry("source".to_string())
        .or_insert_with(|| serde_json::json!("bridge-session-thread"));
    metadata
        .entry("groupSpaceId".to_string())
        .or_insert_with(|| serde_json::json!(parent_session_id));
    if !admin_identity_ids.is_empty() {
        metadata.insert(
            "adminIdentityIds".to_string(),
            serde_json::json!(admin_identity_ids),
        );
    }
    let title = cleaned_parent_title
        .map(ToString::to_string)
        .or_else(|| {
            existing_session
                .as_ref()
                .map(|session| session.title.trim().to_string())
                .filter(|title| !title.is_empty())
        })
        .unwrap_or_else(|| "Group".to_string());
    let created_by_identity_id = existing_session
        .as_ref()
        .map(|session| session.created_by_identity_id.clone())
        .or_else(|| {
            metadata_string_array(&metadata, "adminIdentityIds")
                .into_iter()
                .next()
        })
        .unwrap_or_else(|| self_identity_id.clone());

    open_or_create_session_in_db(
        conn,
        OpenCanonicalSessionRequest {
            id: Some(parent_session_id.to_string()),
            kind: "group".to_string(),
            title: Some(title),
            status: Some("active".to_string()),
            created_by_identity_id,
            primary_identity_id: Some(remote_target_identity_id.to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: participant_ids.clone(),
            metadata: Some(Value::Object(metadata)),
        },
    )?;

    for identity_id in participant_ids {
        let role = if identity_id == self_identity_id {
            "self"
        } else {
            "person"
        };
        upsert_participant(
            conn,
            parent_session_id,
            &identity_id,
            role,
            Some(self_identity_id.as_str()),
            now,
        )?;
    }

    Ok(())
}

pub(super) fn ensure_parent_session_participants(
    conn: &Connection,
    parent_session_id: &str,
    parent_session_title: Option<&str>,
    local_human_identity_id: &str,
    local_agent_identity_id: Option<&str>,
    remote_target_identity_id: &str,
    relationship_identity_id: Option<&str>,
    include_local_agent: bool,
) -> Result<(), String> {
    let now = now_ms();
    let cleaned_parent_title = parent_session_title
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if select_session(conn, parent_session_id)?.is_none() {
        let mut participants = Vec::new();
        if include_local_agent {
            if let Some(agent_identity_id) = local_agent_identity_id {
                participants.push(agent_identity_id.to_string());
            }
        }
        if let Some(relationship_identity_id) = relationship_identity_id {
            participants.push(relationship_identity_id.to_string());
        }
        participants.push(remote_target_identity_id.to_string());
        participants.sort();
        participants.dedup();

        open_or_create_session_in_db(
            conn,
            OpenCanonicalSessionRequest {
                id: Some(parent_session_id.to_string()),
                kind: "self-agent".to_string(),
                title: Some(cleaned_parent_title.unwrap_or("Session").to_string()),
                status: Some("active".to_string()),
                created_by_identity_id: local_human_identity_id.to_string(),
                primary_identity_id: if include_local_agent {
                    local_agent_identity_id.map(ToString::to_string)
                } else {
                    Some(remote_target_identity_id.to_string())
                },
                project_id: None,
                project_name: None,
                relationship_identity_id: None,
                participant_identity_ids: participants,
                metadata: Some(serde_json::json!({
                    "source": "bridge-outreach-parent-fallback",
                })),
            },
        )?;
        return Ok(());
    }

    if let Some(title) = cleaned_parent_title {
        conn.execute(
            "UPDATE sessions
             SET title = CASE
                    WHEN TRIM(title) = '' OR title IN ('Session', 'New session') THEN ?1
                    ELSE title
                 END,
                 updated_at_ms = ?2
             WHERE id = ?3",
            params![title, now, parent_session_id],
        )
        .map_err(|err| err.to_string())?;
    }

    if include_local_agent {
        if let Some(agent_identity_id) = local_agent_identity_id {
            upsert_participant(
                conn,
                parent_session_id,
                agent_identity_id,
                "owned-agent",
                Some(local_human_identity_id),
                now,
            )?;
        }
    }
    if let Some(relationship_identity_id) = relationship_identity_id {
        upsert_participant(
            conn,
            parent_session_id,
            relationship_identity_id,
            "person",
            Some(local_human_identity_id),
            now,
        )?;
    }
    upsert_participant(
        conn,
        parent_session_id,
        remote_target_identity_id,
        "delegate",
        Some(local_human_identity_id),
        now,
    )?;
    Ok(())
}

fn clean_peer_session_title(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("session")
        || trimmed.eq_ignore_ascii_case("new session")
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn title_matches_candidate(current_title: &str, candidate: Option<&str>) -> bool {
    clean_peer_session_title(candidate)
        .as_deref()
        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(current_title.trim()))
}

fn title_matches_peer_label(
    conn: &Connection,
    current_title: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    remote_target_identity_id: &str,
) -> Result<bool, String> {
    if title_matches_candidate(current_title, conversation.peer_owner_name.as_deref())
        || title_matches_candidate(current_title, conversation.peer_display_name.as_deref())
        || title_matches_candidate(current_title, Some(conversation.title.as_str()))
    {
        return Ok(true);
    }

    Ok(identity_display_name(conn, remote_target_identity_id)?
        .as_deref()
        .is_some_and(|display_name| title_matches_candidate(current_title, Some(display_name))))
}

fn session_message_parent_title(
    conn: &Connection,
    conversation: &crate::bridge::DesktopBridgeConversation,
    remote_target_identity_id: &str,
    peer_is_agent: bool,
    first_message_text: Option<&str>,
) -> Result<String, String> {
    let candidates: Vec<Option<&str>> = if peer_is_agent {
        vec![
            first_message_text,
            conversation.peer_display_name.as_deref(),
            Some(conversation.title.as_str()),
            conversation.peer_owner_name.as_deref(),
        ]
    } else {
        vec![
            first_message_text,
            conversation.peer_owner_name.as_deref(),
            conversation.peer_display_name.as_deref(),
            Some(conversation.title.as_str()),
        ]
    };

    for candidate in candidates {
        if let Some(title) = clean_peer_session_title(candidate) {
            return Ok(title);
        }
    }

    Ok(identity_display_name(conn, remote_target_identity_id)?
        .and_then(|value| clean_peer_session_title(Some(value.as_str())))
        .unwrap_or_else(|| "Session".to_string()))
}

pub(super) fn promote_session_message_parent_session(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    remote_target_identity_id: &str,
    relationship_identity_id: Option<&str>,
    peer_is_agent: bool,
    first_message_text: Option<&str>,
) -> Result<(), String> {
    let Some(session) = select_session(conn, parent_session_id)? else {
        return Ok(());
    };

    let mut metadata = session
        .metadata
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let existing_source = metadata
        .get("source")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let should_promote = existing_source.is_empty()
        || existing_source == "bridge-outreach-parent-fallback"
        || existing_source == "bridge-session-thread";
    metadata.insert(
        "source".to_string(),
        serde_json::json!(if should_promote {
            "bridge-session-thread"
        } else {
            existing_source.as_str()
        }),
    );
    metadata.insert(
        "bridgeConversationId".to_string(),
        serde_json::json!(conversation.id),
    );
    metadata.insert(
        "bridgeHostId".to_string(),
        serde_json::json!(conversation.host_id),
    );
    metadata.insert(
        "peerNodeId".to_string(),
        serde_json::json!(conversation.peer_node_id),
    );
    metadata.insert(
        "peerRuntime".to_string(),
        serde_json::json!(conversation.peer_runtime),
    );

    let peer_title = session_message_parent_title(
        conn,
        conversation,
        remote_target_identity_id,
        peer_is_agent,
        first_message_text,
    )?;
    let current_title = session.title.trim();
    let should_update_title = current_title.is_empty()
        || current_title.eq_ignore_ascii_case("session")
        || current_title.eq_ignore_ascii_case("new session")
        || (should_promote && session.kind == "self-agent")
        || (first_message_text.is_some()
            && title_matches_peer_label(
                conn,
                current_title,
                conversation,
                remote_target_identity_id,
            )?);
    let next_kind = if should_promote && session.kind == "self-agent" {
        if peer_is_agent {
            "direct-agent"
        } else {
            "direct-person"
        }
    } else {
        session.kind.as_str()
    };
    let next_title = if should_update_title {
        peer_title.as_str()
    } else {
        session.title.as_str()
    };
    let relationship_identity = if peer_is_agent {
        relationship_identity_id
    } else {
        relationship_identity_id.or(Some(remote_target_identity_id))
    };
    let metadata_json = json_to_db(&Some(serde_json::Value::Object(metadata)))?;

    conn.execute(
        "UPDATE sessions
         SET kind = ?1,
             title = ?2,
             primary_identity_id = COALESCE(NULLIF(primary_identity_id, ''), ?3),
             relationship_identity_id = COALESCE(NULLIF(relationship_identity_id, ''), ?4),
             metadata_json = ?5,
             updated_at_ms = ?6
         WHERE id = ?7",
        params![
            next_kind,
            next_title,
            remote_target_identity_id,
            clean_optional(relationship_identity.map(ToString::to_string)),
            metadata_json,
            now_ms(),
            parent_session_id,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(super) fn update_parent_session_bridge_metadata(
    conn: &Connection,
    parent_session_id: &str,
    conversation: &crate::bridge::DesktopBridgeConversation,
    primary_identity_id: &str,
    relationship_identity_id: Option<&str>,
) -> Result<(), String> {
    let Some(session) = select_session(conn, parent_session_id)? else {
        return Ok(());
    };
    let mut metadata = session
        .metadata
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let existing_source = metadata
        .get("source")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let should_promote_to_relationship = existing_source.is_empty()
        || existing_source == "bridge-outreach-parent-fallback"
        || existing_source == "bridge-session-thread";
    metadata.insert(
        "source".to_string(),
        serde_json::json!(if should_promote_to_relationship {
            "bridge-session-thread"
        } else {
            existing_source.as_str()
        }),
    );
    metadata.insert(
        "bridgeConversationId".to_string(),
        serde_json::json!(conversation.id),
    );
    metadata.insert(
        "bridgeHostId".to_string(),
        serde_json::json!(conversation.host_id),
    );
    metadata.insert(
        "peerNodeId".to_string(),
        serde_json::json!(conversation.peer_node_id),
    );
    metadata.insert(
        "peerRuntime".to_string(),
        serde_json::json!(conversation.peer_runtime),
    );
    let metadata_json = json_to_db(&Some(serde_json::Value::Object(metadata)))?;
    conn.execute(
        "UPDATE sessions
         SET kind = CASE WHEN kind = 'self-agent' AND ?6 THEN 'relationship' ELSE kind END,
             primary_identity_id = COALESCE(primary_identity_id, ?1),
             relationship_identity_id = COALESCE(relationship_identity_id, ?2),
             metadata_json = ?3,
             updated_at_ms = ?4
         WHERE id = ?5",
        params![
            primary_identity_id,
            clean_optional(relationship_identity_id.map(ToString::to_string)),
            metadata_json,
            now_ms(),
            parent_session_id,
            should_promote_to_relationship,
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}
