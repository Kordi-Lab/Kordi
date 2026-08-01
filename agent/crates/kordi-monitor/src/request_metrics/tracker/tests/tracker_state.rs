//! RequestMetricsTracker lifecycle and reset scenarios.

use super::*;

#[test]
fn tracker_wraps_state_prepare_and_commit() {
    let snapshot = RequestMetricsSnapshot {
        system_prompt: "system".to_string(),
        provider_messages: vec![serde_json::json!({ "role": "user", "content": "hello" })],
        tool_definitions: vec![],
        extra_tool_definitions: vec![],
        model: "gpt-5".to_string(),
        max_tokens: Some(64),
        stream: true,
        thinking: Some("medium".to_string()),
    };
    let mut tracker = RequestMetricsTracker::new();
    tracker.increment_context_epoch();

    let prepared = tracker.prepare(&snapshot).expect("prepare");
    assert_eq!(prepared.context_epoch, 1);
    tracker.commit(&prepared);
    assert_eq!(
        tracker.state().last_request_hash.as_deref(),
        Some(prepared.full_request_hash.as_str())
    );
}

#[test]
fn reset_history_clears_previous_prompt_and_bumps_epoch() {
    let snapshot = RequestMetricsSnapshot {
        system_prompt: "system".to_string(),
        provider_messages: vec![serde_json::json!({ "role": "user", "content": "hello" })],
        tool_definitions: vec![],
        extra_tool_definitions: vec![],
        model: "gpt-5".to_string(),
        max_tokens: Some(64),
        stream: true,
        thinking: None,
    };
    let mut tracker = RequestMetricsTracker::new();
    let prepared = tracker.prepare(&snapshot).expect("prepare");
    tracker.commit(&prepared);

    tracker.reset_history();
    let prepared_after_reset = tracker.prepare(&snapshot).expect("prepare after reset");

    assert_eq!(tracker.state().context_epoch, 1);
    assert!(tracker.state().last_request_hash.is_none());
    assert!(tracker.state().last_cacheable_prompt.is_none());
    assert!(prepared_after_reset.previous_request_hash.is_none());
    assert_eq!(prepared_after_reset.reused_prefix_bytes_estimate, None);
}
