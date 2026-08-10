//! Structural guards for the Cloud agent run lifecycle transaction boundary.

const COMPLETION_SOURCE: &str = include_str!("../src/cloud_agent_runtime/runs/completion.rs");
const DELIVERY_SOURCE: &str = include_str!("../src/cloud_agent_runtime/runs/delivery.rs");
const CLAIMS_SOURCE: &str = include_str!("../src/cloud_agent_runtime/runs/claims.rs");
const ROUTES_SOURCE: &str = include_str!("../src/cloud_agent_runtime/routes.rs");

#[test]
fn terminal_run_state_and_response_delivery_share_one_transaction() {
    assert!(COMPLETION_SOURCE.contains("claimed_by = $2 FOR UPDATE"));
    assert!(COMPLETION_SOURCE.contains("ensure_terminal_response_message_in_transaction("));
    assert!(COMPLETION_SOURCE.contains("mark_scheduled_task_run_completed_in_transaction("));
    assert!(COMPLETION_SOURCE.contains("mark_scheduled_task_run_failed_in_transaction("));
    assert!(COMPLETION_SOURCE.contains("tx.commit().await?"));
    assert!(COMPLETION_SOURCE.contains("cloud_agent_target_id_for_request_in_transaction"));
    assert!(!COMPLETION_SOURCE.contains("response_message_id, target_agent_id"));
}

#[test]
fn delivery_helpers_cannot_commit_outside_the_terminal_transition() {
    assert!(DELIVERY_SOURCE.contains("Transaction<'_, Postgres>"));
    assert!(DELIVERY_SOURCE.contains("append_cloud_message_sync_events_in_transaction"));
    assert!(!DELIVERY_SOURCE.contains("pool.begin()"));
    assert!(!DELIVERY_SOURCE.contains("tx.commit()"));
}

#[test]
fn authenticated_cancellation_stops_active_runs_at_the_server_boundary() {
    assert!(ROUTES_SOURCE.contains("/v1/cloud/agent-runs/request/:request_message_id/cancel"));
    assert!(CLAIMS_SOURCE.contains("ORDER BY created_at DESC LIMIT 1 FOR UPDATE"));
    assert!(CLAIMS_SOURCE.contains("SET status = 'cancelled'"));
    assert!(CLAIMS_SOURCE.contains("lease_expires_at = NULL"));
}
