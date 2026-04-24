use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use kordi_cli::desktop_runtime::{
    DesktopChatAgentProfile, DesktopChatModelOption, DesktopChatProjectGroup,
    DesktopChatSessionDetail, DesktopChatSessionSummary, DesktopChatSlashCommand,
    DesktopRuntimeSession,
};
use kordi_cli::turn_runner::TurnEvent;

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
}

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

fn chat_cwd() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|err| err.to_string())
}

fn attachment_storage_dir() -> Result<PathBuf, String> {
    let dir = std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .map(|path| path.join("tmp").join("attachments"))
        .unwrap_or_else(|| std::env::temp_dir().join("kordi-desktop-attachments"));
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn resolve_artifact_preview_path(raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Artifact path is required".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        Ok(candidate)
    } else {
        Ok(chat_cwd()?.join(candidate))
    }
}

fn snapshot_turn(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
) -> Result<DesktopChatTurnSnapshot, String> {
    snapshot
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "Chat turn state is unavailable".to_string())
}

fn update_turn(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    apply: impl FnOnce(&mut DesktopChatTurnSnapshot),
) {
    if let Ok(mut guard) = snapshot.lock() {
        apply(&mut guard);
    }
}

fn turn_matches_running_session(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    session_id: &str,
) -> bool {
    snapshot
        .lock()
        .map(|turn| turn.session_id == session_id && !turn.completed)
        .unwrap_or(false)
}

async fn prune_finished_turns(manager: &DesktopChatManager) {
    let mut turns = manager.turns.lock().await;
    turns.retain(|_, turn| {
        turn.snapshot
            .lock()
            .map(|snapshot| !snapshot.completed)
            .unwrap_or(false)
    });
}

async fn session_has_running_turn(manager: &DesktopChatManager, session_id: &str) -> bool {
    let turns = manager.turns.lock().await;
    turns
        .values()
        .any(|turn| turn_matches_running_session(&turn.snapshot, session_id))
}

