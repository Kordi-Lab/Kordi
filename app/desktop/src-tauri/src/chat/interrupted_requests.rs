//! Requests whose turn ended with an earlier app process.
//!
//! A native turn lives only in the memory of the process that runs it. When
//! the app quits or is replaced mid-turn, the session keeps an unanswered
//! request, and its Cloud mirror keeps a `processing` reply that nothing ever
//! ends. Loading such a session closes the request with the interruption
//! note and syncs it, so the reply turns terminal everywhere.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use tauri::State;

use super::canonical_sync::{
    is_cloud_agent_runtime_session_id, sync_completed_desktop_session_to_canonical,
};
use super::session_lifecycle::{ensure_loaded_or_create_explicit_session, session_exists_globally};
use super::turns::session_has_running_turn;
use super::{agent_builder, chat_cwd, now_millis, DesktopChatManager, DesktopSessionHandle};

static PROCESS_STARTED_AT_MS: OnceLock<i64> = OnceLock::new();
/// Sessions already checked by this process. Every request stored later
/// belongs to this process, whose turns close their own requests.
static CHECKED_SESSION_IDS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Records when this app process started. Call it before any session loads.
pub(crate) fn record_process_start() {
    PROCESS_STARTED_AT_MS.get_or_init(now_millis);
}

fn process_started_at_ms() -> i64 {
    *PROCESS_STARTED_AT_MS.get_or_init(now_millis)
}

/// Background and Cloud runtime sessions report their own interruptions, and
/// the agent builder keeps no request history.
fn closes_interrupted_requests(session_id: &str) -> bool {
    !is_cloud_agent_runtime_session_id(session_id)
        && !agent_builder::is_agent_builder_session_id(session_id)
        && !kordi_cli::desktop_runtime::is_background_runtime_session(session_id).unwrap_or(true)
}

/// Closes the session's request when an earlier app process stored it and
/// no turn of this process runs in the session. Returns whether it closed one.
pub(super) async fn close_interrupted_request(
    manager: &DesktopChatManager,
    session_id: &str,
    session: &DesktopSessionHandle,
) -> bool {
    if was_checked(session_id)
        || session_has_running_turn(manager, session_id).await
        || !closes_interrupted_requests(session_id)
    {
        return false;
    }
    let closed = session
        .lock()
        .await
        .close_request_interrupted_before(process_started_at_ms());
    match closed {
        Ok(closed) => {
            mark_checked(session_id);
            closed
        }
        Err(error) => {
            eprintln!("Unable to close an interrupted desktop request: {error}");
            false
        }
    }
}

fn was_checked(session_id: &str) -> bool {
    CHECKED_SESSION_IDS
        .lock()
        .map(|checked| checked.as_ref().is_some_and(|ids| ids.contains(session_id)))
        .unwrap_or(false)
}

fn mark_checked(session_id: &str) {
    if let Ok(mut checked) = CHECKED_SESSION_IDS.lock() {
        checked
            .get_or_insert_with(HashSet::new)
            .insert(session_id.to_string());
    }
}

/// Closes the session's interrupted request and syncs the note into the
/// canonical session, from where it reaches Cloud like any failed reply.
pub(super) async fn close_and_sync_interrupted_request(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    session_id: &str,
    session: &DesktopSessionHandle,
) -> bool {
    if !close_interrupted_request(manager, session_id, session).await {
        return false;
    }
    sync_completed_desktop_session_to_canonical(cwd, session_id, session).await;
    true
}

/// Closes a persisted session's request that an earlier app process left
/// unanswered. A session this Mac never stored is not created.
#[tauri::command]
pub async fn desktop_chat_close_interrupted_request(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
) -> Result<bool, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() || !closes_interrupted_requests(&session_id) {
        return Ok(false);
    }
    let loaded = manager.sessions.lock().await.get(&session_id).cloned();
    let session = match loaded {
        Some(session) => session,
        None if session_exists_globally(&session_id)? => {
            let cwd = chat_cwd()?;
            ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id.clone()).await?;
            let Some(session) = manager.sessions.lock().await.get(&session_id).cloned() else {
                return Ok(false);
            };
            session
        }
        None => return Ok(false),
    };
    let cwd = chat_cwd()?;
    Ok(close_and_sync_interrupted_request(&manager, &cwd, &session_id, &session).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_owned_sessions_report_their_own_interruptions() {
        assert!(!closes_interrupted_requests("cloud-agent:acct:session"));
        assert!(!closes_interrupted_requests("session:agent-builder:draft"));
    }
}
