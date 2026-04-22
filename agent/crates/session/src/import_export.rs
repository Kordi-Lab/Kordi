use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;

mod export;
mod import;

/// Import a legacy Kordi JSONL session file into SQLite.
pub fn import_jsonl(path: &Path, conn: &Connection) -> Result<String> {
    import::import_jsonl(path, conn)
}

/// Export a session from SQLite to legacy Kordi-compatible JSONL.
pub fn export_jsonl(conn: &Connection, session_id: &str, output: &Path) -> Result<()> {
    export::export_jsonl(conn, session_id, output)
}
