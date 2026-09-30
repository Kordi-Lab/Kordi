use super::{
    TurnJoinPoll, classify_turn_join_poll, is_auto_compaction_status,
    is_auto_compaction_terminal_status,
};

#[tokio::test]
async fn classifies_join_timeout_without_treating_it_as_completion() {
    let poll = tokio::time::timeout(
        std::time::Duration::from_millis(0),
        std::future::pending::<Result<(), tokio::task::JoinError>>(),
    )
    .await;
    match classify_turn_join_poll(poll) {
        TurnJoinPoll::TimedOut => {}
        _ => panic!("timeout should remain an active-turn wait condition"),
    }
}

#[test]
fn detects_auto_compaction_status_messages() {
    assert!(is_auto_compaction_status(
        "Auto-compacted session: 10 summarized, 5 kept, 12345 tokens before"
    ));
    assert!(!is_auto_compaction_status("Compacted session manually"));
    assert!(!is_auto_compaction_status("Nothing to compact"));
}

#[test]
fn detects_auto_compaction_terminal_messages() {
    assert!(is_auto_compaction_terminal_status(
        "Auto-compacted session: 10 summarized, 5 kept, 12345 tokens before"
    ));
    assert!(is_auto_compaction_terminal_status(
        "Auto-compaction failed: quota exceeded"
    ));
    assert!(!is_auto_compaction_terminal_status("Compacting session..."));
}
