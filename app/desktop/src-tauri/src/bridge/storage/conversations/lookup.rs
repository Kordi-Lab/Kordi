use rusqlite::{params, Connection, OptionalExtension};

use super::records::load_conversation_record;
use super::schema::sqlite_error;
use crate::bridge::constants::BRIDGE_CONVERSATION_ID_PREFIX;
use crate::bridge::DesktopBridgeConversationRecord;

pub(in crate::bridge::storage) fn is_person_runtime(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("person")
}

pub(in crate::bridge::storage) fn scoped_conversation_id(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: &str,
) -> String {
    let base = bridge_conversation_id(host_id, peer_node_id, project_id);
    if is_person_runtime(peer_runtime) {
        format!("{base}:person")
    } else {
        base
    }
}

pub(in crate::bridge::storage) fn conversation_matches_runtime(
    existing_runtime: &str,
    peer_runtime: &str,
) -> bool {
    is_person_runtime(existing_runtime) == is_person_runtime(peer_runtime)
}

pub(in crate::bridge::storage) fn find_conversation_for_peer(
    conn: &Connection,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: &str,
) -> Result<Option<DesktopBridgeConversationRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, peer_runtime FROM bridge_conversations\n             WHERE host_id = ?1\n               AND peer_node_id = ?2\n               AND ((project_id IS NULL AND ?3 IS NULL) OR project_id = ?3)\n             ORDER BY updated_at_ms DESC, id ASC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![host_id, peer_node_id, project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;

    for row in rows {
        let (id, existing_runtime) = row.map_err(sqlite_error)?;
        if conversation_matches_runtime(&existing_runtime, peer_runtime) {
            return load_conversation_record(conn, &id);
        }
    }

    Ok(None)
}

pub(in crate::bridge::storage) fn find_recent_conversation_for_peer(
    conn: &Connection,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
) -> Result<Option<DesktopBridgeConversationRecord>, String> {
    let conversation_id = conn
        .query_row(
            "SELECT id FROM bridge_conversations
             WHERE host_id = ?1
               AND peer_node_id = ?2
               AND ((project_id IS NULL AND ?3 IS NULL) OR project_id = ?3)
             ORDER BY updated_at_ms DESC, id ASC
             LIMIT 1",
            params![host_id, peer_node_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    match conversation_id {
        Some(id) => load_conversation_record(conn, &id),
        None => Ok(None),
    }
}

pub(in crate::bridge::storage) fn apply_conversation_metadata(
    conversation: &mut DesktopBridgeConversationRecord,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
) {
    if peer_display_name.is_some() {
        conversation.peer_display_name = peer_display_name;
    }
    if peer_owner_name.is_some() {
        conversation.peer_owner_name = peer_owner_name;
    }
    if !peer_runtime.trim().is_empty() {
        conversation.peer_runtime = peer_runtime;
    }
    if project_id.is_some() {
        conversation.project_id = project_id;
    }
    if project_name.is_some() {
        conversation.project_name = project_name;
    }
}

#[allow(clippy::too_many_arguments)]

pub(in crate::bridge) fn bridge_conversation_id(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
) -> String {
    match project_id.filter(|value| !value.trim().is_empty()) {
        Some(project_id) => {
            format!("{BRIDGE_CONVERSATION_ID_PREFIX}{host_id}:{peer_node_id}:{project_id}")
        }
        None => format!("{BRIDGE_CONVERSATION_ID_PREFIX}{host_id}:{peer_node_id}"),
    }
}
