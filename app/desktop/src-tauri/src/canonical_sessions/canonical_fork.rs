use std::collections::HashMap;

use kordi_cli::desktop_runtime::DesktopForkSessionOutcome;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    AppendCanonicalMessageRequest, CanonicalSessionMessage, OpenCanonicalSessionRequest,
};
use super::{
    append_message_in_db, local_agent_identity_id, local_profile_human_identity_id, open_db,
    open_or_create_session_in_db,
};

/// Read every message persisted on a canonical group/bridge session,
/// ordered by sequence (the natural canonical timeline).
fn list_canonical_messages(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<CanonicalSessionMessage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, sender_identity_id, sender_role, message_kind,
                    content_text, content_json, parent_message_id, delegated_exchange_id,
                    status, sequence_num, created_at_ms, updated_at_ms,
                    content_hash, source_transport, source_event_id
             FROM session_messages WHERE session_id = ?1
             ORDER BY sequence_num ASC, created_at_ms ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(CanonicalSessionMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sender_identity_id: row.get(2)?,
                sender_role: row.get(3)?,
                message_kind: row.get(4)?,
                content_text: row.get(5)?,
                content: row
                    .get::<_, Option<String>>(6)?
                    .and_then(|raw| serde_json::from_str(&raw).ok()),
                parent_message_id: row.get(7)?,
                delegated_exchange_id: row.get(8)?,
                status: row.get(9)?,
                sequence_num: row.get(10)?,
                created_at_ms: row.get(11)?,
                updated_at_ms: row.get(12)?,
                content_hash: row.get(13)?,
                source_transport: row.get(14)?,
                source_event_id: row.get(15)?,
            })
        })
        .map_err(|err| err.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| err.to_string())?);
    }
    Ok(out)
}

#[derive(Debug, Clone)]
struct SourceSessionInfo {
    kind: String,
    title: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
    metadata: Option<serde_json::Value>,
}

