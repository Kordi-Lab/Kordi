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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{self, SessionTitleSource};

    #[test]
    fn title_and_import_state_round_trip_through_jsonl() {
        let source = store::open_memory().expect("source database");
        let session_id = store::create_session_with_parent_and_message(
            &source,
            "/tmp/project",
            Some("parent-session"),
            Some("parent-message"),
        )
        .expect("create source session");
        store::update_session_scope(
            &source,
            &session_id,
            "project",
            "/tmp/project",
            Some("/tmp/project"),
        )
        .expect("set project scope");
        store::set_session_title(
            &source,
            &session_id,
            Some("Release readiness review"),
            SessionTitleSource::Manual,
            None,
        )
        .expect("name source session");

        let directory = tempfile::tempdir().expect("temporary export directory");
        let export_path = directory.path().join("session.jsonl");
        export_jsonl(&source, &session_id, &export_path).expect("export session");

        let header_line = std::fs::read_to_string(&export_path)
            .expect("read export")
            .lines()
            .next()
            .expect("export header")
            .to_string();
        let header: serde_json::Value =
            serde_json::from_str(&header_line).expect("parse export header");
        assert_eq!(header["version"], 4);
        assert_eq!(header["name"], "Release readiness review");
        assert_eq!(header["title_source"], "manual");
        assert_eq!(header["session_scope"], "project");
        assert_eq!(header["parent_session_message"], "parent-message");

        let target = store::open_memory().expect("target database");
        let imported_id = import_jsonl(&export_path, &target).expect("import session");
        let imported = store::get_session(&target, &imported_id)
            .expect("read imported session")
            .expect("imported session exists");
        assert_eq!(imported.name.as_deref(), Some("Release readiness review"));
        assert_eq!(imported.title_source, SessionTitleSource::Imported);
        assert_eq!(imported.session_scope, "project");
        assert_eq!(imported.project_root.as_deref(), Some("/tmp/project"));
        assert_eq!(
            imported.parent_session_message_id.as_deref(),
            Some("parent-message")
        );
    }
}
