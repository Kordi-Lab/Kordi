use super::*;

pub(in crate::chat) fn turn_matches_running_session(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    session_id: &str,
) -> bool {
    snapshot
        .lock()
        .map(|turn| {
            execution_session_key(&turn.session_id) == execution_session_key(session_id)
                && !turn.completed
        })
        .unwrap_or(false)
}

// Old owner-runtime records used an account-qualified UUID. New self-agent
// requests use the canonical UUID on both platforms; an in-flight old record
// must still reserve that same session during an update.
fn execution_session_key(session_id: &str) -> &str {
    session_id
        .strip_prefix("cloud-agent:")
        .and_then(|value| value.split_once(':'))
        .map(|(_, id)| id)
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .unwrap_or(session_id)
}

pub(in crate::chat) async fn reserve_turn_in_session(
    manager: &DesktopChatManager,
    turn_id: String,
    handle: crate::chat::DesktopChatTurnHandle,
) -> Result<
    (
        Option<tokio::sync::oneshot::Receiver<()>>,
        tokio::sync::oneshot::Sender<()>,
    ),
    String,
> {
    let session_id = snapshot_turn(&handle.snapshot)?.session_id;
    let (completion, next) = tokio::sync::oneshot::channel();
    let previous = manager
        .session_turn_tails
        .lock()
        .await
        .insert(execution_session_key(&session_id).to_string(), next)
        .and_then(|mut previous| match previous.try_recv() {
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => Some(previous),
            _ => None,
        });
    if previous.is_some() {
        update_turn(&handle.snapshot, |snapshot| {
            snapshot.status = "queued".to_string();
            snapshot.message = "Queued next".to_string();
        });
    }
    let mut turns = manager.turns.lock().await;
    // A publisher may still be polling when another session starts a turn.
    // Retain terminal snapshots for five minutes, longer than an execution lease.
    let terminal_cutoff = crate::chat::now_millis().saturating_sub(5 * 60 * 1_000);
    turns.retain(|_, turn| {
        turn.snapshot
            .lock()
            .map(|snapshot| {
                !snapshot.completed
                    || snapshot.completed_at_ms.unwrap_or(snapshot.started_at_ms) >= terminal_cutoff
            })
            .unwrap_or(false)
    });
    turns.insert(turn_id, handle);
    Ok((previous, completion))
}
