//! A finished background session hands its outcome back to the parent session
//! as one runtime follow-up turn, so the parent agent reports it in the chat.

use kordi_cli::desktop_runtime::BACKGROUND_FOLLOW_UP_ENTRY_PREFIX;

use super::super::{update_turn, DesktopBackgroundFollowUp, DesktopChatManager};
use crate::chat::DesktopChatTurnSnapshot;

const FINAL_MESSAGE_LIMIT_CHARS: usize = 4_000;
const ERROR_LIMIT_CHARS: usize = 300;

pub(super) fn terminal_status(turn: &DesktopChatTurnSnapshot) -> Option<&'static str> {
    if !turn.completed {
        return None;
    }
    Some(if turn.status == "cancelled" {
        "stopped"
    } else if turn.succeeded {
        "done"
    } else {
        "failed"
    })
}

/// The follow-up identity, also used as the parent transcript entry id.
pub(super) fn follow_up_id(child_session_id: &str, status: &str) -> String {
    format!("{BACKGROUND_FOLLOW_UP_ENTRY_PREFIX}{child_session_id}:{status}")
}

fn tail_chars(text: &str, limit: usize) -> String {
    let count = text.chars().count();
    if count <= limit {
        return text.to_string();
    }
    format!("…{}", text.chars().skip(count - limit).collect::<String>())
}

pub(super) fn follow_up_text(
    title: &str,
    status: &str,
    final_message: &str,
    error: Option<&str>,
) -> String {
    let headline = match status {
        "done" => format!("Background session \"{title}\" finished."),
        "stopped" => format!("Background session \"{title}\" was stopped."),
        _ => {
            let error = error
                .map(|error| error.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|error| !error.is_empty())
                .unwrap_or_else(|| "no error was reported".to_string());
            format!(
                "Background session \"{title}\" failed: {}",
                error.chars().take(ERROR_LIMIT_CHARS).collect::<String>()
            )
        }
    };
    let mut text = format!(
        "{headline}\n\nThis is a runtime follow-up, not a message from a person. Report the outcome to the conversation in your own words."
    );
    let final_message = final_message.trim();
    if !final_message.is_empty() {
        text.push_str("\n\nFinal message from the background session:\n");
        text.push_str(&tail_chars(final_message, FINAL_MESSAGE_LIMIT_CHARS));
    }
    text
}

/// Claims a follow-up for this process. A claimed follow-up is never delivered
/// again, including when the parent already consumed the outcome itself.
pub(super) async fn claim(manager: &DesktopChatManager, id: &str) -> bool {
    manager
        .background_follow_up_ids
        .lock()
        .await
        .insert(id.to_string())
}

