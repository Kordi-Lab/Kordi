use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bridge::DesktopBridgeManager;
use kordi_cli::desktop_runtime::{
    DesktopChatAgentProfile, DesktopChatModelOption, DesktopChatProjectGroup,
    DesktopChatSessionDetail, DesktopChatSessionSummary, DesktopChatSlashCommand,
    DesktopRuntimeSession,
};

pub(crate) mod artifacts;
pub(crate) mod attachments;
pub(crate) mod bridge_agent_runner;
pub(crate) mod bridge_outreach;
pub(crate) mod canonical_sync;
pub(crate) mod message_route;
pub(crate) mod model_options;
pub(crate) mod session_actions;
pub(crate) mod turns;

pub(crate) use attachments::{
    allow_attachment_asset_scope, store_chat_attachment_bytes, stored_chat_attachment_from_path,
};

pub(crate) use bridge_agent_runner::{run_bridge_agent_prompt, DesktopBridgeAgentModelRouting};
pub(super) use bridge_outreach::bridge_agent_session_cwd;

use bridge_outreach::prepare_desktop_session_for_send;
use canonical_sync::{
    desktop_state_for_canonical_sync, sync_completed_desktop_session_to_canonical,
};
use message_route::apply_desktop_chat_message_route;
use model_options::{
    authenticated_model_options_with_local_runtime, ensure_provider_ready_for_send,
};
pub(super) use session_actions::expand_home_project_path;
use session_actions::{
    resolve_existing_session_action_target, resolve_project_root_input,
    resolve_session_action_fallback_target,
};

use turns::{
    apply_desktop_turn_event, prune_finished_turns, session_has_running_turn, snapshot_turn,
    update_turn,
};

#[cfg(test)]
use turns::{is_auto_compaction_failure_status, is_auto_compaction_success_status};

type DesktopSessionHandle = Arc<tokio::sync::Mutex<DesktopRuntimeSession>>;

#[derive(Clone)]
struct DesktopChatTurnHandle {
    snapshot: Arc<Mutex<DesktopChatTurnSnapshot>>,
    cancel: tokio_util::sync::CancellationToken,
}

