use std::collections::HashMap;

use kordi_cli::desktop_runtime::DesktopForkSessionOutcome;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::{
    AppendCanonicalMessageRequest, CanonicalSessionMessage, OpenCanonicalSessionRequest,
};
use super::{
    append_message_in_db, local_profile_human_identity_id, open_db, open_or_create_session_in_db,
};

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
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[derive(Debug, Clone)]
struct SourceSessionInfo {
    kind: String,
    project_id: Option<String>,
    project_name: Option<String>,
    primary_identity_id: Option<String>,
    metadata: serde_json::Value,
}

fn select_source_session_info(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SourceSessionInfo>, String> {
    conn.query_row(
        "SELECT kind, project_id, project_name, primary_identity_id, metadata_json FROM sessions WHERE id = ?1",
        params![session_id],
        |row| {
            Ok(SourceSessionInfo {
                kind: row.get(0)?,
                project_id: row.get(1)?,
                project_name: row.get(2)?,
                primary_identity_id: row.get(3)?,
                metadata: row.get::<_, Option<String>>(4)?.and_then(|value| serde_json::from_str(&value).ok()).unwrap_or_default(),
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn select_source_agents(conn: &Connection, session_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT participant.identity_id
             FROM session_participants participant
             JOIN identities identity ON identity.id = participant.identity_id
             WHERE participant.session_id = ?1
               AND participant.state = 'active'
               AND identity.kind = 'agent'
             ORDER BY participant.added_at_ms ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn desktop_entry_alias(message: &CanonicalSessionMessage) -> Option<String> {
    message
        .content
        .as_ref()
        .and_then(|content| content.get("desktopEntryId"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn source_kind_allows_fork(kind: &str) -> bool {
    matches!(kind, "self-agent" | "direct-agent" | "project")
}

fn fork_primary_agent(primary: Option<&str>, agents: &[String]) -> Result<String, String> {
    if let Some(primary) = primary {
        if agents.iter().any(|agent| agent == primary) {
            return Ok(primary.to_string());
        }
        return Err("The source Agent identity is unavailable.".to_string());
    }
    match agents {
        [agent] => Ok(agent.clone()),
        _ => Err("The source Agent identity is ambiguous.".to_string()),
    }
}

/// Fork an Agent session into a private Agent session that inherits the
/// transcript through `canonical_message_id`.
pub fn fork_canonical_session_into_local_chat(
    canonical_session_id: &str,
    canonical_message_id: &str,
    source_message_alias: Option<&str>,
    cwd: &str,
) -> Result<DesktopForkSessionOutcome, String> {
    let conn = open_db()?;
    let source_info = select_source_session_info(&conn, canonical_session_id)?
        .ok_or_else(|| format!("Session not found: {canonical_session_id}"))?;
    if !source_kind_allows_fork(&source_info.kind) {
        return Err("Only Agent sessions can be forked.".to_string());
    }

    let messages = list_canonical_messages(&conn, canonical_session_id)?;
    let anchor_index = messages
        .iter()
        .position(|message| message.id == canonical_message_id)
        .ok_or_else(|| format!("Canonical message not found: {canonical_message_id}"))?;
    let path = &messages[..=anchor_index];
    let local_human_id = local_profile_human_identity_id(&conn, "You")?;
    let source_agents = select_source_agents(&conn, canonical_session_id)?;
    let agent_identity_id =
        fork_primary_agent(source_info.primary_identity_id.as_deref(), &source_agents)?;

    let new_session_id = format!("session:fork:{}", Uuid::new_v4().simple());
    let mut message_aliases = vec![canonical_message_id.to_string()];
    for alias in source_message_alias
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .into_iter()
        .chain(desktop_entry_alias(&messages[anchor_index]))
    {
        if !message_aliases.contains(&alias) {
            message_aliases.push(alias);
        }
    }
    let mut metadata = serde_json::json!({
        "source": "canonical-fork-snapshot",
        "sessionTitleSource": "placeholder",
        "titleSource": "placeholder",
        "sessionTitleRevision": 0,
        "sessionTitlePolicyVersion": kordi_session::naming::SESSION_TITLE_POLICY_VERSION,
        "fork": {
            "forkedFromSessionId": canonical_session_id,
            "forkedFromMessageId": canonical_message_id,
            "forkedFromMessageAliases": message_aliases,
            "forkMode": "private-local",
            "contextPolicy": "prefix-through-message",
            "boundary": "inherited-history-reference-only",
            "snapshotMessageCount": path.len(),
        },
    });
    copy_agent_metadata(&source_info.metadata, &mut metadata);
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some(new_session_id.clone()),
            kind: source_info.kind,
            title: Some("New fork".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: local_human_id,
            primary_identity_id: Some(agent_identity_id.clone()),
            project_id: source_info.project_id,
            project_name: source_info.project_name,
            relationship_identity_id: None,
            participant_identity_ids: vec![agent_identity_id],
            metadata: Some(metadata),
        },
    )?;

    let mut id_map = HashMap::new();
    let mut last_message_id = None;
    for source_message in path {
        let new_message_id = format!("msg:{}", Uuid::new_v4().simple());
        let mapped_parent = source_message
            .parent_message_id
            .as_ref()
            .and_then(|parent| id_map.get(parent).cloned());
        let inserted = append_message_in_db(
            &conn,
            AppendCanonicalMessageRequest {
                id: Some(new_message_id),
                session_id: new_session_id.clone(),
                sender_identity_id: source_message.sender_identity_id.clone(),
                sender_role: source_message.sender_role.clone(),
                message_kind: source_message.message_kind.clone(),
                content_text: source_message.content_text.clone(),
                content: source_message.content.clone(),
                parent_message_id: mapped_parent,
                delegated_exchange_id: source_message.delegated_exchange_id.clone(),
                status: Some(source_message.status.clone()),
                created_at_ms: Some(source_message.created_at_ms),
                source_transport: Some("canonical-fork-snapshot".to_string()),
                source_event_id: Some(format!(
                    "fork-snapshot:{}:{}:{}",
                    new_session_id, canonical_session_id, source_message.id
                )),
            },
        )?;
        id_map.insert(source_message.id.clone(), inserted.id.clone());
        last_message_id = Some(inserted.id);
    }

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
        session_id: new_session_id,
        source_session_id: canonical_session_id.to_string(),
        source_entry_id: canonical_message_id.to_string(),
        selected_text: String::new(),
        branch_leaf_id: last_message_id,
        cwd: cwd.to_string(),
    })
}

// Shared by empty side-chat creation and history forks. Neither may copy membership or live work.
pub(super) fn copy_agent_metadata(source: &serde_json::Value, target: &mut serde_json::Value) {
    for key in [
        "createdFrom",
        "agentId",
        "cloudAgentId",
        "cloudAgentName",
        "cloudAgentRole",
        "cloudAgentSystemPrompt",
        "cloudAgentSourceSummary",
        "cloudAgentBoundaries",
        "cloudAgentSkills",
        "cloudAgentTools",
        "cloudAgentPlugins",
        "cloudAgentOwnerAccountId",
        "cloudAgentOwnerName",
        "cloudAgentRuntimeRoute",
        "sourceHostId",
        "peerNodeId",
        "peerRuntime",
        "peerDisplayName",
        "peerOwnerName",
        "peerAgentId",
        "targetAgentId",
    ] {
        if let Some(value) = source.get(key) {
            target[key] = value.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fork_primary_agent, source_kind_allows_fork};

    #[test]
    fn forks_keep_the_source_agent_instead_of_selecting_the_local_default() {
        let agents = vec!["agent:default".to_string(), "agent:research".to_string()];
        assert_eq!(
            fork_primary_agent(Some("agent:research"), &agents).unwrap(),
            "agent:research"
        );
        assert!(fork_primary_agent(Some("agent:missing"), &agents).is_err());
        assert!(fork_primary_agent(None, &agents).is_err());
        assert_eq!(
            fork_primary_agent(None, &agents[1..]).unwrap(),
            "agent:research"
        );
    }

    #[test]
    fn only_agent_session_kinds_allow_forks() {
        assert!(source_kind_allows_fork("self-agent"));
        assert!(source_kind_allows_fork("direct-agent"));
        assert!(source_kind_allows_fork("project"));
        assert!(!source_kind_allows_fork("group"));
        assert!(!source_kind_allows_fork("direct-person"));
    }
}
