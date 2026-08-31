use super::{apply::load_all_conversation_heads, open_db, ChatSyncConversationHead};

#[tauri::command]
pub async fn desktop_chat_sync_unread_counts(
    account_id: String,
) -> Result<Vec<ChatSyncConversationHead>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let account_id = account_id.trim().to_string();
        if account_id.is_empty() {
            return Err("Chat sync account id is required".to_string());
        }
        let conn = open_db()?;
        load_all_conversation_heads(&conn, &account_id)
    })
    .await
    .map_err(|error| error.to_string())?
}
