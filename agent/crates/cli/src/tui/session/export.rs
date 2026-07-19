/// Export session entries to a JSONL file. Returns the absolute path.
pub(super) fn export_session(
    conn: &rusqlite::Connection,
    session_id: &str,
    file_path: &str,
) -> anyhow::Result<String> {
    kordi_session::import_export::export_jsonl(conn, session_id, std::path::Path::new(file_path))?;
    let abs =
        std::fs::canonicalize(file_path).unwrap_or_else(|_| std::path::PathBuf::from(file_path));
    Ok(abs.display().to_string())
}
