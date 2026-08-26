use std::sync::{Arc, Mutex};

use kordi_cli::turn_runner::TurnEvent;

use super::{DesktopChatManager, DesktopChatToolSnapshot, DesktopChatTurnSnapshot};

fn stored_tool_is_model_task_tool(
    tool: &kordi_cli::desktop_runtime::DesktopChatStoredTool,
) -> bool {
    let name = tool.name.trim().to_lowercase();
    name == "task_operator" || name == "update_plan" || tool.is_error
}

fn snapshot_tool_is_model_task_tool(tool: &DesktopChatToolSnapshot) -> bool {
    let name = tool.name.trim().to_lowercase();
    name == "task_operator" || name == "update_plan" || tool.is_error
}

pub(super) fn turn_snapshot_has_model_task_tools(tools: &[DesktopChatToolSnapshot]) -> bool {
    tools.iter().any(snapshot_tool_is_model_task_tool)
}

pub(super) fn desktop_task_tools_from_messages(
    messages: &[kordi_cli::desktop_runtime::DesktopChatMessage],
) -> Vec<DesktopChatToolSnapshot> {
    let mut tools = Vec::new();
    for message in messages.iter().rev() {
        if message.role == "user" {
            break;
        }
        if message.role != "assistant" {
            continue;
        }
        for tool in message
            .tools
            .iter()
            .filter(|tool| stored_tool_is_model_task_tool(tool))
            .rev()
        {
            tools.push(DesktopChatToolSnapshot {
                id: tool.id.clone(),
                name: tool.name.clone(),
                status: tool.status.clone(),
                arguments: tool.arguments.clone(),
                live_output: tool.live_output.clone(),
                result_text: tool.result_text.clone(),
                detail: tool.detail.clone(),
                artifact_path: tool.artifact_path.clone(),
                tool_layer: tool.tool_layer.clone(),
                is_error: tool.is_error,
            });
        }
    }
    tools.reverse();
    tools
}

pub(super) fn snapshot_turn(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
) -> Result<DesktopChatTurnSnapshot, String> {
    snapshot
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "Chat turn state is unavailable".to_string())
}

pub(super) async fn turn_snapshot_by_id(
    manager: &DesktopChatManager,
    turn_id: &str,
) -> Result<DesktopChatTurnSnapshot, String> {
    let turn = manager
        .turns
        .lock()
        .await
        .get(turn_id)
        .cloned()
        .ok_or_else(|| format!("Unknown chat turn: {turn_id}"))?;
    let current = snapshot_turn(&turn.snapshot)?;
    if current.completed
        || (current.status != "cancelling" && !current.tools.iter().any(|tool| tool.is_error))
    {
        return Ok(current);
    }

    let session = manager
        .sessions
        .lock()
        .await
        .get(&current.session_id)
        .cloned();
    if let Some(session) = session {
        if let Ok(detail) = session.lock().await.detail() {
            update_turn(&turn.snapshot, |state| {
                reconcile_persisted_cancelled_turn(state, &detail.messages);
            });
        }
    }
    snapshot_turn(&turn.snapshot)
}

fn reconcile_persisted_cancelled_turn(
    turn: &mut DesktopChatTurnSnapshot,
    messages: &[kordi_cli::desktop_runtime::DesktopChatMessage],
) -> bool {
    if turn.completed {
        return false;
    }
    let Some(message) = messages
        .iter()
        .rev()
        .take_while(|message| !message.role.eq_ignore_ascii_case("user"))
        .find(|message| {
            message.role.eq_ignore_ascii_case("assistant")
                && message.cancelled
                && message.timestamp_ms >= turn.started_at_ms
        })
    else {
        return false;
    };

    turn.status = "cancelled".to_string();
    turn.message = "Response stopped".to_string();
    if message.text.len() >= turn.assistant_text.len() {
        turn.assistant_text = message.text.clone();
    }
    if let Some(thinking_text) = message
        .thinking_text
        .as_ref()
        .filter(|text| text.len() >= turn.thinking_text.len())
    {
        turn.thinking_text = thinking_text.clone();
    }
    turn.completed = true;
    turn.succeeded = false;
    turn.completed_at_ms = Some(message.timestamp_ms);
    turn.transcript_entry_id = message.entry_id.clone();
    turn.error = None;
    true
}

pub(super) async fn active_turn_snapshots(
    manager: &DesktopChatManager,
) -> Result<Vec<DesktopChatTurnSnapshot>, String> {
    let background_turn_ids = manager.background_turn_ids.lock().await.clone();
    let turns = manager.turns.lock().await;
    let snapshots = turns
        .iter()
        .filter(|(turn_id, _)| background_turn_ids.contains(*turn_id))
        .map(|(_, turn)| snapshot_turn(&turn.snapshot))
        .collect::<Result<Vec<_>, _>>()?;
    let retained_ids = turns
        .keys()
        .filter(|turn_id| background_turn_ids.contains(*turn_id))
        .cloned()
        .collect();
    drop(turns);
    *manager.background_turn_ids.lock().await = retained_ids;
    Ok(snapshots)
}

#[tauri::command]
pub async fn desktop_chat_active_turns(
    manager: tauri::State<'_, DesktopChatManager>,
) -> Result<Vec<DesktopChatTurnSnapshot>, String> {
    active_turn_snapshots(manager.inner()).await
}

