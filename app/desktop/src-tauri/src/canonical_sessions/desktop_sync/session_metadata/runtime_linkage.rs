//! Maps a runtime transcript entry of a Kordi Cloud self-agent chat to its
//! canonical row when the row no longer carries the entry id as an alias.

use std::collections::{HashMap, HashSet};

use kordi_core::types::{AgentMessage, SessionEntry};
use kordi_session::store::EntryRow;
use rusqlite::{params, Connection, OptionalExtension};

const MAX_PARENT_HOPS: usize = 64;
const CLOUD_SELF_REQUEST_PREFIX: &str = "msg:cloud:self:";
const CLOUD_SELF_RESPONSE_PREFIX: &str = "msg:cloud:self:response:";

#[derive(Clone, Copy, PartialEq, Eq)]
enum EntryRole {
    User,
    Assistant,
    Other,
}

fn entry_role(entry: &EntryRow) -> EntryRole {
    if entry.entry_type != "message" {
        return EntryRole::Other;
    }
    match kordi_session::store::parse_entry(entry) {
        Ok(SessionEntry::Message {
            message: AgentMessage::User(_),
            ..
        }) => EntryRole::User,
        Ok(SessionEntry::Message {
            message: AgentMessage::Assistant(_),
            ..
        }) => EntryRole::Assistant,
        _ => EntryRole::Other,
    }
}

/// The nearest user message above `entry`, following `parent_id` links.
fn request_entry_id<'a>(
    entry: &'a EntryRow,
    entries_by_id: &HashMap<&str, &'a EntryRow>,
) -> Option<&'a str> {
    let mut visited = HashSet::from([entry.entry_id.as_str()]);
    let mut parent_id = entry.parent_id.as_deref();
    for _ in 0..MAX_PARENT_HOPS {
        let parent = entries_by_id.get(parent_id?)?;
        if !visited.insert(parent.entry_id.as_str()) {
            return None;
        }
        if entry_role(parent) == EntryRole::User {
            return Some(parent.entry_id.as_str());
        }
        parent_id = parent.parent_id.as_deref();
    }
    None
}

fn query_message_id(
    conn: &Connection,
    sql: &str,
    session_id: &str,
    value: &str,
) -> Result<Option<String>, String> {
    conn.query_row(sql, params![session_id, value], |row| row.get(0))
        .optional()
        .map_err(|err| err.to_string())
}

fn user_row_id(
    conn: &Connection,
    session_id: &str,
    entry_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM session_messages
         WHERE session_id = ?1
           AND (id = ?2
                OR CASE WHEN json_valid(content_json)
                        THEN json_extract(content_json, '$.desktopEntryId')
                        ELSE NULL END = ?3)
         ORDER BY sequence_num DESC
         LIMIT 1",
        params![
            session_id,
            format!("{CLOUD_SELF_REQUEST_PREFIX}{entry_id}"),
            entry_id
        ],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn reply_row_id(
    conn: &Connection,
    session_id: &str,
    request_entry_id: &str,
) -> Result<Option<String>, String> {
    let response_id = format!("{CLOUD_SELF_RESPONSE_PREFIX}{request_entry_id}");
    if crate::canonical_sessions::canonical_message_exists(conn, session_id, &response_id)? {
        return Ok(Some(response_id));
    }
    if let Some(id) = query_message_id(
        conn,
        "SELECT id FROM session_messages
         WHERE session_id = ?1
           AND sender_role = 'owned-agent'
           AND CASE WHEN json_valid(content_json)
                    THEN json_extract(content_json, '$.cloudRequestMessageId')
                    ELSE NULL END = ?2
         ORDER BY sequence_num DESC
         LIMIT 1",
        session_id,
        request_entry_id,
    )? {
        return Ok(Some(id));
    }
    query_message_id(
        conn,
        "SELECT reply.id FROM session_messages reply
         JOIN session_messages request
           ON request.id = reply.parent_message_id
          AND request.session_id = reply.session_id
         WHERE reply.session_id = ?1
           AND reply.sender_role = 'owned-agent'
           AND CASE WHEN json_valid(request.content_json)
                    THEN json_extract(request.content_json, '$.desktopEntryId')
                    ELSE NULL END = ?2
         ORDER BY reply.sequence_num DESC
         LIMIT 1",
        session_id,
        request_entry_id,
    )
}

/// The canonical row for a runtime entry of a Cloud self-agent chat, found
/// through the runtime parent chain and the Cloud request/response ids rather
/// than through a stored `desktopEntryId` alias.
pub(crate) fn canonical_id_from_runtime_linkage(
    conn: &Connection,
    session_id: &str,
    entry_id: &str,
    entries: &[EntryRow],
) -> Result<Option<String>, String> {
    let entries_by_id = entries
        .iter()
        .map(|entry| (entry.entry_id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let Some(entry) = entries_by_id.get(entry_id) else {
        return Ok(None);
    };
    match entry_role(entry) {
        EntryRole::User => user_row_id(conn, session_id, entry_id),
        EntryRole::Assistant => match request_entry_id(entry, &entries_by_id) {
            Some(request_entry_id) => reply_row_id(conn, session_id, request_entry_id),
            None => Ok(None),
        },
        EntryRole::Other => Ok(None),
    }
}

/// Whether the canonical session is a Kordi Cloud self-agent chat, whose
/// forks must go through the canonical path rather than a local runtime copy.
pub(crate) fn session_is_cloud_self_agent_in_db(
    conn: &Connection,
    session_id: &str,
) -> Result<bool, String> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT primary_identity_id, metadata_json FROM sessions WHERE id = ?1",
            [session_id.trim()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((primary_identity_id, metadata_json)) = row else {
        return Ok(false);
    };
    if primary_identity_id.as_deref().is_some_and(|identity| {
        identity.starts_with("agent:cloud-self:") || identity.starts_with("agent:cloud-owned:")
    }) {
        return Ok(true);
    }
    let metadata = metadata_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
    let Some(metadata) = metadata else {
        return Ok(false);
    };
    let self_agent_flag =
        metadata.get("cloudSelfAgentSession") == Some(&serde_json::Value::Bool(true));
    let cloud_agent_id = metadata
        .get("cloudAgentId")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    Ok(self_agent_flag || cloud_agent_id)
}

#[cfg(test)]
#[path = "runtime_linkage_tests.rs"]
mod tests;
