//! Persisted desktop session loading, activation, and state projection.

use std::sync::Arc;

use kordi_cli::desktop_runtime::DesktopRuntimeSession;

use super::canonical_sync::{desktop_state_for_canonical_sync, is_cloud_agent_runtime_session_id};
use super::model_options::authenticated_model_options_with_local_runtime;
use super::transient_drafts::{
    build_transient_draft_chat_state, filter_blank_draft_projects, is_blank_draft_summary,
    TRANSIENT_LOCAL_DRAFT_SESSION_ID,
};
use super::turns::session_has_running_turn;
use super::{agent_builder, DesktopChatManager, DesktopChatState};

pub(super) fn session_exists_globally(session_id: &str) -> Result<bool, String> {
    kordi_cli::desktop_runtime::session_exists(session_id).map_err(|err| err.to_string())
}

fn is_internal_runtime_session_id(session_id: &str) -> bool {
    is_cloud_agent_runtime_session_id(session_id)
        || agent_builder::is_agent_builder_session_id(session_id)
}

async fn resume_desktop_runtime(
    cwd: &std::path::Path,
    session_id: &str,
) -> Result<DesktopRuntimeSession, String> {
    if agent_builder::is_agent_builder_session_id(session_id) {
        return agent_builder::resume_agent_builder_runtime(session_id).await;
    }
    let mut runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), session_id)
        .await
        .map_err(|err| err.to_string())?;
    super::attach_cloud_scheduled_task_runtime(&mut runtime);
    Ok(runtime)
}

pub(super) async fn ensure_loaded_session(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    active_session_id: Option<String>,
) -> Result<String, String> {
    let persisted =
        kordi_cli::desktop_runtime::list_session_summaries(cwd).map_err(|err| err.to_string())?;
    let mut sessions = manager.sessions.lock().await;

    if let Some(session_id) = active_session_id {
        if session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
            return Ok(session_id);
        }
        if sessions.contains_key(&session_id) {
            return Ok(session_id);
        }
        if persisted.iter().any(|session| session.id == session_id)
            || session_exists_globally(&session_id)?
        {
            let runtime = resume_desktop_runtime(cwd, &session_id).await?;
            sessions.insert(
                session_id.clone(),
                Arc::new(tokio::sync::Mutex::new(runtime)),
            );
            return Ok(session_id);
        }
    }

    if let Some(session_id) = persisted.first().map(|session| session.id.clone()) {
        if !sessions.contains_key(&session_id) {
            let runtime = resume_desktop_runtime(cwd, &session_id).await?;
            sessions.insert(
                session_id.clone(),
                Arc::new(tokio::sync::Mutex::new(runtime)),
            );
        }
        return Ok(session_id);
    }

    Ok(TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string())
}

pub(super) async fn ensure_loaded_or_create_explicit_session(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    session_id: String,
) -> Result<String, String> {
    if session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        return ensure_loaded_session(manager, cwd, Some(session_id)).await;
    }

    {
        let sessions = manager.sessions.lock().await;
        if sessions.contains_key(&session_id) {
            return Ok(session_id);
        }
    }

    let persisted =
        kordi_cli::desktop_runtime::list_session_summaries(cwd).map_err(|err| err.to_string())?;
    let mut runtime = if persisted.iter().any(|session| session.id == session_id)
        || session_exists_globally(&session_id)?
    {
        resume_desktop_runtime(cwd, &session_id).await?
    } else if agent_builder::is_agent_builder_session_id(&session_id) {
        return Err("Agent Builder session is unavailable".to_string());
    } else {
        DesktopRuntimeSession::create_with_id(cwd.to_path_buf(), &session_id)
            .await
            .map_err(|err| err.to_string())?
    };
    if !agent_builder::is_agent_builder_session_id(&session_id) {
        super::attach_cloud_scheduled_task_runtime(&mut runtime);
    }

    let mut sessions = manager.sessions.lock().await;
    sessions.insert(
        session_id.clone(),
        Arc::new(tokio::sync::Mutex::new(runtime)),
    );
    Ok(session_id)
}

