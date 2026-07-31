//! Process-local blank draft lifecycle before the first persisted message.

use std::sync::Arc;

use kordi_cli::desktop_runtime::{
    DesktopChatModelOption, DesktopChatProjectGroup, DesktopChatSessionSummary,
    DesktopRuntimeSession,
};

use super::{
    attach_cloud_scheduled_task_runtime, DesktopChatManager, DesktopChatState, DesktopSessionHandle,
};

pub(super) const TRANSIENT_LOCAL_DRAFT_SESSION_ID: &str = "draft:local-chat";

fn is_placeholder_session_title(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed.is_empty() || trimmed.eq_ignore_ascii_case("New session") || trimmed == "Session"
}

fn is_default_agent_session_title(title: &str) -> bool {
    matches!(
        title.trim().to_lowercase().as_str(),
        "kordi" | "my kordi" | "my agent" | "my kordi session" | "my agent session"
    )
}

pub(super) fn is_blank_draft_summary(summary: &DesktopChatSessionSummary) -> bool {
    summary.message_count == 0
        && (summary.draft
            || is_placeholder_session_title(&summary.title)
            || is_default_agent_session_title(&summary.title))
}

pub(super) fn filter_blank_draft_projects(
    projects: Vec<DesktopChatProjectGroup>,
) -> Vec<DesktopChatProjectGroup> {
    projects
        .into_iter()
        .map(|mut project| {
            project
                .sessions
                .retain(|session| !is_blank_draft_summary(session));
            project
        })
        .collect()
}

pub(super) async fn ensure_transient_draft_runtime(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
) -> Result<DesktopSessionHandle, String> {
    {
        let sessions = manager.sessions.lock().await;
        if let Some(handle) = sessions.get(TRANSIENT_LOCAL_DRAFT_SESSION_ID).cloned() {
            return Ok(handle);
        }
    }

    let mut runtime = DesktopRuntimeSession::create_new(cwd.to_path_buf())
        .await
        .map_err(|err| err.to_string())?;
    attach_cloud_scheduled_task_runtime(&mut runtime);
    let handle = Arc::new(tokio::sync::Mutex::new(runtime));
    let mut sessions = manager.sessions.lock().await;
    Ok(sessions
        .entry(TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string())
        .or_insert_with(|| handle.clone())
        .clone())
}

pub(super) async fn materialize_transient_draft_runtime(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
) -> Result<String, String> {
    let handle = ensure_transient_draft_runtime(manager, cwd).await?;
    let session_id = {
        let mut runtime = handle.lock().await;
        runtime
            .materialize_session()
            .map_err(|err| err.to_string())?;
        runtime.session_id().to_string()
    };

    let mut sessions = manager.sessions.lock().await;
    sessions.remove(TRANSIENT_LOCAL_DRAFT_SESSION_ID);
    sessions.insert(session_id.clone(), handle);
    Ok(session_id)
}

pub(super) async fn build_transient_draft_chat_state(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    persisted: Vec<DesktopChatSessionSummary>,
    projects: Vec<DesktopChatProjectGroup>,
    model_options: Vec<DesktopChatModelOption>,
) -> Result<DesktopChatState, String> {
    let runtime = ensure_transient_draft_runtime(manager, cwd).await?;
    let runtime = runtime.lock().await;
    let mut active_session = runtime.detail().map_err(|err| err.to_string())?;
    active_session.id = TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string();
    active_session.title = "New session".to_string();
    active_session.subtitle.clear();
    active_session.updated_at_label = "Draft".to_string();
    active_session.message_count = 0;
    active_session.draft = true;
    active_session.messages.clear();

    Ok(DesktopChatState {
        cwd: cwd.display().to_string(),
        active_session_id: TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string(),
        sessions: persisted,
        projects,
        active_session,
        local_agent: runtime.agent_profile(),
        model_options,
        slash_commands: runtime.slash_commands(),
    })
}