/// Labels the started turn and exposes it to the background turn discovery,
/// which publishes its reply like any other agent reply.
pub(super) async fn expose_turn(
    manager: &DesktopChatManager,
    turn_id: &str,
    origin: DesktopBackgroundFollowUp,
) {
    if let Some(turn) = manager.turns.lock().await.get(turn_id) {
        update_turn(&turn.snapshot, |state| {
            state.background_follow_up = Some(origin);
        });
    }
    manager
        .background_turn_ids
        .lock()
        .await
        .insert(turn_id.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(status: &str, completed: bool, succeeded: bool) -> DesktopChatTurnSnapshot {
        DesktopChatTurnSnapshot {
            id: "child-turn".into(),
            session_id: "child".into(),
            prompt: "Count lines.".into(),
            status: status.into(),
            message: String::new(),
            assistant_text: "There are 1,204 lines.".into(),
            thinking_text: String::new(),
            tools: Vec::new(),
            completed,
            succeeded,
            started_at_ms: 1,
            completed_at_ms: completed.then_some(2),
            transcript_entry_id: None,
            error: None,
            transcript_refresh_required: false,
            background_follow_up: None,
        }
    }

    #[test]
    fn terminal_states_map_to_subsession_statuses() {
        assert_eq!(terminal_status(&turn("running", false, false)), None);
        assert_eq!(
            terminal_status(&turn("succeeded", true, true)),
            Some("done")
        );
        assert_eq!(
            terminal_status(&turn("failed", true, false)),
            Some("failed")
        );
        assert_eq!(
            terminal_status(&turn("cancelled", true, false)),
            Some("stopped")
        );
        assert_eq!(
            follow_up_id("child", "done"),
            "background-result:child:done"
        );
    }

    #[test]
    fn follow_up_text_reports_each_outcome() {
        let done = follow_up_text("Count lines", "done", "There are 1,204 lines.", None);
        assert!(done.starts_with("Background session \"Count lines\" finished.\n\n"));
        assert!(done.contains("runtime follow-up, not a message from a person"));
        assert!(
            done.ends_with("Final message from the background session:\nThere are 1,204 lines.")
        );

        let failed = follow_up_text(
            "Count lines",
            "failed",
            "",
            Some("Provider\nrejected the request"),
        );
        assert!(failed.starts_with(
            "Background session \"Count lines\" failed: Provider rejected the request\n"
        ));
        assert!(!failed.contains("Final message"));

        let stopped = follow_up_text("Count lines", "stopped", " ", None);
        assert!(stopped.starts_with("Background session \"Count lines\" was stopped.\n"));
    }

    fn handle(turn_id: &str) -> crate::chat::DesktopChatTurnHandle {
        let mut snapshot = turn("starting", false, false);
        snapshot.id = turn_id.into();
        snapshot.session_id = "parent".into();
        crate::chat::DesktopChatTurnHandle {
            snapshot: std::sync::Arc::new(std::sync::Mutex::new(snapshot)),
            cancel: tokio_util::sync::CancellationToken::new(),
            execution_lease_deadline: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }

    #[tokio::test]
    async fn a_follow_up_is_claimed_once_per_session_and_outcome() {
        let manager = DesktopChatManager::default();
        let done = follow_up_id("child", "done");
        assert!(claim(&manager, &done).await);
        assert!(!claim(&manager, &done).await);
        assert!(claim(&manager, &follow_up_id("child", "failed")).await);
    }

    #[tokio::test]
    async fn a_follow_up_queues_behind_the_running_parent_turn() {
        let manager = DesktopChatManager::default();
        let (_, parent_done) = crate::chat::reserve_turn_in_session(
            &manager,
            "parent-turn".into(),
            handle("parent-turn"),
        )
        .await
        .unwrap();
        let follow_up = handle("follow-up-turn");
        let (previous, _follow_up_done) = crate::chat::reserve_turn_in_session(
            &manager,
            "follow-up-turn".into(),
            follow_up.clone(),
        )
        .await
        .unwrap();

        assert_eq!(follow_up.snapshot.lock().unwrap().status, "queued");
        let mut previous = Box::pin(previous.expect("follow-up waits for the parent turn"));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), previous.as_mut())
                .await
                .is_err()
        );
        drop(parent_done);
        let _ = previous.await;
    }

    #[tokio::test]
    async fn a_started_follow_up_is_labelled_and_discoverable() {
        let manager = DesktopChatManager::default();
        manager
            .turns
            .lock()
            .await
            .insert("follow-up-turn".into(), handle("follow-up-turn"));
        let origin = DesktopBackgroundFollowUp {
            id: follow_up_id("child", "done"),
            session_id: "child".into(),
            parent_request_id: Some("request".into()),
            title: "Count lines".into(),
            status: "done".into(),
        };

        expose_turn(&manager, "follow-up-turn", origin.clone()).await;

        let turns = crate::chat::active_turn_snapshots(&manager).await.unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].background_follow_up.as_ref(), Some(&origin));
    }

    #[test]
    fn follow_up_text_keeps_the_end_of_a_long_final_message() {
        let long = format!("{}END", "x".repeat(5_000));
        let text = follow_up_text("Count lines", "done", &long, None);
        let tail = text.rsplit_once(":\n").unwrap().1;
        assert_eq!(tail.chars().count(), FINAL_MESSAGE_LIMIT_CHARS + 1);
        assert!(tail.starts_with('…') && tail.ends_with("END"));
    }
}
