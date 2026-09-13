use super::{now_millis, update_turn, DesktopChatTurnSnapshot};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// Queue reservation alone is not processing. Once admitted, history retrieval
/// and provider preparation are real work and must use main's visible phase.
pub(super) async fn begin_preparation(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    cancel: &CancellationToken,
    previous: Option<oneshot::Receiver<()>>,
) -> bool {
    if let Some(previous) = previous {
        let _ = previous.await;
    }
    let mut admitted = false;
    update_turn(snapshot, |state| {
        if state.completed {
            return;
        }
        if cancel.is_cancelled() {
            state.status = "cancelled".into();
            state.completed = true;
            state.completed_at_ms = Some(now_millis());
            return;
        }
        state.status = "preparing".into();
        state.message = "Preparing response…".into();
        state.started_at_ms = now_millis();
        admitted = true;
    });
    admitted
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(status: &str) -> Arc<Mutex<DesktopChatTurnSnapshot>> {
        Arc::new(Mutex::new(DesktopChatTurnSnapshot {
            id: "turn".into(),
            session_id: "session".into(),
            prompt: "Describe the earlier image".into(),
            status: status.into(),
            message: "Working…".into(),
            assistant_text: String::new(),
            thinking_text: String::new(),
            tools: vec![],
            completed: false,
            succeeded: false,
            started_at_ms: 1,
            completed_at_ms: None,
            transcript_entry_id: None,
            error: None,
            transcript_refresh_required: false,
        }))
    }

    #[tokio::test]
    async fn admitted_execution_is_visible_before_history_or_first_model_output() {
        let turn = snapshot("starting");
        assert!(begin_preparation(&turn, &CancellationToken::new(), None).await);
        let state = turn.lock().unwrap();
        assert_eq!(state.status, "preparing");
        assert!(!state.completed);
        assert!(
            state.assistant_text.is_empty()
                && state.thinking_text.is_empty()
                && state.tools.is_empty()
        );
    }

    #[tokio::test]
    async fn queued_execution_only_becomes_processing_after_its_predecessor_finishes() {
        let turn = snapshot("queued");
        let cancel = CancellationToken::new();
        let (done, previous) = oneshot::channel();
        let mut pending = Box::pin(begin_preparation(&turn, &cancel, Some(previous)));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), pending.as_mut())
                .await
                .is_err()
        );
        assert_eq!(turn.lock().unwrap().status, "queued");
        done.send(()).unwrap();
        assert!(pending.await);
        assert_eq!(turn.lock().unwrap().status, "preparing");
    }

    #[tokio::test]
    async fn cancellation_while_queued_never_flashes_processing() {
        let turn = snapshot("queued");
        let cancel = CancellationToken::new();
        let (done, previous) = oneshot::channel();
        cancel.cancel();
        done.send(()).unwrap();
        assert!(!begin_preparation(&turn, &cancel, Some(previous)).await);
        assert_eq!(turn.lock().unwrap().status, "cancelled");
        assert!(turn.lock().unwrap().completed);
    }

    #[tokio::test]
    async fn an_already_failed_execution_is_not_reopened_by_admission() {
        let turn = snapshot("failed");
        turn.lock().unwrap().completed = true;
        assert!(!begin_preparation(&turn, &CancellationToken::new(), None).await);
        assert_eq!(turn.lock().unwrap().status, "failed");
    }
}
