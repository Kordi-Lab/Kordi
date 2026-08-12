use super::run_canonical_blocking;

#[tauri::command]
pub async fn desktop_canonical_reconcile_message_mirror(
    preferred_message_id: String,
    duplicate_message_id: String,
) -> Result<bool, String> {
    run_canonical_blocking(move || {
        super::commands::desktop_canonical_reconcile_message_mirror(
            preferred_message_id,
            duplicate_message_id,
        )
    })
    .await
}