#[derive(Clone, Default)]
pub struct DesktopChatManager {
    sessions: Arc<tokio::sync::Mutex<HashMap<String, DesktopSessionHandle>>>,
    turns: Arc<tokio::sync::Mutex<HashMap<String, DesktopChatTurnHandle>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopStoredChatAttachment {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub mime_type: Option<String>,
    pub format_label: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatState {
    pub cwd: String,
    pub active_session_id: String,
    pub sessions: Vec<DesktopChatSessionSummary>,
    pub projects: Vec<DesktopChatProjectGroup>,
    pub active_session: DesktopChatSessionDetail,
    pub local_agent: DesktopChatAgentProfile,
    pub model_options: Vec<DesktopChatModelOption>,
    pub slash_commands: Vec<DesktopChatSlashCommand>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatToolSnapshot {
    pub id: String,
    pub name: String,
    pub status: String,
    pub arguments: String,
    pub live_output: String,
    pub result_text: Option<String>,
    pub detail: Option<String>,
    pub artifact_path: Option<String>,
    pub is_error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatTurnSnapshot {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub status: String,
    pub message: String,
    pub assistant_text: String,
    pub thinking_text: String,
    pub tools: Vec<DesktopChatToolSnapshot>,
    pub completed: bool,
    pub succeeded: bool,
    pub error: Option<String>,
    pub transcript_refresh_required: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatMessageRoute {
    pub model: Option<String>,
    pub auth_provider: Option<String>,
    pub auth_choice: Option<String>,
    pub thinking: Option<String>,
}

const TRANSIENT_LOCAL_DRAFT_SESSION_ID: &str = "draft:local-chat";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatArtifactPreviewLine {
    pub number: usize,
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatArtifactPreview {
    pub path: String,
    pub lines: Vec<DesktopChatArtifactPreviewLine>,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopArtifactDirectoryEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_directory: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopArtifactDirectory {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<DesktopArtifactDirectoryEntry>,
}

fn chat_cwd() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|err| err.to_string())
}

fn session_exists_globally(session_id: &str) -> Result<bool, String> {
    kordi_cli::desktop_runtime::session_exists(session_id).map_err(|err| err.to_string())
}

fn is_placeholder_session_title(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed.is_empty() || trimmed.eq_ignore_ascii_case("New session") || trimmed == "Session"
}

fn is_blank_draft_summary(summary: &DesktopChatSessionSummary) -> bool {
    summary.message_count == 0 && (summary.draft || is_placeholder_session_title(&summary.title))
}

fn filter_blank_draft_projects(
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

async fn ensure_transient_draft_runtime(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
) -> Result<DesktopSessionHandle, String> {
    {
        let sessions = manager.sessions.lock().await;
        if let Some(handle) = sessions.get(TRANSIENT_LOCAL_DRAFT_SESSION_ID).cloned() {
            return Ok(handle);
        }
    }

    let runtime = DesktopRuntimeSession::create_new(cwd.to_path_buf())
        .await
        .map_err(|err| err.to_string())?;
    let handle = Arc::new(tokio::sync::Mutex::new(runtime));
    let mut sessions = manager.sessions.lock().await;
    Ok(sessions
        .entry(TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string())
        .or_insert_with(|| handle.clone())
        .clone())
}

async fn materialize_transient_draft_runtime(
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

async fn build_transient_draft_chat_state(
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

async fn ensure_loaded_session(
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
            let runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), &session_id)
                .await
                .map_err(|err| err.to_string())?;
            sessions.insert(
                session_id.clone(),
                Arc::new(tokio::sync::Mutex::new(runtime)),
            );
            return Ok(session_id);
        }
    }

    if let Some(session_id) = persisted.first().map(|session| session.id.clone()) {
        if !sessions.contains_key(&session_id) {
            let runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), &session_id)
                .await
                .map_err(|err| err.to_string())?;
            sessions.insert(
                session_id.clone(),
                Arc::new(tokio::sync::Mutex::new(runtime)),
            );
        }
        return Ok(session_id);
    }

    Ok(TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string())
}

async fn ensure_loaded_or_create_explicit_session(
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
    let runtime = if persisted.iter().any(|session| session.id == session_id)
        || session_exists_globally(&session_id)?
    {
        DesktopRuntimeSession::resume(cwd.to_path_buf(), &session_id)
            .await
            .map_err(|err| err.to_string())?
    } else {
        DesktopRuntimeSession::create_with_id(cwd.to_path_buf(), &session_id)
            .await
            .map_err(|err| err.to_string())?
    };

    let mut sessions = manager.sessions.lock().await;
    sessions.insert(
        session_id.clone(),
        Arc::new(tokio::sync::Mutex::new(runtime)),
    );
    Ok(session_id)
}

async fn build_chat_state(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    active_session_id: String,
) -> Result<DesktopChatState, String> {
    let persisted = kordi_cli::desktop_runtime::list_session_summaries(cwd)
        .map_err(|err| err.to_string())?
        .into_iter()
        .filter(|session| !is_blank_draft_summary(session))
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
            let runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), &active_session_id)
                .await
                .map_err(|err| err.to_string())?;
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
    if !active_exists && active_session.project.is_none() {
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
        if summaries.iter().any(|session| session.id == session_id) {
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
    let sync_state = desktop_state_for_canonical_sync(
        &state,
        session_has_running_turn(manager, &state.active_session_id).await,
    );
    if let Err(error) = crate::canonical_sessions::sync_desktop_chat_state(&sync_state) {
        eprintln!("Unable to sync desktop chat into canonical sessions: {error}");
    }
    Ok(state)
}

#[tauri::command]
pub async fn desktop_chat_state(
    manager: State<'_, DesktopChatManager>,
    active_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let active_session_id = ensure_loaded_session(&manager, &cwd, active_session_id).await?;
    build_chat_state(&manager, &cwd, active_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_new_session(
    manager: State<'_, DesktopChatManager>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let session_id = materialize_transient_draft_runtime(&manager, &cwd).await?;
    build_chat_state(&manager, &cwd, session_id).await
}

#[tauri::command]
pub async fn desktop_chat_new_project_session(
    manager: State<'_, DesktopChatManager>,
    project_root: String,
    title: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let resolved_project_root = resolve_project_root_input(&cwd, &project_root)?;
    kordi_cli::desktop_runtime::register_project(&resolved_project_root, None)
        .map_err(|err| err.to_string())?;

    let mut runtime = DesktopRuntimeSession::create_new(resolved_project_root.clone())
        .await
        .map_err(|err| err.to_string())?;
    runtime
        .materialize_session()
        .map_err(|err| err.to_string())?;
    if let Some(title) = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        runtime.set_name(title).map_err(|err| err.to_string())?;
    }
    let session_id = runtime.session_id().to_string();
    kordi_cli::desktop_runtime::move_session_to_project(&session_id, &resolved_project_root)
        .map_err(|err| err.to_string())?;

    {
        let mut sessions = manager.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            Arc::new(tokio::sync::Mutex::new(runtime)),
        );
    }

    build_chat_state(&manager, &cwd, session_id).await
}

#[tauri::command]
pub async fn desktop_chat_prepare_draft_session(
    manager: State<'_, DesktopChatManager>,
) -> Result<(), String> {
    let cwd = chat_cwd()?;
    ensure_transient_draft_runtime(&manager, &cwd).await?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_chat_update_session_config(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    model: Option<String>,
    thinking: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target_session_id = if session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string()
    } else {
        ensure_loaded_session(&manager, &cwd, Some(session_id)).await?
    };
    if target_session_id != TRANSIENT_LOCAL_DRAFT_SESSION_ID
        && session_has_running_turn(&manager, &target_session_id).await
    {
        return Err(
            "Stop the running task before changing this session's model or thinking level."
                .to_string(),
        );
    }
    let session = if target_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        ensure_transient_draft_runtime(&manager, &cwd).await?
    } else {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let mut session = session.lock().await;

    if let Some(model) = model.as_deref() {
        session.set_model(model).map_err(|err| err.to_string())?;
    }
    if let Some(thinking) = thinking.as_deref() {
        session
            .set_thinking(thinking)
            .map_err(|err| err.to_string())?;
    }
    drop(session);

    build_chat_state(&manager, &cwd, target_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_rename_session(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    name: String,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target_session_id = ensure_loaded_session(&manager, &cwd, Some(session_id)).await?;
    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let mut session = session.lock().await;
    session.set_name(&name).map_err(|err| err.to_string())?;
    drop(session);

    build_chat_state(&manager, &cwd, target_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_archive_session(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    active_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before hiding this session.".to_string());
    }

    if target.local_exists {
        kordi_cli::desktop_runtime::hide_session(&target.id).map_err(|err| err.to_string())?;
    }
    manager.sessions.lock().await.remove(&target.id);
    if target.canonical_exists {
        crate::canonical_sessions::archive_session(&target.id)?;
    }

    let fallback_active_session_id = if active_session_id.as_deref() == Some(target.id.as_str()) {
        None
    } else {
        active_session_id
    };
    let next_active_session_id =
        resolve_session_action_fallback_target(&cwd, fallback_active_session_id)?;
    build_chat_state(&manager, &cwd, next_active_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_delete_session_forever(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    active_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before deleting this session.".to_string());
    }

    {
        let mut turns = manager.turns.lock().await;
        turns.retain(|_, turn| {
            turn.snapshot
                .lock()
                .map(|snapshot| snapshot.session_id != target.id)
                .unwrap_or(true)
        });
    }
    manager.sessions.lock().await.remove(&target.id);

    if target.local_exists {
        kordi_cli::desktop_runtime::delete_session_forever(&target.id)
            .map_err(|err| err.to_string())?;
    }
    if target.canonical_exists {
        crate::canonical_sessions::delete_session(&target.id)?;
    }

    let fallback_active_session_id = if active_session_id.as_deref() == Some(target.id.as_str()) {
        None
    } else {
        active_session_id
    };
    let next_active_session_id =
        resolve_session_action_fallback_target(&cwd, fallback_active_session_id)?;
    build_chat_state(&manager, &cwd, next_active_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_move_session_to_project(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    project_root: String,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before moving this session.".to_string());
    }
    if !target.local_exists {
        return Err("Only local chat sessions can be moved to a project.".to_string());
    }

    let resolved_project_root = resolve_project_root_input(&cwd, &project_root)?;
    kordi_cli::desktop_runtime::register_project(&resolved_project_root, None)
        .map_err(|err| err.to_string())?;
    manager.sessions.lock().await.remove(&target.id);
    kordi_cli::desktop_runtime::move_session_to_project(&target.id, &resolved_project_root)
        .map_err(|err| err.to_string())?;
    build_chat_state(&manager, &cwd, target.id).await
}

#[tauri::command]
pub async fn desktop_chat_send_message(
    manager: State<'_, DesktopChatManager>,
    bridge_manager: State<'_, DesktopBridgeManager>,
    session_id: String,
    text: String,
) -> Result<DesktopChatState, String> {
    if text.trim().is_empty() {
        return Err("Message is empty".to_string());
    }

    let cwd = chat_cwd()?;
    let target_session_id =
        ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id).await?;
    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let session_handle = session;
    let (provider, model) = {
        let mut session = session_handle.lock().await;
        prepare_desktop_session_for_send(
            &mut session,
            bridge_manager.inner().clone(),
            manager.inner().clone(),
            cwd.clone(),
            &text,
        )
        .await;
        let detail = session.detail().map_err(|err| err.to_string())?;
        (detail.provider, detail.model)
    };
    ensure_provider_ready_for_send(&provider, &model, &cwd).await?;

    let turn = {
        let mut session = session_handle.lock().await;
        session
            .begin_message_streaming(text, Vec::new(), tokio_util::sync::CancellationToken::new())
            .await
            .map_err(|err| err.to_string())?
    };

    let result = turn.run(|_| {}).await.map_err(|err| err.to_string())?;
    {
        let mut session = session_handle.lock().await;
        session
            .finish_message_streaming(result)
            .map_err(|err| err.to_string())?;
    }

    build_chat_state(&manager, &cwd, target_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_start_message(
    manager: State<'_, DesktopChatManager>,
    bridge_manager: State<'_, DesktopBridgeManager>,
    session_id: String,
    text: String,
    attachment_paths: Option<Vec<String>>,
    route: Option<DesktopChatMessageRoute>,
) -> Result<DesktopChatTurnSnapshot, String> {
    let attachment_paths = attachment_paths.unwrap_or_default();
    if text.trim().is_empty() && attachment_paths.is_empty() {
        return Err("Message is empty".to_string());
    }

    let cwd = chat_cwd()?;
    let target_session_id =
        ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id).await?;
    prune_finished_turns(&manager).await;
    if session_has_running_turn(&manager, &target_session_id).await {
        return Err(
            "This session already has a running task. Open another session to work concurrently."
                .to_string(),
        );
    }
    let turn_id = uuid::Uuid::new_v4().to_string();
    let snapshot = Arc::new(Mutex::new(DesktopChatTurnSnapshot {
        id: turn_id.clone(),
        session_id: target_session_id.clone(),
        prompt: text.trim().to_string(),
        status: "starting".to_string(),
        message: "Working…".to_string(),
        assistant_text: String::new(),
        thinking_text: String::new(),
        tools: Vec::new(),
        completed: false,
        succeeded: false,
        error: None,
        transcript_refresh_required: false,
    }));

    let cancel = tokio_util::sync::CancellationToken::new();

    {
        let mut turns = manager.turns.lock().await;
        turns.insert(
            turn_id.clone(),
            DesktopChatTurnHandle {
                snapshot: snapshot.clone(),
                cancel: cancel.clone(),
            },
        );
    }

    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };

    let snapshot_for_task = snapshot.clone();
    let bridge_manager_for_task = bridge_manager.inner().clone();
    let chat_manager_for_task = manager.inner().clone();
    let session_handle = session;
    tokio::spawn(async move {
        let (provider, model) = {
            let mut session = session_handle.lock().await;
            if let Err(error) = apply_desktop_chat_message_route(&mut session, route.as_ref()) {
                update_turn(&snapshot_for_task, |state| {
                    state.status = "failed".to_string();
                    state.message = error.clone();
                    state.completed = true;
                    state.succeeded = false;
                    state.error = Some(error);
                });
                return;
            }
            prepare_desktop_session_for_send(
                &mut session,
                bridge_manager_for_task,
                chat_manager_for_task,
                cwd.clone(),
                &text,
            )
            .await;

            let detail = session.detail().ok();
            let provider = detail
                .as_ref()
                .map(|detail| detail.provider.clone())
                .unwrap_or_default();
            let model = detail
                .as_ref()
                .map(|detail| detail.model.clone())
                .unwrap_or_default();
            (provider, model)
        };

        if let Err(error) = ensure_provider_ready_for_send(&provider, &model, &cwd).await {
            update_turn(&snapshot_for_task, |state| {
                state.status = "failed".to_string();
                state.message = error.clone();
                state.completed = true;
                state.succeeded = false;
                state.error = Some(error);
            });
            return;
        }

        let mut session = session_handle.lock().await;
        let turn = match session
            .begin_message_streaming(text, attachment_paths, cancel.clone())
            .await
        {
            Ok(turn) => turn,
            Err(err) => {
                update_turn(&snapshot_for_task, |state| {
                    state.status = "failed".to_string();
                    state.message = "Chat request failed".to_string();
                    state.completed = true;
                    state.succeeded = false;
                    state.error = Some(err.to_string());
                });
                return;
            }
        };
        drop(session);

        let turn_result = turn
            .run(|event| apply_desktop_turn_event(&snapshot_for_task, event))
            .await;
        let result = match turn_result {
            Ok(turn_result) => {
                let mut session = session_handle.lock().await;
                session.finish_message_streaming(turn_result)
            }
            Err(err) => Err(err),
        };

        match result {
            Ok(_) if cancel.is_cancelled() => {
                sync_completed_desktop_session_to_canonical(
                    &cwd,
                    &target_session_id,
                    &session_handle,
                )
                .await;
                update_turn(&snapshot_for_task, |state| {
                    state.status = "cancelled".to_string();
                    state.message = "Response stopped".to_string();
                    state.completed = true;
                    state.succeeded = false;
                    state.error = None;
                });
            }
            Ok(_) => {
                sync_completed_desktop_session_to_canonical(
                    &cwd,
                    &target_session_id,
                    &session_handle,
                )
                .await;
                update_turn(&snapshot_for_task, |state| {
                    state.status = "succeeded".to_string();
                    state.message = "Response complete".to_string();
                    state.completed = true;
                    state.succeeded = true;
                    state.error = None;
                });
            }
            Err(_err) if cancel.is_cancelled() => update_turn(&snapshot_for_task, |state| {
                state.status = "cancelled".to_string();
                state.message = "Response stopped".to_string();
                state.completed = true;
                state.succeeded = false;
                state.error = None;
            }),
            Err(err) => update_turn(&snapshot_for_task, |state| {
                state.status = "failed".to_string();
                state.message = "Chat request failed".to_string();
                state.completed = true;
                state.succeeded = false;
                state.error = Some(err.to_string());
            }),
        }
    });

    snapshot_turn(&snapshot)
}

#[tauri::command]
pub async fn desktop_chat_run_skill_command(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    text: String,
) -> Result<String, String> {
    let cwd = chat_cwd()?;
    let target_session_id = ensure_loaded_session(&manager, &cwd, Some(session_id)).await?;
    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let mut session = session.lock().await;
    session
        .run_skill_command(&text)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Not a skill command".to_string())
}

#[tauri::command]
pub async fn desktop_chat_cancel_turn(
    manager: State<'_, DesktopChatManager>,
    turn_id: String,
) -> Result<DesktopChatTurnSnapshot, String> {
    let turns = manager.turns.lock().await;
    let turn = turns
        .get(&turn_id)
        .ok_or_else(|| format!("Unknown chat turn: {turn_id}"))?;
    turn.cancel.cancel();
    update_turn(&turn.snapshot, |state| {
        if !state.completed {
            state.status = "cancelled".to_string();
            state.message = "Response stopped".to_string();
            state.completed = true;
            state.succeeded = false;
            state.error = None;
        }
    });
    snapshot_turn(&turn.snapshot)
}

#[tauri::command]
pub async fn desktop_chat_turn_state(
    manager: State<'_, DesktopChatManager>,
    turn_id: String,
) -> Result<DesktopChatTurnSnapshot, String> {
    let turns = manager.turns.lock().await;
    let snapshot = turns
        .get(&turn_id)
        .ok_or_else(|| format!("Unknown chat turn: {turn_id}"))?;
    snapshot_turn(&snapshot.snapshot)
}

#[cfg(test)]
mod tests;
