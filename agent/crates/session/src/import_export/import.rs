use anyhow::Result;
use kordi_core::types::SessionEntry;
use rusqlite::Connection;
use std::io::{BufRead, BufReader};
use std::path::Path;

use crate::store;

/// Import a legacy Kordi JSONL session file into SQLite.
pub(super) fn import_jsonl(path: &Path, conn: &Connection) -> Result<String> {
    let file = std::fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();

    let header_line = lines
        .next()
        .ok_or_else(|| anyhow::anyhow!("Empty session file"))??;
    let header: serde_json::Value = serde_json::from_str(&header_line)?;

    let cwd = header
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or(".")
        .to_string();

    let parent_session = header
        .get("parent_session")
        .or_else(|| header.get("parentSession"))
        .and_then(|v| v.as_str());

    let parent_session_message = header
        .get("parent_session_message")
        .or_else(|| header.get("parentSessionMessage"))
        .and_then(|v| v.as_str());

    let session_id = store::create_session_with_parent_and_message(
        conn,
        &cwd,
        parent_session,
        parent_session_message,
    )?;

    let session_scope = header
        .get("session_scope")
        .or_else(|| header.get("sessionScope"))
        .and_then(|value| value.as_str())
        .unwrap_or("chat");
    let project_root = header
        .get("project_root")
        .or_else(|| header.get("projectRoot"))
        .and_then(|value| value.as_str());
    if session_scope != "chat" || project_root.is_some() {
        store::update_session_scope(conn, &session_id, session_scope, &cwd, project_root)?;
    }

    if let Some(name) = header
        .get("name")
        .or_else(|| header.get("title"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        store::set_session_title(
            conn,
            &session_id,
            Some(name),
            store::SessionTitleSource::Imported,
            None,
        )?;
    }

    for line_result in lines {
        let line = line_result?;
        if line.trim().is_empty() {
            continue;
        }

        let entry: SessionEntry = match serde_json::from_str(&line) {
            Ok(entry) => entry,
            Err(error) => {
                tracing::warn!("Skipping unparseable entry: {error}");
                continue;
            }
        };

        store::append_entry(conn, &session_id, &entry)?;
    }

    Ok(session_id)
}
