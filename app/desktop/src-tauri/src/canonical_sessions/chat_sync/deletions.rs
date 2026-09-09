use super::*;

// A removal is terminal for this viewer. Keep its marker even when bootstrap
// replaces the message cache, so an older page or later edit cannot restore it.
pub(in crate::canonical_sessions) fn mark_message_deleted(
    tx: &Transaction<'_>,
    account_id: &str,
    message_id: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO chat_sync_message_deletions (account_id, message_id)
         VALUES (?1, ?2)",
        params![account_id, message_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM chat_sync_pending_operations WHERE account_id = ?1 AND operation_id IN (
            SELECT client_message_id FROM chat_sync_messages WHERE account_id = ?1 AND message_id = ?2
        )", params![account_id, message_id],
    ).map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM chat_sync_messages WHERE account_id = ?1 AND message_id = ?2",
        params![account_id, message_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub(super) fn load_deleted_message_ids(
    conn: &Connection,
    account_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT message_id FROM chat_sync_message_deletions WHERE account_id = ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([account_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_chat_sync_deleted_message_ids(
    account_id: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_account_db(account_id.trim())?;
        load_deleted_message_ids(&conn, account_id.trim())
    })
    .await
    .map_err(|error| error.to_string())?
}
