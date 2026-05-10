use chrono::{TimeZone, Utc};
use kordi_cli::desktop_runtime::DesktopForkSessionOutcome;
use kordi_core::types::{
    AgentMessage, AssistantContent, AssistantMessage, ContentBlock, EntryBase, EntryId,
    SessionEntry, StopReason, Usage, UserMessage,
};
use rusqlite::{Connection, params};

use super::open_db;
use super::models::CanonicalSessionMessage;

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

fn classify_role(message: &CanonicalSessionMessage) -> CanonicalRole {
    match message.sender_role.as_str() {
        "self" | "person" => CanonicalRole::Human,
        "delegate" | "agent" => CanonicalRole::Agent,
        _ => CanonicalRole::Skip,
    }
}

enum CanonicalRole {
    Human,
    Agent,
    Skip,
}

/// Translate a single canonical message into a `SessionEntry` chained
/// off `parent_id`, using a synthesized timestamp from the canonical
/// `created_at_ms`. Returns `None` for messages we intentionally drop
/// (delegation system events, unknown roles, empty content).
fn translate_canonical_message(
    message: &CanonicalSessionMessage,
    parent_id: Option<&EntryId>,
) -> Option<SessionEntry> {
    let text = message.content_text.trim();
    if text.is_empty() {
        return None;
    }
    let role = classify_role(message);
    let timestamp = Utc.timestamp_millis_opt(message.created_at_ms).single().unwrap_or_else(Utc::now);
    let base = EntryBase {
        id: EntryId::generate(),
        parent_id: parent_id.cloned(),
        timestamp,
    };
    match role {
        CanonicalRole::Human => Some(SessionEntry::Message {
            base,
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: text.to_string(),
                }],
                timestamp: message.created_at_ms,
            }),
        }),
        CanonicalRole::Agent => Some(SessionEntry::Message {
            base,
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![AssistantContent::Text {
                    text: text.to_string(),
                }],
                provider: "snapshot".into(),
                model: "snapshot".into(),
                usage: Usage::default(),
                stop_reason: StopReason::Stop,
                error_message: None,
                timestamp: message.created_at_ms,
            }),
        }),
        CanonicalRole::Skip => None,
    }
}

/// Fork a canonical (group/bridge) session into a new local chat
/// session containing every translated message up through (and
/// including) `canonical_message_id`. The new session records the
/// canonical session id and message id as its parent lineage so the
/// frontend can render the same "Forked from {parent}" backlink and
/// fork-tree affordances as for native local forks.
pub fn fork_canonical_session_into_local_chat(
    canonical_session_id: &str,
    canonical_message_id: &str,
    cwd: &str,
) -> Result<DesktopForkSessionOutcome, String> {
    let canonical_conn = open_db()?;
    let messages = list_canonical_messages(&canonical_conn, canonical_session_id)?;
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
    let path = &messages[..=anchor_index];
    drop(canonical_conn);

    let local_settings = kordi_core::settings::Settings::load_global();
    let local_conn = kordi_session::store::open_db(&kordi_core::config::session_db_path(
        &local_settings.storage,
    ))
    .map_err(|err| err.to_string())?;

    let new_session_id = kordi_session::store::create_session_with_parent_and_message(
        &local_conn,
        cwd,
        Some(canonical_session_id),
        Some(canonical_message_id),
    )
    .map_err(|err| err.to_string())?;

    // Chain entries via parent_id so the active path (root → leaf) is
    // a clean linear walk, mirroring how local forks read.
    let mut last_parent_id: Option<EntryId> = None;
    let mut last_entry_id: Option<String> = None;
    let mut selected_text = String::new();
    for message in path {
        let Some(entry) = translate_canonical_message(message, last_parent_id.as_ref()) else {
            continue;
        };
        let entry_id_str = entry.base().id.0.clone();
        kordi_session::store::append_entry(&local_conn, &new_session_id, &entry)
            .map_err(|err| err.to_string())?;
        if message.id == canonical_message_id {
            // The clicked message is, by user convention, an agent
            // response; we don't surface its text as composer prefill.
            selected_text.clear();
        }
        last_parent_id = Some(EntryId(entry_id_str.clone()));
        last_entry_id = Some(entry_id_str);
    }

    Ok(DesktopForkSessionOutcome {
        session_id: new_session_id,
        source_session_id: canonical_session_id.to_string(),
        source_entry_id: canonical_message_id.to_string(),
        selected_text,
        branch_leaf_id: last_entry_id,
        cwd: cwd.to_string(),
    })
}
