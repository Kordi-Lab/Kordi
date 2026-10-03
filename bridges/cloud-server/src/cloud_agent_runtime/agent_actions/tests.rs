use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use super::calendar::{declined_text, subject_key, timeout_text, waiting_text};
use super::ActionRow;

fn row(kind: &str, subject: serde_json::Value) -> ActionRow {
    ActionRow {
        action_id: Uuid::nil(),
        kind: kind.to_string(),
        conversation_id: Uuid::nil(),
        session_id: "session:group:fixture".to_string(),
        approver: None,
        proposed_by: "acct_proposer".to_string(),
        proposer_name: Some("PiP".to_string()),
        event_id: None,
        subject,
        status: "pending".to_string(),
        created_at: Utc::now(),
        expires_at: Utc::now(),
        decided_by: None,
        expired: false,
    }
}

#[test]
fn pending_actions_name_who_proposed_them() {
    let calendar = row(
        "calendar_disclosure",
        json!({"agentId": "cloud-agent:owner", "agentName": "Scout"}),
    )
    .to_json();
    assert_eq!(calendar["proposedBy"]["kind"], "agent");
    assert_eq!(calendar["proposedBy"]["displayName"], "Scout");
    assert_eq!(calendar["sessionId"], "session:group:fixture");
    assert_eq!(calendar["subject"]["agentName"], "Scout");

    let suggestion = row("plan_confirm", json!({"eventId": "plan_1", "revision": 3})).to_json();
    assert_eq!(suggestion["proposedBy"]["kind"], "pip");
    assert_eq!(suggestion["proposedBy"]["displayName"], "PiP");
    assert!(row("plan_reopen", json!({})).is_manager_kind());
    assert!(!row("plan_rsvp", json!({})).is_manager_kind());
}

#[test]
fn calendar_windows_and_texts() {
    assert_eq!(
        subject_key(Some("2026-10-02T00:00:00Z"), None),
        "calendar:2026-10-02T00:00:00Z:"
    );
    assert_eq!(subject_key(None, None), "calendar::");
    assert_eq!(
        waiting_text("Olive"),
        "Waiting for Olive to approve sharing their calendar in this chat. \
         Do not share or guess calendar details."
    );
    assert!(timeout_text("Olive").starts_with("Olive has not approved sharing their calendar"));
    assert!(timeout_text("Olive").contains("an app update may be needed"));
    assert_eq!(
        declined_text("Olive"),
        "Olive chose not to share their calendar in this chat. \
         Do not share or guess calendar details."
    );
}
