use super::{open_sessions_db, project_group_id, workspace};
use anyhow::{Result, bail};
use rusqlite::OptionalExtension;

pub(super) fn runtime_cwd_for_session(
    fallback_cwd: std::path::PathBuf,
    session_id: &str,
) -> Result<std::path::PathBuf> {
    let conn = open_sessions_db()?;
    let Some(row) = kordi_session::store::get_session(&conn, session_id)? else {
        return Ok(fallback_cwd);
    };
    if row.session_scope == "project"
        && let Some(project_root) = row
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        let selected: Option<String> = conn.query_row(
            "SELECT json_extract(payload,'$.data.path') FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')='desktop_execution_workspace' ORDER BY seq DESC LIMIT 1",
            [session_id], |row| row.get(0),
        ).optional()?;
        // A worktree selection updates cwd and the durable workspace together.
        // Older project sessions keep the project root as their runtime boundary.
        if selected.as_deref() == Some(row.cwd.as_str()) && !row.cwd.trim().is_empty() {
            return Ok(std::path::PathBuf::from(&row.cwd));
        }
        return Ok(std::path::PathBuf::from(project_root));
    }
    let row_cwd = row.cwd.trim();
    if row_cwd.is_empty() {
        Ok(fallback_cwd)
    } else {
        Ok(std::path::PathBuf::from(row_cwd))
    }
}

pub fn move_session_to_project(session_id: &str, project_root: &std::path::Path) -> Result<()> {
    move_session_to_project_workspace(session_id, project_root, project_root)
}

pub fn move_session_to_project_workspace(
    session_id: &str,
    project_root: &std::path::Path,
    workspace: &std::path::Path,
) -> Result<()> {
    let conn = open_sessions_db()?;
    let Some(_row) = kordi_session::store::get_session(&conn, session_id)? else {
        bail!("Session not found: {session_id}");
    };
    let transaction = conn.unchecked_transaction()?;
    let project_root_str = project_root.display().to_string();
    let group_id = project_group_id(project_root);
    kordi_session::store::upsert_project(&conn, &group_id, &project_root_str, None)?;
    workspace::persist_selected_workspace(&conn, session_id, workspace)?;
    kordi_session::store::update_session_scope(
        &conn,
        session_id,
        "project",
        &workspace.display().to_string(),
        Some(&project_root_str),
    )?;
    transaction.commit()?;
    Ok(())
}

/// Remove project membership and return the session to the default chat workspace.
pub fn remove_session_from_project(session_id: &str, chat_cwd: &std::path::Path) -> Result<()> {
    let conn = open_sessions_db()?;
    if kordi_session::store::get_session(&conn, session_id)?.is_none() {
        bail!("Session not found: {session_id}");
    }
    let transaction = conn.unchecked_transaction()?;
    workspace::persist_selected_workspace(&conn, session_id, chat_cwd)?;
    kordi_session::store::update_session_scope(
        &conn,
        session_id,
        "chat",
        &chat_cwd.display().to_string(),
        None,
    )?;
    transaction.commit()?;
    Ok(())
}
