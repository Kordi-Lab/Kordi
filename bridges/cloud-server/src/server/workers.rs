//! The background workers the server starts once its state exists.

use std::sync::Arc;

use super::ServerState;

/// Starts every periodic worker: realtime wakes, support tickets, scheduled
/// tasks, digests, PiP, proactive agents, plan-card projection, retention,
/// terminal backfill, and the notification workers when notifications are
/// configured.
pub(super) fn spawn_background_workers(state: &Arc<ServerState>, database_url: &str) {
    crate::chat_sync::realtime::spawn_wake_listener(
        database_url.to_string(),
        state.chat_sync_wakes().clone(),
    );
    crate::support::spawn_ticket_worker(state.clone());
    crate::scheduled_tasks::worker::spawn_scheduled_task_worker(state.clone());
    crate::digest::spawn(state.clone());
    crate::pip::spawn(state.clone());
    crate::proactive::spawn(state.clone());
    crate::plan_cards::projection::spawn(state.db_pool().clone());
    crate::chat_sync::retention::spawn_retention_worker(state.db_pool().clone());
    crate::cloud_agent_runtime::runs::terminal_backfill::spawn(state.db_pool().clone());
    if let Some(notifications) = state.notifications() {
        notifications.spawn_message_notification_worker(state.db_pool().clone());
        notifications.spawn_calendar_worker(state.db_pool().clone());
    }
}
