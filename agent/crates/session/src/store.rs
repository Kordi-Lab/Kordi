use anyhow::Result;
use rusqlite::Connection;

pub use crate::naming::SessionTitleSource;

mod fork;
mod queries;
#[cfg(test)]
mod tests;
mod writes;

/// A lightweight row from the entries table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EntryRow {
    pub session_id: String,
    pub seq: i64,
    pub entry_id: String,
    pub parent_id: Option<String>,
    pub entry_type: String,
    pub timestamp: String,
    pub payload: String,
}

/// Session metadata row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRow {
    pub session_id: String,
    pub cwd: String,
    pub created_at: String,
    pub updated_at: String,
    pub name: Option<String>,
    pub title_source: SessionTitleSource,
    pub title_revision: i64,
    pub title_policy_version: i64,
    pub title_generated_from_entry_id: Option<String>,
    pub title_updated_at: Option<String>,
    pub leaf_id: Option<String>,
    pub entry_count: i64,
    pub parent_session_id: Option<String>,
    pub parent_session_message_id: Option<String>,
    pub session_scope: String,
    pub project_root: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRow {
    pub project_id: String,
    pub root: String,
    pub name: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForkSessionResult {
    pub session_id: String,
    pub selected_text: String,
    pub branch_leaf_id: Option<String>,
    pub source_session_id: String,
    pub source_entry_id: String,
}

pub fn open_db(path: &std::path::Path) -> Result<Connection> {
    writes::open_db(path)
}

pub fn open_memory() -> Result<Connection> {
    writes::open_memory()
}

pub fn create_session(conn: &Connection, cwd: &str) -> Result<String> {
    writes::create_session(conn, cwd)
}

pub fn create_session_with_parent(
    conn: &Connection,
    cwd: &str,
    parent_session_id: Option<&str>,
) -> Result<String> {
    writes::create_session_with_parent(conn, cwd, parent_session_id, None)
}

pub fn create_session_with_parent_and_message(
    conn: &Connection,
    cwd: &str,
    parent_session_id: Option<&str>,
    parent_session_message_id: Option<&str>,
) -> Result<String> {
    writes::create_session_with_parent(conn, cwd, parent_session_id, parent_session_message_id)
}

pub fn create_session_with_id(conn: &Connection, session_id: &str, cwd: &str) -> Result<()> {
    writes::create_session_with_id(conn, session_id, cwd)
}

pub fn create_session_with_id_and_parent(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
    parent_session_id: Option<&str>,
) -> Result<()> {
    writes::create_session_with_id_and_parent(conn, session_id, cwd, parent_session_id, None)
}

pub fn create_session_with_id_parent_and_message(
    conn: &Connection,
    session_id: &str,
    cwd: &str,
    parent_session_id: Option<&str>,
    parent_session_message_id: Option<&str>,
) -> Result<()> {
    writes::create_session_with_id_and_parent(
        conn,
        session_id,
        cwd,
        parent_session_id,
        parent_session_message_id,
    )
}

pub fn append_entry(
    conn: &Connection,
    session_id: &str,
    entry: &kordi_core::types::SessionEntry,
) -> Result<i64> {
    writes::append_entry(conn, session_id, entry)
}

pub fn get_entry(conn: &Connection, session_id: &str, entry_id: &str) -> Result<Option<EntryRow>> {
    queries::get_entry(conn, session_id, entry_id)
}

pub fn get_entries(conn: &Connection, session_id: &str) -> Result<Vec<EntryRow>> {
    queries::get_entries(conn, session_id)
}

pub fn get_children(conn: &Connection, session_id: &str, parent_id: &str) -> Result<Vec<EntryRow>> {
    queries::get_children(conn, session_id, parent_id)
}

pub fn get_session(conn: &Connection, session_id: &str) -> Result<Option<SessionRow>> {
    queries::get_session(conn, session_id)
}

pub fn list_sessions(conn: &Connection, cwd: &str) -> Result<Vec<SessionRow>> {
    queries::list_sessions(conn, cwd)
}

pub fn list_all_sessions(conn: &Connection) -> Result<Vec<SessionRow>> {
    queries::list_all_sessions(conn)
}

pub fn list_projects(conn: &Connection) -> Result<Vec<ProjectRow>> {
    queries::list_projects(conn)
}

pub fn upsert_project(
    conn: &Connection,
    project_id: &str,
    root: &str,
    name: Option<&str>,
) -> Result<()> {
    writes::upsert_project(conn, project_id, root, name)
}

pub fn get_last_message_timestamp(conn: &Connection, session_id: &str) -> Result<Option<String>> {
    queries::get_last_message_timestamp(conn, session_id)
}

pub fn get_last_entry_timestamp(conn: &Connection, session_id: &str) -> Result<Option<String>> {
    queries::get_last_entry_timestamp(conn, session_id)
}

pub fn set_leaf(conn: &Connection, session_id: &str, leaf_id: Option<&str>) -> Result<()> {
    writes::set_leaf(conn, session_id, leaf_id)
}

pub fn set_session_name(conn: &Connection, session_id: &str, name: Option<&str>) -> Result<()> {
    writes::set_session_name(conn, session_id, name)
}

pub fn set_session_title(
    conn: &Connection,
    session_id: &str,
    name: Option<&str>,
    source: SessionTitleSource,
    generated_from_entry_id: Option<&str>,
) -> Result<bool> {
    writes::set_session_title(conn, session_id, name, source, generated_from_entry_id)
}

pub fn set_auto_session_name(
    conn: &Connection,
    session_id: &str,
    name: &str,
    generated_from_entry_id: Option<&str>,
) -> Result<bool> {
    writes::set_session_title(
        conn,
        session_id,
        Some(name),
        SessionTitleSource::Auto,
        generated_from_entry_id,
    )
}

pub fn update_session_scope(
    conn: &Connection,
    session_id: &str,
    session_scope: &str,
    cwd: &str,
    project_root: Option<&str>,
) -> Result<()> {
    writes::update_session_scope(conn, session_id, session_scope, cwd, project_root)
}

pub fn delete_session(conn: &Connection, session_id: &str) -> Result<()> {
    writes::delete_session(conn, session_id)
}

pub fn parse_entry(row: &EntryRow) -> Result<kordi_core::types::SessionEntry> {
    queries::parse_entry(row)
}

pub fn copy_branch_to_session(
    conn: &Connection,
    source_session_id: &str,
    target_session_id: &str,
    leaf_id: &str,
) -> Result<()> {
    fork::copy_branch_to_session(conn, source_session_id, target_session_id, leaf_id)
}

pub fn fork_session_from_entry(
    conn: &Connection,
    source_session_id: &str,
    entry_id: &str,
    cwd: &str,
) -> Result<ForkSessionResult> {
    fork::fork_session_from_entry(conn, source_session_id, entry_id, cwd)
}
