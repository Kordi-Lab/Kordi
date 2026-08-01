use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::State;

#[cfg(test)]
use kordi_cli::desktop_runtime::DesktopChatSessionSummary;
use kordi_cli::desktop_runtime::{
    DesktopChatContextMessage, DesktopChatSessionDetail, DesktopRuntimeSession,
    DesktopVisibleTaskRecord,
};

pub(crate) mod agent_builder;
pub(crate) mod agent_prompt_runner;
pub(crate) mod artifacts;
pub(crate) mod attachments;
pub(crate) mod canonical_sync;
mod message_execution;
pub(crate) mod message_route;
pub(crate) mod model_options;
mod models;
pub(crate) mod session_actions;
mod session_lifecycle;
pub(crate) mod session_observation;
pub(crate) mod session_preparation;
mod transient_drafts;
pub(crate) mod turns;

pub(crate) use attachments::allow_attachment_asset_scope;

pub(crate) use models::DesktopStoredChatAttachment;
pub use models::{
    DesktopArtifactDirectory, DesktopArtifactDirectoryEntry, DesktopChatArtifactPreview,
    DesktopChatArtifactPreviewLine, DesktopChatForkSessionResult, DesktopChatMessageRoute,
    DesktopChatState, DesktopChatToolSnapshot, DesktopChatTurnSnapshot,
};

pub(crate) use agent_prompt_runner::{run_agent_prompt, DesktopAgentModelRouting};
pub(super) use session_preparation::agent_session_cwd;

pub(super) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn attach_cloud_scheduled_task_runtime(runtime: &mut DesktopRuntimeSession) {
    attach_cloud_scheduled_task_runtime_for_session(runtime, None);
}

fn attach_cloud_scheduled_task_runtime_for_session(
    runtime: &mut DesktopRuntimeSession,
    session_id: Option<&str>,
) {
    match crate::cloud_session::cloud_session_load() {
        Ok(Some(session)) if !session.token.trim().is_empty() => {
            let api_base = match crate::cloud_api_base_url_from_env() {
                Ok(value) => value,
                Err(err) => {
                    eprintln!(
                        "Unable to attach Cloud scheduled task runtime because the API base is unsafe: {err}"
                    );
                    return;
                }
            };
            if let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) {
                runtime.set_scheduled_tasks_cloud_runtime_for_session(
                    api_base,
                    session.token,
                    session_id.to_string(),
                );
            } else {
                runtime.set_scheduled_tasks_cloud_runtime(api_base, session.token);
            }
        }
        Ok(_) => {}
        Err(err) => eprintln!("Unable to load Cloud session for scheduled task runtime: {err}"),
    }
}

use canonical_sync::sync_completed_desktop_session_to_canonical;
use message_route::apply_desktop_chat_message_route;
use model_options::ensure_provider_ready_for_send;
pub(super) use session_actions::expand_home_project_path;
use session_actions::{
    resolve_existing_session_action_target, resolve_project_root_input,
    resolve_session_action_fallback_target,
};
use session_lifecycle::{
    build_chat_state, ensure_loaded_or_create_explicit_session, ensure_loaded_session,
    session_exists_globally,
};
use session_preparation::prepare_desktop_session_for_send;
use transient_drafts::{
    ensure_transient_draft_runtime, is_blank_draft_summary, materialize_transient_draft_runtime,
    TRANSIENT_LOCAL_DRAFT_SESSION_ID,
};

use turns::{
    apply_desktop_turn_event, desktop_task_tools_from_messages, prune_finished_turns,
    session_has_running_turn, snapshot_turn, turn_snapshot_has_model_task_tools, update_turn,
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

impl DesktopChatManager {
    pub(crate) async fn reload_skill_resources(&self) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .await
            .iter()
            .filter(|(session_id, _)| !agent_builder::is_agent_builder_session_id(session_id))
            .map(|(_, session)| session.clone())
            .collect::<Vec<_>>();
        let mut errors = Vec::new();
        for session in sessions {
            if let Err(error) = session.lock().await.reload_resources().await {
                errors.push(error.to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Skills were updated, but {} open session{} could not reload: {}",
                errors.len(),
                if errors.len() == 1 { "" } else { "s" },
                errors.join("; ")
            ))
        }
    }
}

