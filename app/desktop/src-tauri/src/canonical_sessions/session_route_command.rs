use super::commands::CanonicalSessionRequestRoute;
use super::run_canonical_blocking;

/// The latest route each session's own desktop requests recorded in the mirror.
#[tauri::command]
pub async fn desktop_canonical_session_request_routes(
) -> Result<Vec<CanonicalSessionRequestRoute>, String> {
    run_canonical_blocking(super::commands::desktop_canonical_session_request_routes).await
}