fn select_source_session_info(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SourceSessionInfo>, String> {
    conn.query_row(
        "SELECT kind, title, project_id, project_name, metadata_json FROM sessions WHERE id = ?1",
        params![session_id],
        |row| {
            let metadata_raw: Option<String> = row.get(4)?;
            Ok(SourceSessionInfo {
                kind: row.get(0)?,
                title: row.get(1)?,
                project_id: row.get(2)?,
                project_name: row.get(3)?,
                metadata: metadata_raw.and_then(|raw| serde_json::from_str(&raw).ok()),
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn select_source_participants(
    conn: &Connection,
    session_id: &str,
    include_humans: bool,
) -> Result<Vec<String>, String> {
    let kind_filter = if include_humans {
        "('human','agent')"
    } else {
        "('agent')"
    };
    let sql = format!(
        "SELECT sp.identity_id
         FROM session_participants sp
         JOIN identities idn ON idn.id = sp.identity_id
         WHERE sp.session_id = ?1 AND sp.state = 'active' AND idn.kind IN {kind_filter}
         ORDER BY sp.added_at_ms ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| err.to_string())?);
    }
    Ok(out)
}

fn message_content_string(message: &CanonicalSessionMessage, key: &str) -> Option<String> {
    message
        .content
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn linked_agent_request_id(message: &CanonicalSessionMessage) -> Option<String> {
    message
        .parent_message_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| message_content_string(message, "requestId"))
        .or_else(|| message_content_string(message, "replyToMessageId"))
}

fn cloud_group_agent_delivery_state(message: &CanonicalSessionMessage) -> Option<String> {
    message_content_string(message, "deliveryState").map(|value| value.to_ascii_lowercase())
}

fn is_cloud_group_agent_message(message: &CanonicalSessionMessage) -> bool {
    message
        .source_transport
        .as_deref()
        .is_some_and(|transport| transport.starts_with("cloud-group-agent"))
        && message.sender_identity_id.starts_with("agent:cloud:")
        && linked_agent_request_id(message).is_some()
}

fn is_processing_cloud_group_agent_message(message: &CanonicalSessionMessage) -> bool {
    if !is_cloud_group_agent_message(message) {
        return false;
    }
    message.status.trim().eq_ignore_ascii_case("processing")
        || cloud_group_agent_delivery_state(message).as_deref() == Some("processing")
}

fn is_terminal_cloud_group_agent_response_for(
    message: &CanonicalSessionMessage,
    request_id: &str,
    sender_identity_id: &str,
) -> bool {
    is_cloud_group_agent_message(message)
        && message.sender_identity_id == sender_identity_id
        && linked_agent_request_id(message).as_deref() == Some(request_id)
        && !is_processing_cloud_group_agent_message(message)
}

fn terminalize_fork_processing_message(
    message: &CanonicalSessionMessage,
) -> CanonicalSessionMessage {
    let mut cloned = message.clone();
    cloned.status = "cancelled".to_string();
    cloned.content_text = "Request was still processing when this fork was created.".to_string();
    match cloned.content.as_mut() {
        Some(serde_json::Value::Object(object)) => {
            object.insert(
                "deliveryState".to_string(),
                serde_json::Value::String("cancelled".to_string()),
            );
            object.insert(
                "forkSnapshotTerminalized".to_string(),
                serde_json::Value::Bool(true),
            );
        }
        _ => {
            cloned.content = Some(serde_json::json!({
                "deliveryState": "cancelled",
                "forkSnapshotTerminalized": true,
            }));
        }
    }
    cloned
}

fn prepare_fork_snapshot_messages(
    path: &[CanonicalSessionMessage],
) -> Vec<CanonicalSessionMessage> {
    path.iter()
        .enumerate()
        .filter_map(|(index, message)| {
            if !is_processing_cloud_group_agent_message(message) {
                return Some(message.clone());
            }
            let Some(request_id) = linked_agent_request_id(message) else {
                return Some(terminalize_fork_processing_message(message));
            };
            let has_later_terminal_response = path[index + 1..].iter().any(|candidate| {
                is_terminal_cloud_group_agent_response_for(
                    candidate,
                    &request_id,
                    &message.sender_identity_id,
                )
            });
            if has_later_terminal_response {
                None
            } else {
                Some(terminalize_fork_processing_message(message))
            }
        })
        .collect()
}

/// Fork a canonical (group/bridge) session into a new private canonical
/// session that mirrors the source's transcript up through (and
/// including) `canonical_message_id`. The clone preserves each
/// message's original `sender_identity_id`, `sender_role`, content,
/// and parent linkage so the fork renders identically through the
/// existing canonical view model — including other participants'
/// names, avatars, reply chips, and per-turn provider/model metadata.
pub fn fork_canonical_session_into_local_chat(
    canonical_session_id: &str,
    canonical_message_id: &str,
    cwd: &str,
) -> Result<DesktopForkSessionOutcome, String> {
    let conn = open_db()?;

    let messages = list_canonical_messages(&conn, canonical_session_id)?;
    if messages.is_empty() {
        return Err(format!(
            "Canonical session has no messages to fork: {canonical_session_id}"
        ));
    }
    let Some(anchor_index) = messages.iter().position(|m| m.id == canonical_message_id) else {
        return Err(format!(
            "Canonical message not found in session: {canonical_message_id}"
        ));
    };
    let path = prepare_fork_snapshot_messages(&messages[..=anchor_index]);

    let source_info =
        select_source_session_info(&conn, canonical_session_id)?.unwrap_or(SourceSessionInfo {
            kind: "self-agent".to_string(),
            title: None,
            project_id: None,
            project_name: None,
            metadata: None,
        });
    let source_title = source_info.title.clone().filter(|value| {
        !value.trim().is_empty()
            && !kordi_session::naming::is_placeholder_or_weak_legacy_title(value, "")
    });
    let fork_title = source_title
        .as_deref()
        .map(|title| {
            kordi_session::naming::truncate_session_title(&format!("Fork of {}", title.trim()))
        })
        .unwrap_or_else(|| "New fork".to_string());
    let source_is_group = source_info.kind == "group";

    let local_human_id = local_profile_human_identity_id(&conn, "You")?;
    let local_agent_id = local_agent_identity_id(&conn, &local_human_id, "Kordi", cwd)?;

    let mut participant_ids = if source_is_group {
        Vec::new()
    } else {
        vec![local_agent_id.clone()]
    };
    for identity in select_source_participants(&conn, canonical_session_id, source_is_group)? {
        if !source_is_group && identity == local_agent_id {
            continue;
        }
        if !participant_ids.iter().any(|existing| existing == &identity) {
            participant_ids.push(identity);
        }
    }
    if source_is_group
        && !participant_ids
            .iter()
            .any(|existing| existing == &local_human_id)
    {
        participant_ids.push(local_human_id.clone());
    }
    if !source_is_group
        && !participant_ids
            .iter()
            .any(|existing| existing == &local_agent_id)
    {
        participant_ids.insert(0, local_agent_id.clone());
    }

    let new_session_id = format!("session:fork:{}", Uuid::new_v4().simple());
    let source_metadata = source_info
        .metadata
        .as_ref()
        .and_then(|value| value.as_object());
    let continued_from_space_id = source_metadata
        .and_then(|object| object.get("groupSpaceId"))
        .and_then(|value| value.as_str())
        .unwrap_or(canonical_session_id);
    let fork_mode = if source_is_group {
        "cloud-group"
    } else {
        "private-local"
    };
    let metadata = if source_is_group {
        serde_json::json!({
            "source": "canonical-fork-snapshot",
            "kind": "chat-group",
            "createdFrom": "cloud-group-fork",
            "sessionTitleSource": "placeholder",
            "sessionTitleRevision": 0,
            "sessionTitlePolicyVersion": kordi_session::naming::SESSION_TITLE_POLICY_VERSION,
            "groupId": new_session_id,
            "groupSpaceId": new_session_id,
            "continuedFromSpaceId": continued_from_space_id,
            "fork": {
                "forkedFromSessionId": canonical_session_id,
                "forkedFromMessageId": canonical_message_id,
                "forkMode": fork_mode,
                "contextPolicy": "prefix-through-message",
                "boundary": "inherited-history-reference-only",
            },
        })
    } else {
        serde_json::json!({
            "source": "canonical-fork-snapshot",
            "sessionTitleSource": "placeholder",
            "titleSource": "placeholder",
            "sessionTitleRevision": 0,
            "sessionTitlePolicyVersion": kordi_session::naming::SESSION_TITLE_POLICY_VERSION,
            "fork": {
                "forkedFromSessionId": canonical_session_id,
                "forkedFromMessageId": canonical_message_id,
                "forkMode": fork_mode,
                "contextPolicy": "prefix-through-message",
                "boundary": "inherited-history-reference-only",
            },
        })
    };

    let request = OpenCanonicalSessionRequest {
        id: Some(new_session_id.clone()),
        kind: if source_is_group {
            "group"
        } else {
            "self-agent"
        }
        .to_string(),
        title: Some(fork_title),
        status: Some("active".to_string()),
        created_by_identity_id: local_human_id.clone(),
        primary_identity_id: if source_is_group {
            None
        } else {
            Some(local_agent_id.clone())
        },
        project_id: source_info.project_id.clone(),
        project_name: source_info.project_name.clone(),
        relationship_identity_id: None,
        participant_identity_ids: participant_ids,
        metadata: Some(metadata),
    };
    open_or_create_session_in_db(&conn, request)?;

    // Clone each source message under the new session id, mapping
    // parent_message_id through fresh ids so the reply graph stays
    // intact. Identities, sender_role, content, and timestamps are
    // preserved verbatim.
    let mut id_map: HashMap<String, String> = HashMap::new();
    let mut last_message_id: Option<String> = None;
    for source_msg in &path {
        let new_msg_id = format!("msg:{}", Uuid::new_v4().simple());
        let mapped_parent = source_msg
            .parent_message_id
            .as_ref()
            .and_then(|parent| id_map.get(parent).cloned());
        let request = AppendCanonicalMessageRequest {
            id: Some(new_msg_id.clone()),
            session_id: new_session_id.clone(),
            sender_identity_id: source_msg.sender_identity_id.clone(),
            sender_role: source_msg.sender_role.clone(),
            message_kind: source_msg.message_kind.clone(),
            content_text: source_msg.content_text.clone(),
            content: source_msg.content.clone(),
            parent_message_id: mapped_parent,
            delegated_exchange_id: source_msg.delegated_exchange_id.clone(),
            status: Some(source_msg.status.clone()),
            created_at_ms: Some(source_msg.created_at_ms),
            // Stable dedup key, scoped by the TARGET fork session id so
            // re-forking the same anchor a second time produces an
            // independent snapshot (its own target id) instead of being
            // silently emptied by append_message_in_db's
            // (source_transport, source_event_id) dedup against the first
            // fork's rows. Re-running the apply for the *same* target
            // (e.g., HMR re-trigger) still no-ops because new_session_id
            // is stable for that fork.
            source_transport: Some("canonical-fork-snapshot".to_string()),
            source_event_id: Some(format!(
                "fork-snapshot:{}:{}:{}",
                new_session_id, canonical_session_id, source_msg.id
            )),
        };
        let inserted = append_message_in_db(&conn, request)?;
        id_map.insert(source_msg.id.clone(), inserted.id.clone());
        last_message_id = Some(inserted.id);
    }

    // Pre-create the local kordi_session row so when the user sends
    // their first message in the fork, the runtime appends to the
    // matching local store and the existing canonical sync writes
    // those new entries back to the same canonical session id.
    let local_settings = kordi_core::settings::Settings::load_global();
    let local_conn = kordi_session::store::open_db(&kordi_core::config::session_db_path(
        &local_settings.storage,
    ))
    .map_err(|err| err.to_string())?;
    if kordi_session::store::get_session(&local_conn, &new_session_id)
        .map_err(|err| err.to_string())?
        .is_none()
    {
        kordi_session::store::create_session_with_id_parent_and_message(
            &local_conn,
            &new_session_id,
            cwd,
            Some(canonical_session_id),
            Some(canonical_message_id),
        )
        .map_err(|err| err.to_string())?;
    }

    Ok(DesktopForkSessionOutcome {
        session_id: new_session_id.clone(),
        source_session_id: canonical_session_id.to_string(),
        source_entry_id: canonical_message_id.to_string(),
        selected_text: String::new(),
        branch_leaf_id: last_message_id,
        cwd: cwd.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(
        id: &str,
        sender_identity_id: &str,
        status: &str,
        delivery_state: &str,
        request_id: Option<&str>,
    ) -> CanonicalSessionMessage {
        let mut content = serde_json::json!({ "deliveryState": delivery_state });
        if let Some(request_id) = request_id {
            content["requestId"] = serde_json::Value::String(request_id.to_string());
            content["replyToMessageId"] = serde_json::Value::String(request_id.to_string());
        }
        CanonicalSessionMessage {
            id: id.to_string(),
            session_id: "session:group".to_string(),
            sender_identity_id: sender_identity_id.to_string(),
            sender_role: "external-agent".to_string(),
            message_kind: "agent-turn".to_string(),
            content_text: if delivery_state == "processing" {
                "processing..."
            } else {
                "answer"
            }
            .to_string(),
            content: Some(content),
            parent_message_id: request_id.map(str::to_string),
            delegated_exchange_id: None,
            status: status.to_string(),
            sequence_num: 1,
            created_at_ms: 1,
            updated_at_ms: 1,
            content_hash: None,
            source_transport: Some("cloud-group-agent".to_string()),
            source_event_id: Some(id.to_string()),
        }
    }

    #[test]
    fn fork_snapshot_drops_cloud_group_processing_row_when_terminal_response_is_present() {
        let processing = message(
            "msg:cloud-agent-processing:req1:acct_peer",
            "agent:cloud:acct_peer",
            "processing",
            "processing",
            Some("req1"),
        );
        let complete = message(
            "msg:cloud-agent:turn1",
            "agent:cloud:acct_peer",
            "received",
            "complete",
            Some("req1"),
        );

        let snapshot = prepare_fork_snapshot_messages(&[processing, complete.clone()]);

        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].id, complete.id);
    }

    #[test]
    fn fork_snapshot_terminalizes_unanswered_cloud_group_processing_row() {
        let processing = message(
            "msg:cloud-agent-processing:req1:acct_peer",
            "agent:cloud:acct_peer",
            "processing",
            "processing",
            Some("req1"),
        );

        let snapshot = prepare_fork_snapshot_messages(&[processing]);

        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].status, "cancelled");
        assert_eq!(
            snapshot[0].content_text,
            "Request was still processing when this fork was created."
        );
        assert_eq!(
            snapshot[0]
                .content
                .as_ref()
                .and_then(|value| value.get("deliveryState"))
                .and_then(|value| value.as_str()),
            Some("cancelled"),
        );
    }
}
