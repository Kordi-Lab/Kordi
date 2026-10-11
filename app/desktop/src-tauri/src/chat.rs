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
pub(crate) mod agent_identity;
pub(crate) mod agent_prompt_runner;
pub(crate) mod artifacts;
pub(crate) mod attachments;
pub(crate) mod background_tasks;
pub(crate) mod canonical_sync;
mod hosted_provider_auth;
pub(crate) mod memory;
mod message_execution;
pub(crate) mod message_route;
pub(crate) mod model_options;
mod models;
pub(crate) mod project_actions;
pub(crate) mod session_actions;
mod session_commands;
mod session_lifecycle;
pub(crate) mod tool_approval;
pub use session_commands::*;
pub(crate) mod session_observation;
pub(crate) mod session_preparation;
mod transient_drafts;
pub(crate) mod turns;

#[cfg(test)]
use agent_identity::normalized_agent_name;
#[cfg(test)]
use session_lifecycle::is_missing_session_error;

pub(crate) use attachments::allow_attachment_asset_scope;

pub(crate) use models::DesktopStoredChatAttachment;
pub use models::{
    DesktopArtifactDirectory, DesktopArtifactDirectoryEntry, DesktopBackgroundFollowUp,
    DesktopChatArtifactPreview, DesktopChatArtifactPreviewLine, DesktopChatForkSessionResult,
    DesktopChatMessageRoute, DesktopChatState, DesktopChatToolSnapshot, DesktopChatTurnSnapshot,
};

pub(crate) use agent_prompt_runner::{run_agent_prompt, DesktopAgentModelRouting};
pub(super) use session_preparation::agent_session_cwd;

pub(super) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

mod cloud_scheduled_runtime;
use cloud_scheduled_runtime::{
    attach_cloud_scheduled_task_runtime, attach_cloud_scheduled_task_runtime_for_session,
};

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
    apply_desktop_turn_event, cancel_turn_by_id, desktop_task_tools_from_messages,
    reserve_turn_in_session, session_has_running_turn, snapshot_turn, turn_snapshot_by_id,
    turn_snapshot_has_model_task_tools, update_turn,
};

#[cfg(test)]
use turns::{
    active_turn_snapshots, is_auto_compaction_failure_status, is_auto_compaction_success_status,
};

type DesktopSessionHandle = Arc<tokio::sync::Mutex<DesktopRuntimeSession>>;

#[derive(Clone)]
struct DesktopChatTurnHandle {
    snapshot: Arc<Mutex<DesktopChatTurnSnapshot>>,
    cancel: tokio_util::sync::CancellationToken,
    execution_lease_deadline: Arc<Mutex<Option<std::time::Instant>>>,
}

#[derive(Clone, Default)]
pub struct DesktopChatManager {
    sessions: Arc<tokio::sync::Mutex<HashMap<String, DesktopSessionHandle>>>,
    turns: Arc<tokio::sync::Mutex<HashMap<String, DesktopChatTurnHandle>>>,
    session_turn_tails:
        Arc<tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Receiver<()>>>>,
    background_turn_ids: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
    shared_request_ids: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
    background_follow_up_ids: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
}

impl DesktopChatManager {
    pub(crate) async fn reload_skill_resources(&self) -> Result<(), String> {
        session_lifecycle::reload_skill_resources(self).await
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
    let session_handle = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let (provider, model) = {
        let mut session = session_handle.lock().await;
        if !agent_builder::is_agent_builder_session_id(&target_session_id) {
            attach_cloud_scheduled_task_runtime(&mut session);
            prepare_desktop_session_for_send(
                manager.inner(),
                &mut session,
                cwd.clone(),
                &text,
                (None, None),
                None,
                &[],
                (None, None),
            )
            .await?;
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
    request_message_id: Option<String>,
    execution_lease_deadline_ms: Option<i64>,
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
            sync_session_at_start: false,
            shared_context: false,
            request_message_id,
            execution_lease_deadline_ms,
            inherited_hosted_auth: None,
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
    cancel_turn_by_id(manager.inner(), &turn_id).await
}

#[tauri::command]
pub async fn desktop_chat_turn_state(
    manager: State<'_, DesktopChatManager>,
    turn_id: String,
) -> Result<DesktopChatTurnSnapshot, String> {
    turn_snapshot_by_id(manager.inner(), &turn_id).await
}

#[cfg(test)]
mod tests;
