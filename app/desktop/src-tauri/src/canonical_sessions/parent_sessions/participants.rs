use rusqlite::{params, Connection};

use super::super::models::OpenCanonicalSessionRequest;
use super::super::{
    clean_optional, json_to_db, now_ms, open_or_create_session_in_db, select_session,
    upsert_participant,
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
