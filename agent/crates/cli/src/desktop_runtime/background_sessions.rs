use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use kordi_tools::task_operator::models::TaskOperatorBackgroundSession;

use super::session_catalog::open_sessions_db;
use super::{DesktopRuntimeSession, truncate_chars};

impl DesktopRuntimeSession {
    pub fn set_task_operator_runner(
        &mut self,
        runner: Arc<dyn crate::task_operator::ChildAgentRunner>,
    ) -> Result<()> {
        let store = self
            .setup
            .sibling_conn
            .clone()
            .ok_or_else(|| anyhow!("Session DB connection is unavailable"))?;
        self.setup.tool_ctx.task_operator = Some(
            crate::task_operator::build_task_operator_runtime_with_runner_and_store(
                runner,
                self.setup.tool_ctx.cwd.clone(),
                self.setup.session_id.clone(),
                crate::task_operator::DEFAULT_MAX_LIVE_TASKS,
                store,
            ),
        );
        Ok(())
    }
}

pub fn session_exists(session_id: &str) -> Result<bool> {
    let conn = open_sessions_db()?;
    Ok(kordi_session::store::get_session(&conn, session_id)?.is_some())
}

pub fn create_background_session(
    cwd: &std::path::Path,
    parent_session_id: &str,
    parent_message_id: Option<&str>,
    requested_title: &str,
) -> Result<String> {
    let parent_session_id = parent_session_id.trim();
    if parent_session_id.is_empty() {
        bail!("Background session parent cannot be empty");
    }
    let title = truncate_chars(requested_title.trim(), 80);
    if title.is_empty() {
        bail!("Background session title cannot be empty");
    }
    let conn = open_sessions_db()?;
    let session_id = kordi_session::store::create_session_with_parent_and_message(
        &conn,
        &cwd.display().to_string(),
        Some(parent_session_id),
        parent_message_id,
    )?;
    kordi_session::store::set_session_name(&conn, &session_id, Some(&title))?;
    Ok(session_id)
}

pub fn background_session_for_parent_message(
    parent_session_id: &str,
    parent_message_id: &str,
) -> Result<Option<TaskOperatorBackgroundSession>> {
    let parent_session_id = parent_session_id.trim();
    let parent_message_id = parent_message_id.trim();
    if parent_session_id.is_empty() || parent_message_id.is_empty() {
        return Ok(None);
    }
    let conn = open_sessions_db()?;
    Ok(kordi_session::store::list_all_sessions(&conn)?
        .into_iter()
        .find(|session| {
            session.parent_session_id.as_deref() == Some(parent_session_id)
                && session.parent_session_message_id.as_deref() == Some(parent_message_id)
        })
        .map(|session| TaskOperatorBackgroundSession {
            session_id: session.session_id,
            turn_id: None,
            title: session
                .name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Background session".to_string()),
            status: "running".to_string(),
        }))
}
