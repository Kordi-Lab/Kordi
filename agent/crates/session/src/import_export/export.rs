use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

use crate::store;

/// Export a session from SQLite to legacy Kordi-compatible JSONL.
pub(super) fn export_jsonl(conn: &Connection, session_id: &str, output: &Path) -> Result<()> {
    use std::io::Write;

    let session = store::get_session(conn, session_id)?
        .ok_or_else(|| anyhow::anyhow!("Session not found: {session_id}"))?;

    let mut file = std::fs::File::create(output)?;

    let header = serde_json::json!({
        "type": "session",
        "version": 4,
        "id": session_id,
        "timestamp": session.created_at,
        "cwd": session.cwd,
        "name": session.name,
        "title_source": session.title_source.as_str(),
        "title_revision": session.title_revision,
        "title_policy_version": session.title_policy_version,
        "title_generated_from_entry_id": session.title_generated_from_entry_id,
        "title_updated_at": session.title_updated_at,
        "parent_session": session.parent_session_id,
        "parent_session_message": session.parent_session_message_id,
        "session_scope": session.session_scope,
        "project_root": session.project_root,
    });
    writeln!(file, "{}", serde_json::to_string(&header)?)?;

    let entries = store::get_entries(conn, session_id)?;
    for entry in &entries {
        writeln!(file, "{}", entry.payload)?;
    }

    Ok(())
}