pub(super) async fn cancel_turn_by_id(
    manager: &DesktopChatManager,
    turn_id: &str,
) -> Result<DesktopChatTurnSnapshot, String> {
    let turns = manager.turns.lock().await;
    let turn = turns
        .get(turn_id)
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

pub(super) fn update_turn(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    apply: impl FnOnce(&mut DesktopChatTurnSnapshot),
) {
    if let Ok(mut guard) = snapshot.lock() {
        apply(&mut guard);
    }
}

pub(super) fn is_auto_compaction_success_status(message: &str) -> bool {
    message.starts_with("Auto-compacted session:")
}

pub(super) fn is_auto_compaction_failure_status(message: &str) -> bool {
    message.starts_with("Auto-compaction failed:")
}

pub(super) fn apply_desktop_turn_event(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    event: &TurnEvent,
) {
    match event {
        TurnEvent::TurnStart { .. } => update_turn(snapshot, |state| {
            state.status = "streaming".to_string();
            state.message = "Working…".to_string();
            state.error = None;
        }),
        TurnEvent::TextDelta(text) => update_turn(snapshot, |state| {
            state.status = "writing".to_string();
            state.message = "Writing response…".to_string();
            state.error = None;
            state.assistant_text.push_str(text);
        }),
        TurnEvent::ThinkingDelta(text) => update_turn(snapshot, |state| {
            state.status = "thinking".to_string();
            state.message = "Thinking…".to_string();
            state.error = None;
            state.thinking_text.push_str(text);
        }),
        TurnEvent::ToolCallStart { id, name } => update_turn(snapshot, |state| {
            state.status = "tooling".to_string();
            state.message = "Working…".to_string();
            state.error = None;
            state.tools.push(DesktopChatToolSnapshot {
                id: id.clone(),
                name: name.clone(),
                status: "preparing".to_string(),
                arguments: String::new(),
                live_output: String::new(),
                result_text: None,
                detail: None,
                artifact_path: None,
                tool_layer: None,
                is_error: false,
            });
        }),
        TurnEvent::ToolCallDelta { id, args } => update_turn(snapshot, |state| {
            if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                tool.arguments.push_str(args);
            }
        }),
        TurnEvent::ToolExecuting { id } => update_turn(snapshot, |state| {
            state.status = "tooling".to_string();
            state.message = "Running tool…".to_string();
            if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                tool.status = "running".to_string();
            }
        }),
        TurnEvent::ToolOutputDelta { id, chunk } => update_turn(snapshot, |state| {
            if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                tool.status = "running".to_string();
                tool.live_output.push_str(chunk);
            }
        }),
        TurnEvent::ToolResult {
            id,
            content,
            details,
            artifact_path,
            is_error,
            ..
        } => update_turn(snapshot, |state| {
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
                tool.artifact_path = artifact_path.clone();
                tool.tool_layer = tool_layer(details);
                tool.is_error = *is_error;
                tool.live_output.clear();
            }
        }),
        TurnEvent::TurnEnd => update_turn(snapshot, |state| {
            state.status = "finalizing".to_string();
            state.message = "Finalizing response…".to_string();
        }),
        TurnEvent::ContextOverflow { message } | TurnEvent::Error(message) => {
            update_turn(snapshot, |state| {
                state.status = "failed".to_string();
                state.message = message.clone();
                state.error = Some(message.clone());
            })
        }
        TurnEvent::AutoRetryStart {
            attempt,
            max_attempts,
            ..
        } => update_turn(snapshot, |state| {
            state.status = "retrying".to_string();
            state.message = format!("Retrying request ({attempt}/{max_attempts})…");
        }),
        TurnEvent::AutoRetryEnd => update_turn(snapshot, |state| {
            state.status = "streaming".to_string();
            state.message = "Retry complete. Continuing…".to_string();
            state.error = None;
        }),
        TurnEvent::AutoCompactionStart => update_turn(snapshot, |state| {
            state.status = "compacting".to_string();
            state.message = "Compressing conversation…".to_string();
        }),
        TurnEvent::Status(message) if is_auto_compaction_success_status(message) => {
            update_turn(snapshot, |state| {
                state.status = "compacted".to_string();
                state.message = "Conversation compressed. Continuing…".to_string();
                state.error = None;
                state.transcript_refresh_required = true;
            })
        }
        TurnEvent::Status(message) if is_auto_compaction_failure_status(message) => {
            update_turn(snapshot, |state| {
                state.status = "compaction_failed".to_string();
                state.message = message.clone();
                state.error = Some(message.clone());
            })
        }
        TurnEvent::Done { .. } | TurnEvent::Status(_) => {}
    }
}

pub(super) fn turn_matches_running_session(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    session_id: &str,
) -> bool {
    snapshot
        .lock()
        .map(|turn| turn.session_id == session_id && !turn.completed)
        .unwrap_or(false)
}

pub(super) async fn reserve_turn_if_session_idle(
    manager: &DesktopChatManager,
    turn_id: String,
    handle: super::DesktopChatTurnHandle,
) -> bool {
    let session_id = match handle.snapshot.lock() {
        Ok(snapshot) => snapshot.session_id.clone(),
        Err(_) => return false,
    };
    let mut turns = manager.turns.lock().await;
    turns.retain(|_, turn| {
        turn.snapshot
            .lock()
            .map(|snapshot| !snapshot.completed)
            .unwrap_or(false)
    });
    if turns
        .values()
        .any(|turn| turn_matches_running_session(&turn.snapshot, &session_id))
    {
        return false;
    }
    turns.insert(turn_id, handle);
    true
}

pub(super) async fn session_has_running_turn(
    manager: &DesktopChatManager,
    session_id: &str,
) -> bool {
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

fn tool_layer(details: &Option<serde_json::Value>) -> Option<String> {
    let details = details.as_ref()?;
    details
        .get("toolLayer")
        .or_else(|| details.get("tool_layer"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
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

#[cfg(test)]
mod tests;
