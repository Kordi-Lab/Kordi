use std::sync::Arc;

use anyhow::{Result, anyhow, bail};
use kordi_tools::task_operator::models::TaskOperatorBackgroundSession;

use super::session_catalog::open_sessions_db;
use super::{DesktopRuntimeSession, load_session_messages, truncate_chars};

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSessionMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp_ms: i64,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSessionSnapshot {
    pub can_resume: bool,
    pub turn_id: Option<String>,
    pub activity: serde_json::Value,
    pub session_id: String,
    pub parent_session_id: String,
    pub parent_request_id: Option<String>,
    pub title: String,
    pub status: String,
    pub messages: Vec<BackgroundSessionMessage>,
}

pub fn is_background_runtime_session(session_id: &str) -> Result<bool> {
    let conn = open_sessions_db()?;
    Ok(kordi_session::store::get_session(&conn, session_id)?
        .is_some_and(|row| matches!(row.session_scope.as_str(), "runtime" | "runtime-starting")))
}

pub fn activate_background_runtime_session(session_id: &str) -> Result<()> {
    let conn = open_sessions_db()?;
    let row = kordi_session::store::get_session(&conn, session_id)?
        .ok_or_else(|| anyhow!("Subsession not found"))?;
    if row.session_scope != "runtime-starting" {
        bail!("Subsession is already initialized");
    }
    kordi_session::store::update_session_scope(
        &conn,
        session_id,
        "runtime",
        &row.cwd,
        row.project_root.as_deref(),
    )
}

pub fn background_runtime_session_ids() -> Result<Vec<String>> {
    let conn = open_sessions_db()?;
    Ok(kordi_session::store::list_all_sessions(&conn)?
        .into_iter()
        .filter(|row| row.session_scope == "runtime")
        .take(128)
        .map(|row| row.session_id)
        .collect())
}

pub fn background_runtime_snapshot(session_id: &str) -> Result<BackgroundSessionSnapshot> {
    let conn = open_sessions_db()?;
    background_snapshot_from_store(&conn, session_id)
}

fn background_snapshot_from_store(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<BackgroundSessionSnapshot> {
    let row = kordi_session::store::get_session(conn, session_id)?
        .ok_or_else(|| anyhow!("Subsession not found"))?;
    if row.session_scope != "runtime" {
        bail!("Session is not a model-created subsession");
    }
    let messages = load_session_messages(conn, session_id)?;
    let status =
        crate::task_operator::inspect_persisted_background_session(conn, session_id)?.status;
    Ok(BackgroundSessionSnapshot {
        can_resume: saved_runtime_profile_from_store(conn, session_id)?.is_some(),
        turn_id: None,
        activity: serde_json::json!({}),
        session_id: row.session_id,
        parent_session_id: row
            .parent_session_id
            .ok_or_else(|| anyhow!("Subsession parent is missing"))?,
        parent_request_id: row.parent_session_message_id,
        title: row.name.unwrap_or_else(|| "Agent task".to_string()),
        status,
        // Share visible conversation text, never system instructions, reasoning,
        // raw tool payloads, credentials, or machine-local artifact paths.
        messages: messages
            .into_iter()
            .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
            .filter(|message| !message.text.trim().is_empty())
            .enumerate()
            .map(|(index, message)| BackgroundSessionMessage {
                id: message
                    .entry_id
                    .unwrap_or_else(|| format!("message-{index}")),
                role: message.role,
                text: message.text,
                timestamp_ms: message.timestamp_ms,
            })
            .collect(),
    })
}

// Local-only metadata: never included in a shared transcript or Cloud snapshot.
pub(super) fn saved_runtime_profile(
    session_id: &str,
) -> Result<Option<super::DesktopRuntimeProfile>> {
    let conn = open_sessions_db()?;
    saved_runtime_profile_from_store(&conn, session_id)
}

fn saved_runtime_profile_from_store(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<super::DesktopRuntimeProfile>> {
    use rusqlite::OptionalExtension;
    let raw: Option<String> = conn.query_row("SELECT json_extract(payload,'$.data') FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')='subsession_runtime_profile' ORDER BY seq DESC LIMIT 1", [session_id], |row| row.get(0)).optional()?;
    raw.map(|raw| {
        let value: serde_json::Value = serde_json::from_str(&raw)?;
        let mut profile: super::DesktopRuntimeProfile =
            serde_json::from_value(value["profile"].clone())?;
        profile.execution_policy = match value["executionPolicy"].as_str() {
            Some("safety") => Some(kordi_tools::ExecutionPolicy::Safety),
            Some("yolo") => Some(kordi_tools::ExecutionPolicy::Yolo),
            None => None,
            _ => bail!("Invalid saved execution policy"),
        };
        Ok(profile)
    })
    .transpose()
}

pub(super) fn save_runtime_profile(
    setup: &super::SessionRuntimeSetup,
    profile: &super::DesktopRuntimeProfile,
) -> Result<()> {
    use kordi_core::types::{EntryBase, EntryId, SessionEntry};
    let Some(row) = kordi_session::store::get_session(&setup.conn, &setup.session_id)? else {
        return Ok(());
    };
    if !matches!(row.session_scope.as_str(), "runtime" | "runtime-starting")
        || saved_runtime_profile_from_store(&setup.conn, &setup.session_id)?.is_some()
    {
        return Ok(());
    }
    let entry = SessionEntry::Custom {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: row.leaf_id.map(EntryId),
            timestamp: chrono::Utc::now(),
        },
        custom_type: "subsession_runtime_profile".into(),
        data: Some(
            serde_json::json!({"profile":profile,"executionPolicy":profile.execution_policy.map(|policy|policy.as_str())}),
        ),
    };
    kordi_session::store::append_entry(&setup.conn, &setup.session_id, &entry)?;
    Ok(())
}

#[cfg(test)]
mod runtime_snapshot_tests;

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
    kordi_session::store::update_session_scope(
        &conn,
        &session_id,
        "runtime-starting",
        &cwd.display().to_string(),
        None,
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