fn content_blocks_to_text(content: &[kordi_core::types::ContentBlock]) -> String {
    let text = content
        .iter()
        .filter_map(|block| match block {
            kordi_core::types::ContentBlock::Text { text } => Some(text.as_str()),
            kordi_core::types::ContentBlock::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    if text.trim().is_empty() {
        "(no text output)".to_string()
    } else {
        text
    }
}

fn tool_detail(details: &Option<serde_json::Value>) -> Option<String> {
    let details = details.as_ref()?;
    let mut parts = Vec::new();
    if let Some(duration_ms) = details.get("durationMs").and_then(|value| value.as_u64()) {
        parts.push(format!("{}ms", duration_ms));
    }
    if let Some(exit_code) = details.get("exitCode").and_then(|value| value.as_i64()) {
        parts.push(format!("exit {exit_code}"));
    }
    if details
        .get("truncated")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        parts.push("truncated".to_string());
    }
    if details
        .get("cancelled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        parts.push("cancelled".to_string());
    }
    (!parts.is_empty()).then(|| parts.join(" • "))
}

fn session_exists_globally(session_id: &str) -> Result<bool, String> {
    kordi_cli::desktop_runtime::session_exists(session_id).map_err(|err| err.to_string())
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

    if let Some(session_id) = sessions.keys().next().cloned() {
        return Ok(session_id);
    }

    let runtime = DesktopRuntimeSession::create_new(cwd.to_path_buf())
        .await
        .map_err(|err| err.to_string())?;
    let session_id = runtime.session_id().to_string();
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
    let persisted =
        kordi_cli::desktop_runtime::list_session_summaries(cwd).map_err(|err| err.to_string())?;
    let model_options = kordi_cli::desktop_runtime::authenticated_model_options(cwd).await;
    let projects =
        kordi_cli::desktop_runtime::list_project_groups(cwd).map_err(|err| err.to_string())?;
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
    if !active_exists {
        let active_runtime = active_runtime.lock().await;
        summaries.insert(0, active_runtime.summary().map_err(|err| err.to_string())?);
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
        summaries.push(runtime.summary().map_err(|err| err.to_string())?);
    }

    Ok(DesktopChatState {
        cwd: cwd.display().to_string(),
        active_session_id,
        sessions: summaries,
        projects,
        active_session,
        local_agent,
        model_options,
        slash_commands,
    })
}

#[tauri::command]
pub async fn desktop_chat_store_attachment(name: String, data: Vec<u8>) -> Result<String, String> {
    let safe_name = std::path::Path::new(&name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment.bin");
    let stem = std::path::Path::new(safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment");
    let extension = std::path::Path::new(safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let path =
        attachment_storage_dir()?.join(format!("{}-{}{}", stem, uuid::Uuid::new_v4(), extension));
    std::fs::write(&path, data).map_err(|err| err.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn desktop_chat_artifact_preview(
    path: String,
) -> Result<DesktopChatArtifactPreview, String> {
    const MAX_PREVIEW_BYTES: usize = 64 * 1024;
    const MAX_PREVIEW_LINES: usize = 400;

    let resolved_path = resolve_artifact_preview_path(&path)?;
    let bytes = std::fs::read(&resolved_path).map_err(|err| err.to_string())?;
    let mut truncated = bytes.len() > MAX_PREVIEW_BYTES;
    let preview_bytes = if truncated {
        &bytes[..MAX_PREVIEW_BYTES]
    } else {
        bytes.as_slice()
    };
    let preview_text = String::from_utf8_lossy(preview_bytes).into_owned();

    if preview_text.contains('\u{0000}') {
        return Err(
            "This artifact looks like a binary file and can't be previewed here.".to_string(),
        );
    }

    let mut lines = Vec::new();
    if !preview_text.is_empty() {
        for (index, line) in preview_text.split('\n').enumerate() {
            if index >= MAX_PREVIEW_LINES {
                truncated = true;
                break;
            }

            lines.push(DesktopChatArtifactPreviewLine {
                number: index + 1,
                text: line.strip_suffix('\r').unwrap_or(line).to_string(),
            });
        }
    }

    Ok(DesktopChatArtifactPreview {
        path: resolved_path.display().to_string(),
        lines,
        truncated,
    })
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
    let runtime = DesktopRuntimeSession::create_new(cwd.clone())
        .await
        .map_err(|err| err.to_string())?;
    let session_id = runtime.session_id().to_string();
    manager.sessions.lock().await.insert(
        session_id.clone(),
        Arc::new(tokio::sync::Mutex::new(runtime)),
    );
    build_chat_state(&manager, &cwd, session_id).await
}

#[tauri::command]
pub async fn desktop_chat_update_session_config(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    model: Option<String>,
    thinking: Option<String>,
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

    if let Some(model) = model.as_deref() {
        session.set_model(model).map_err(|err| err.to_string())?;
    }
    if let Some(thinking) = thinking.as_deref() {
        session
            .set_thinking(thinking)
            .map_err(|err| err.to_string())?;
    }

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

    build_chat_state(&manager, &cwd, target_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_send_message(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    text: String,
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
    session
        .send_message(text, Vec::new())
        .await
        .map_err(|err| err.to_string())?;

    build_chat_state(&manager, &cwd, target_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_start_message(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    text: String,
    attachment_paths: Option<Vec<String>>,
) -> Result<DesktopChatTurnSnapshot, String> {
    let cwd = chat_cwd()?;
    let target_session_id = ensure_loaded_session(&manager, &cwd, Some(session_id)).await?;
    prune_finished_turns(&manager).await;
    if session_has_running_turn(&manager, &target_session_id).await {
        return Err(
            "This session already has a running task. Open another session to work concurrently."
                .to_string(),
        );
    }
    let attachment_paths = attachment_paths.unwrap_or_default();
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
    tokio::spawn(async move {
        let mut session = session.lock().await;

        let result =
            session
                .send_message_streaming(text, attachment_paths, cancel.clone(), |event| match event
                {
                    TurnEvent::TurnStart { .. } => update_turn(&snapshot_for_task, |state| {
                        state.status = "streaming".to_string();
                        state.message = "Working…".to_string();
                    }),
                    TurnEvent::TextDelta(text) => update_turn(&snapshot_for_task, |state| {
                        state.status = "writing".to_string();
                        state.message = "Writing response…".to_string();
                        state.assistant_text.push_str(text);
                    }),
                    TurnEvent::ThinkingDelta(text) => update_turn(&snapshot_for_task, |state| {
                        state.status = "thinking".to_string();
                        state.message = "Thinking…".to_string();
                        state.thinking_text.push_str(text);
                    }),
                    TurnEvent::ToolCallStart { id, name } => {
                        update_turn(&snapshot_for_task, |state| {
                            state.status = "tooling".to_string();
                            state.message = "Working…".to_string();
                            state.tools.push(DesktopChatToolSnapshot {
                                id: id.clone(),
                                name: name.clone(),
                                status: "preparing".to_string(),
                                arguments: String::new(),
                                live_output: String::new(),
                                result_text: None,
                                detail: None,
                                is_error: false,
                            });
                        })
                    }
                    TurnEvent::ToolCallDelta { id, args } => {
                        update_turn(&snapshot_for_task, |state| {
                            if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                                tool.arguments.push_str(args);
                            }
                        })
                    }
                    TurnEvent::ToolExecuting { id } => update_turn(&snapshot_for_task, |state| {
                        state.status = "tooling".to_string();
                        state.message = "Running tool…".to_string();
                        if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                            tool.status = "running".to_string();
                        }
                    }),
                    TurnEvent::ToolOutputDelta { id, chunk } => {
                        update_turn(&snapshot_for_task, |state| {
                            if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                                tool.status = "running".to_string();
                                tool.live_output.push_str(chunk);
                            }
                        })
                    }
                    TurnEvent::ToolResult {
                        id,
                        content,
                        details,
                        is_error,
                        ..
                    } => update_turn(&snapshot_for_task, |state| {
                        state.status = "tooling".to_string();
                        state.message = if *is_error {
                            "Tool failed".to_string()
                        } else {
                            "Tool finished".to_string()
                        };
                        if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                            tool.status = if *is_error {
                                "error".to_string()
                            } else {
                                "done".to_string()
                            };
                            tool.result_text = Some(content_blocks_to_text(content));
                            tool.detail = tool_detail(details);
                            tool.is_error = *is_error;
                            tool.live_output.clear();
                        }
                    }),
                    TurnEvent::TurnEnd => update_turn(&snapshot_for_task, |state| {
                        state.status = "finalizing".to_string();
                        state.message = "Finalizing response…".to_string();
                    }),
                    TurnEvent::ContextOverflow { message } | TurnEvent::Error(message) => {
                        update_turn(&snapshot_for_task, |state| {
                            state.status = "failed".to_string();
                            state.message = message.clone();
                            state.error = Some(message.clone());
                        })
                    }
                    TurnEvent::AutoRetryStart {
                        attempt,
                        max_attempts,
                        ..
                    } => update_turn(&snapshot_for_task, |state| {
                        state.status = "retrying".to_string();
                        state.message = format!("Retrying request ({attempt}/{max_attempts})…");
                    }),
                    TurnEvent::AutoRetryEnd => update_turn(&snapshot_for_task, |state| {
                        state.status = "streaming".to_string();
                        state.message = "Retry complete. Continuing…".to_string();
                    }),
                    TurnEvent::AutoCompactionStart => update_turn(&snapshot_for_task, |state| {
                        state.status = "compacting".to_string();
                        state.message = "Auto-compacting session…".to_string();
                    }),
                    TurnEvent::Done { .. } | TurnEvent::Status(_) => {}
                })
                .await;

        match result {
            Ok(_) if cancel.is_cancelled() => update_turn(&snapshot_for_task, |state| {
                state.status = "cancelled".to_string();
                state.message = "Response stopped".to_string();
                state.completed = true;
                state.succeeded = false;
                state.error = None;
            }),
            Ok(_) => update_turn(&snapshot_for_task, |state| {
                state.status = "succeeded".to_string();
                state.message = "Response complete".to_string();
                state.completed = true;
                state.succeeded = true;
                state.error = None;
            }),
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
            state.status = "cancelling".to_string();
            state.message = "Stopping response…".to_string();
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
