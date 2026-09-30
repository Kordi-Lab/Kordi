use super::{open_sessions_db, project_group_id, workspace};
use anyhow::{Result, bail};

pub fn move_session_to_project(session_id: &str, project_root: &std::path::Path) -> Result<()> {
    let conn = open_sessions_db()?;
    let Some(_row) = kordi_session::store::get_session(&conn, session_id)? else {
        bail!("Session not found: {session_id}");
    };
    let transaction = conn.unchecked_transaction()?;
    let project_root_str = project_root.display().to_string();
    let group_id = project_group_id(project_root);
    kordi_session::store::upsert_project(&conn, &group_id, &project_root_str, None)?;
    workspace::persist_selected_workspace(&conn, session_id, project_root)?;
    kordi_session::store::update_session_scope(
        &conn,
        session_id,
        "project",
        &project_root_str,
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
