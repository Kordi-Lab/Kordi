use super::super::{turns::active_turn_snapshots, DesktopChatManager};
use kordi_cli::desktop_runtime::{
    background_runtime_session_ids, background_runtime_snapshot, BackgroundSessionMessage,
    BackgroundSessionSnapshot,
};

pub(super) async fn subsession_snapshot(
    manager: &DesktopChatManager,
    session_id: &str,
) -> anyhow::Result<BackgroundSessionSnapshot> {
    let mut snapshot = background_runtime_snapshot(session_id)?;
    snapshot.can_resume |= manager.sessions.lock().await.contains_key(session_id);
    let latest = active_turn_snapshots(manager)
        .await
        .map_err(anyhow::Error::msg)?
        .into_iter()
        .filter(|turn| turn.session_id == session_id)
        .max_by_key(|turn| turn.started_at_ms);
    if let Some(turn) = latest {
        snapshot.turn_id = Some(turn.id.clone());
        snapshot.activity = serde_json::json!({"tools":turn.tools.iter().map(|tool|serde_json::json!({"id":tool.id,"name":tool.name,"status":tool.status,"isError":tool.is_error,"arguments":"","liveOutput":""})).collect::<Vec<_>>()});
        snapshot.status = if !turn.completed {
            "running"
        } else if turn.status == "cancelled" {
            "stopped"
        } else if turn.succeeded {
            "done"
        } else {
            "failed"
        }
        .to_string();
        if !turn.completed && !turn.assistant_text.trim().is_empty() {
            if let Some(index) = snapshot
                .messages
                .iter()
                .rposition(|message| message.role == "user")
            {
                snapshot.messages.truncate(index + 1);
            }
            snapshot.messages.push(BackgroundSessionMessage {
                id: format!("live:{}", turn.id),
                role: "assistant".to_string(),
                text: turn.assistant_text,
                timestamp_ms: turn.started_at_ms,
            });
        }
    } else if matches!(snapshot.status.as_str(), "running" | "pending") {
        snapshot.status = "stopped".to_string();
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn desktop_chat_subsession_ids() -> Result<Vec<String>, String> {
    background_runtime_session_ids().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_chat_subsession_snapshot(
    manager: tauri::State<'_, DesktopChatManager>,
    session_id: String,
) -> Result<BackgroundSessionSnapshot, String> {
    subsession_snapshot(manager.inner(), &session_id)
        .await
        .map_err(|error| error.to_string())
}
