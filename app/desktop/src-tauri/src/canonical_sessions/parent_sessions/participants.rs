use rusqlite::{params, Connection};

use super::super::models::OpenCanonicalSessionRequest;
use super::super::{
    clean_optional, identity_display_name, json_to_db, now_ms, open_or_create_session_in_db,
    select_session, upsert_participant,
};

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