pub(super) async fn build_chat_state(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    active_session_id: String,
) -> Result<DesktopChatState, String> {
    let persisted = kordi_cli::desktop_runtime::list_session_summaries(cwd)
        .map_err(|err| err.to_string())?
        .into_iter()
        .filter(|session| !is_blank_draft_summary(session))
        .filter(|session| !is_internal_runtime_session_id(&session.id))
        .collect::<Vec<_>>();
    let model_options = authenticated_model_options_with_local_runtime(cwd).await;
    let projects = filter_blank_draft_projects(
        kordi_cli::desktop_runtime::list_project_groups(cwd).map_err(|err| err.to_string())?,
    );
    if active_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        let state =
            build_transient_draft_chat_state(manager, cwd, persisted, projects, model_options)
                .await?;
        if let Err(error) = crate::canonical_sessions::sync_desktop_chat_state(&state) {
            eprintln!("Unable to sync desktop chat into canonical sessions: {error}");
        }
        return Ok(state);
    }

    let active_runtime = {
        let mut sessions = manager.sessions.lock().await;

        if !sessions.contains_key(&active_session_id) {
            let runtime = resume_desktop_runtime(cwd, &active_session_id).await?;
            sessions.insert(
                active_session_id.clone(),
                Arc::new(tokio::sync::Mutex::new(runtime)),
            );
        }

        sessions
            .get(&active_session_id)
            .cloned()
            .ok_or_else(|| "Active session is unavailable".to_string())?
    };

    let (active_session, local_agent, slash_commands) = {
        let active_runtime = active_runtime.lock().await;
        (
            active_runtime.detail().map_err(|err| err.to_string())?,
            active_runtime.agent_profile(),
            active_runtime.slash_commands(),
        )
    };

    let mut summaries = persisted;
    let active_exists = summaries
        .iter()
        .any(|session| session.id == active_session_id);
    if !active_exists
        && active_session.project.is_none()
        && !is_internal_runtime_session_id(&active_session_id)
    {
        let active_runtime = active_runtime.lock().await;
        let summary = active_runtime.summary().map_err(|err| err.to_string())?;
        if !is_blank_draft_summary(&summary) {
            summaries.insert(0, summary);
        }
    }

    let session_handles = {
        let sessions = manager.sessions.lock().await;
        sessions
            .iter()
            .map(|(session_id, runtime)| (session_id.clone(), runtime.clone()))
            .collect::<Vec<_>>()
    };

    for (session_id, runtime) in session_handles {
        if is_internal_runtime_session_id(&session_id)
            || summaries.iter().any(|session| session.id == session_id)
        {
            continue;
        }
        let runtime = runtime.lock().await;
        let detail = runtime.detail().map_err(|err| err.to_string())?;
        if detail.project.is_some() {
            continue;
        }
        let summary = runtime.summary().map_err(|err| err.to_string())?;
        if !is_blank_draft_summary(&summary) {
            summaries.push(summary);
        }
    }

    let state = DesktopChatState {
        cwd: cwd.display().to_string(),
        active_session_id,
        sessions: summaries,
        projects,
        active_session,
        local_agent,
        model_options,
        slash_commands,
    };
    let active_is_canonical_group =
        crate::canonical_sessions::canonical_session_is_group_chat(&state.active_session_id)
            .unwrap_or(false);
    let sync_state = desktop_state_for_canonical_sync(
        &state,
        session_has_running_turn(manager, &state.active_session_id).await,
    );
    if !is_internal_runtime_session_id(&state.active_session_id) && !active_is_canonical_group {
        if let Err(error) = crate::canonical_sessions::sync_desktop_chat_state(&sync_state) {
            eprintln!("Unable to sync desktop chat into canonical sessions: {error}");
        }
    }
    Ok(state)
}
