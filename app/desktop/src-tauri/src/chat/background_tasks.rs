mod managed_child;
mod shared_router;

use kordi_cli::desktop_runtime::{DesktopChatContextMessage, DesktopVisibleTaskRecord};
use tauri::State;

use super::{
    message_execution, DesktopChatManager, DesktopChatMessageRoute, DesktopChatTurnSnapshot,
};

pub(super) use managed_child::ManagedChildAgentRunner;
pub(super) use shared_router::{classify_shared_task, existing_or_spawn_background_session};

#[tauri::command]
#[allow(clippy::too_many_arguments, reason = "stable top-level Tauri IPC keys")]
pub async fn desktop_chat_start_shared_message(
    manager: State<'_, DesktopChatManager>,
    request_id: String,
    session_id: String,
    text: String,
    attachment_paths: Option<Vec<String>>,
    route: Option<DesktopChatMessageRoute>,
    context_messages: Option<Vec<DesktopChatContextMessage>>,
    visible_task_records: Option<Vec<DesktopVisibleTaskRecord>>,
    scheduled_task_session_id: Option<String>,
) -> Result<DesktopChatTurnSnapshot, String> {
    message_execution::start_shared_message(
        manager.inner(),
        request_id,
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
        },
    )
    .await
}