fn chat_cwd() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn desktop_shape_agent_draft(
    manager: State<'_, DesktopChatManager>,
    prompt: String,
    route: DesktopAgentModelRouting,
) -> Result<DesktopChatTurnSnapshot, String> {
    run_agent_prompt(
        manager.inner(),
        "shape-agent-creator",
        "shape-agent-draft",
        prompt,
        Vec::new(),
        Some(route),
    )
    .await
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
pub async fn desktop_chat_session_detail(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
) -> Result<DesktopChatSessionDetail, String> {
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
    let session = session.lock().await;
    session.detail().map_err(|err| err.to_string())
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
    attach_cloud_scheduled_task_runtime(&mut runtime);
    runtime
        .materialize_session()
        .map_err(|err| err.to_string())?;
    if let Some(title) = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        runtime
            .set_auto_name(title)
            .map_err(|err| err.to_string())?;
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
    let target_session_id =
        ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id).await?;
    if agent_builder::is_agent_builder_session_id(&target_session_id) {
        return Err(
            "Agent Builder uses the authenticated runtime default and a fixed safety profile."
                .to_string(),
        );
    }
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
    if target_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        if let Some(model) = model.as_deref() {
            session.set_model(model).map_err(|err| err.to_string())?;
        }
        if let Some(thinking) = thinking.as_deref() {
            session
                .set_thinking(thinking)
                .map_err(|err| err.to_string())?;
        }
    } else {
        session
            .set_explicit_config(model.as_deref(), thinking.as_deref())
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
    if agent_builder::is_agent_builder_session_id(session_id.trim()) {
        return Err("Discard Agent Builder drafts from Agent Studio.".to_string());
    }
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
    if agent_builder::is_agent_builder_session_id(session_id.trim()) {
        return Err("Discard Agent Builder drafts from Agent Studio.".to_string());
    }
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
    if agent_builder::is_agent_builder_session_id(session_id.trim()) {
        return Err("Agent Builder conversations stay with their private draft.".to_string());
    }
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
pub async fn desktop_chat_fork_session_from_message(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    message_entry_id: String,
) -> Result<DesktopChatForkSessionResult, String> {
    let trimmed_session_id = session_id.trim();
    let trimmed_entry_id = message_entry_id.trim();
    if trimmed_session_id.is_empty() {
        return Err("Source session id is required".to_string());
    }
    if trimmed_entry_id.is_empty() {
        return Err("Source message id is required".to_string());
    }
    if trimmed_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        return Err("Save the draft session before forking from it.".to_string());
    }
    if agent_builder::is_agent_builder_session_id(trimmed_session_id) {
        return Err("Agent Builder conversations cannot be forked.".to_string());
    }

    let cwd = chat_cwd()?;
    // Route by where the clicked entry actually lives. We can't infer
    // this from the session id alone: for hosted sessions the local
    // kordi_session store mirrors self-agent chats into the canonical
    // `session_messages` table for sync, so a plain-uuid session id
    // can still surface canonical-format message ids in the
    // transcript. The old `starts_with("session:")` heuristic only
    // matched canonical group/bridge ids and silently routed those
    // mirrored sessions through the local fork path, where the
    // canonical `msg:*` entry id is never present and the operation
    // failed with "Entry not found".
    let canonical_message_id = crate::canonical_sessions::canonical_session_message_id_for_entry(
        trimmed_session_id,
        trimmed_entry_id,
    )?;
    let canonical_entry_match = canonical_message_id.is_some();
    let source_is_canonical_group = canonical_entry_match
        && crate::canonical_sessions::canonical_session_is_group_chat(trimmed_session_id)?;
    let local_session_exists =
        !canonical_entry_match && session_exists_globally(trimmed_session_id)?;
    if !canonical_entry_match && !local_session_exists {
        return Err(format!("Session not found: {trimmed_session_id}"));
    }

    // Canonical-rooted entries (group / bridge / direct-agent and
    // cloud-mirrored self-agent chats) snapshot through the canonical
    // path. Purely-local sessions without canonical mirroring use the
    // kordi_session fork-from-entry path. Both produce a local fork
    // the user continues from.
    let outcome = if canonical_entry_match {
        crate::canonical_sessions::fork_canonical_session_into_local_chat(
            trimmed_session_id,
            canonical_message_id
                .as_deref()
                .expect("canonical entry match always has a canonical message id"),
            Some(trimmed_entry_id),
            &cwd.display().to_string(),
        )?
    } else {
        kordi_cli::desktop_runtime::fork_session_from_message(trimmed_session_id, trimmed_entry_id)
            .map_err(|err| err.to_string())?
    };

    if source_is_canonical_group {
        // Cloud/contact/group forks are canonical Cloud sessions. Do not create
        // or resume a localhost desktop runtime for the fork id; doing so mirrors
        // the fork back as a self-agent session, creates fake Processing rows,
        // and prevents peers from seeing the Cloud fork lineage consistently.
        let fallback_session_id = ensure_loaded_session(&manager, &cwd, None).await?;
        let state = build_chat_state(&manager, &cwd, fallback_session_id).await?;
        return Ok(DesktopChatForkSessionResult {
            state,
            forked_session_id: outcome.session_id,
            source_session_id: outcome.source_session_id,
            source_message_id: outcome.source_entry_id,
            selected_text: outcome.selected_text,
            canonical_only: true,
        });
    }

    let mut runtime = kordi_cli::desktop_runtime::DesktopRuntimeSession::resume(
        std::path::PathBuf::from(&outcome.cwd),
        &outcome.session_id,
    )
    .await
    .map_err(|err| err.to_string())?;
    attach_cloud_scheduled_task_runtime(&mut runtime);

    {
        let mut sessions = manager.sessions.lock().await;
        sessions.insert(
            outcome.session_id.clone(),
            Arc::new(tokio::sync::Mutex::new(runtime)),
        );
    }

    let state = build_chat_state(&manager, &cwd, outcome.session_id.clone()).await?;
    Ok(DesktopChatForkSessionResult {
        state,
        forked_session_id: outcome.session_id,
        source_session_id: outcome.source_session_id,
        source_message_id: outcome.source_entry_id,
        selected_text: outcome.selected_text,
        canonical_only: false,
    })
}

