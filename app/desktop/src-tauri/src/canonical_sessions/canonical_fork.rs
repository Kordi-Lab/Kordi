use std::collections::HashMap;

use kordi_cli::desktop_runtime::DesktopForkSessionOutcome;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use super::models::{
    AppendCanonicalMessageRequest, CanonicalSessionMessage, OpenCanonicalSessionRequest,
};
use super::{
    append_message_in_db_pub, local_agent_identity_id_pub, local_profile_human_identity_id_pub,
    open_db, open_or_create_session_in_db_pub,
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
    title: Option<String>,
    project_id: Option<String>,
    project_name: Option<String>,
}

fn select_source_session_info(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<SourceSessionInfo>, String> {
    conn.query_row(
        "SELECT title, project_id, project_name FROM sessions WHERE id = ?1",
        params![session_id],
        |row| {
            Ok(SourceSessionInfo {
                title: row.get(0)?,
                project_id: row.get(1)?,
                project_name: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn select_source_agent_participants(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<String>, String> {
    // Only agent identities are carried into the fork's participant
    // list. Including other humans would push the participant-space
    // classifier into "group" and make the fork render as a brand
    // new group conversation in the sidebar — we want it to live as
    // a private continuation that nests under the source via fork
    // lineage instead. Other humans don't see the private fork
    // anyway, so dropping them from @-mention targets is correct.
    let mut stmt = conn
        .prepare(
            "SELECT sp.identity_id
             FROM session_participants sp
             JOIN identities idn ON idn.id = sp.identity_id
             WHERE sp.session_id = ?1 AND sp.state = 'active' AND idn.kind = 'agent'
             ORDER BY sp.added_at_ms ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| err.to_string())?);
    }
    Ok(out)
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
    let path = messages[..=anchor_index].to_vec();

    let source_info = select_source_session_info(&conn, canonical_session_id)?;
    let source_title = source_info
        .as_ref()
        .and_then(|info| info.title.clone())
        .filter(|value| !value.trim().is_empty());

    let local_human = local_profile_human_identity_id_pub(&conn, "You")?;
    let local_agent =
        local_agent_identity_id_pub(&conn, &local_human, "Kordi", cwd)?;

    // Carry only the source's agent identities into the fork so the
    // user can still @-mention any agent that was in the group. We
    // intentionally skip other humans: including them would flip the
    // participant-space classifier to "group" and render the fork as
    // a duplicate group entry instead of a private continuation.
    let mut participant_ids = vec![local_agent.clone()];
    for identity in select_source_agent_participants(&conn, canonical_session_id)? {
        if identity == local_agent {
            continue;
        }
        if !participant_ids.iter().any(|existing| existing == &identity) {
            participant_ids.push(identity);
        }
    }

    // Mint a fresh canonical session id distinct from the source so the
    // sidebar and canonical store treat the fork as an independent
    // self-agent conversation.
    let new_session_id = format!("session:fork:{}", Uuid::new_v4().simple());
    let metadata = serde_json::json!({
        "source": "canonical-fork-snapshot",
        "fork": {
            "forkedFromSessionId": canonical_session_id,
            "forkedFromMessageId": canonical_message_id,
            "forkMode": "private-local",
            "contextPolicy": "prefix-through-message",
            "boundary": "inherited-history-reference-only",
        },
    });

    let request = OpenCanonicalSessionRequest {
        id: Some(new_session_id.clone()),
        kind: "self-agent".to_string(),
        title: source_title.clone(),
        status: Some("active".to_string()),
        created_by_identity_id: local_human.clone(),
        primary_identity_id: Some(local_agent.clone()),
        project_id: source_info.as_ref().and_then(|info| info.project_id.clone()),
        project_name: source_info.and_then(|info| info.project_name.clone()),
        relationship_identity_id: None,
        participant_identity_ids: participant_ids,
        metadata: Some(metadata),
    };
    open_or_create_session_in_db_pub(&conn, request)?;

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
            // Stable dedup key keeps a re-fork from the same anchor
            // idempotent: re-running the fork would no-op on existing
            // snapshot rows rather than duplicating them.
            source_transport: Some("canonical-fork-snapshot".to_string()),
            source_event_id: Some(format!(
                "fork-snapshot:{}:{}",
                canonical_session_id, source_msg.id
            )),
        };
        let inserted = append_message_in_db_pub(&conn, request)?;
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