#[tauri::command]
pub async fn desktop_chat_send_message(
    manager: State<'_, DesktopChatManager>,
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
        if !agent_builder::is_agent_builder_session_id(&target_session_id) {
            attach_cloud_scheduled_task_runtime(&mut session);
            prepare_desktop_session_for_send(&mut session, cwd.clone(), &text).await;
        }
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
#[allow(clippy::too_many_arguments, reason = "stable top-level Tauri IPC keys")]
pub async fn desktop_chat_start_message(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    text: String,
    attachment_paths: Option<Vec<String>>,
    route: Option<DesktopChatMessageRoute>,
    context_messages: Option<Vec<DesktopChatContextMessage>>,
    visible_task_records: Option<Vec<DesktopVisibleTaskRecord>>,
    scheduled_task_session_id: Option<String>,
) -> Result<DesktopChatTurnSnapshot, String> {
    message_execution::start_message(
        manager.inner(),
        message_execution::StartMessageInput {
            session_id,
            text,
            attachment_paths,
            route,
            context_messages,
            visible_task_records,
            scheduled_task_session_id,
        },
    )
    .await
}

#[tauri::command]
pub async fn desktop_chat_run_skill_command(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    text: String,
) -> Result<String, String> {
    let cwd = chat_cwd()?;
    let target_session_id = ensure_loaded_session(&manager, &cwd, Some(session_id)).await?;
    if agent_builder::is_agent_builder_session_id(&target_session_id) {
        return Err("Agent Builder skills are managed by its fixed safety profile.".to_string());
    }
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
            state.status = "cancelling".to_string();
            state.message = "Stopping…".to_string();
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
