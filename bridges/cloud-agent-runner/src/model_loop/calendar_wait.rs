//! Calendar reads that wait for the owner's approval.
//!
//! In a shared conversation the server answers `approval_required` until the
//! owner allows sharing their saved calendar in Kordi. The read is repeated
//! every few seconds, for at most two minutes, while the run's heartbeat keeps
//! its lease. The model only ever gets calendar data, the owner's decline, or
//! the timeout text, never a half-finished wait.

use kordi_tools::calendar::{
    calendar_wait_text, is_shared_calendar_data, CalendarApprovalWait, CALENDAR_APPROVAL_TIMEOUT,
    CALENDAR_DECLINED, CALENDAR_UNAVAILABLE,
};
use serde_json::Value;

use crate::client::CloudAgentRunClient;

/// What a calendar read gave the model.
pub struct CalendarReadOutcome {
    pub content: Value,
    /// Saved calendar data was read for sharing in this conversation.
    pub disclosed: bool,
}

impl CalendarReadOutcome {
    fn text(text: impl Into<String>) -> Self {
        Self {
            content: Value::String(text.into()),
            disclosed: false,
        }
    }
}

pub async fn read_calendar<C: CloudAgentRunClient + Sync>(
    client: &C,
    run_id: &str,
    arguments: Value,
    wait: CalendarApprovalWait,
) -> CalendarReadOutcome {
    let started = tokio::time::Instant::now();
    loop {
        let value = match client
            .read_context(run_id, "read_calendar", arguments.clone())
            .await
        {
            Ok(value) => value,
            Err(_) => return CalendarReadOutcome::text(CALENDAR_UNAVAILABLE),
        };
        match value["status"].as_str() {
            Some("approval_required") => {
                let elapsed = started.elapsed();
                if elapsed >= wait.timeout {
                    return CalendarReadOutcome::text(calendar_wait_text(
                        &value,
                        "timeoutMessage",
                        CALENDAR_APPROVAL_TIMEOUT,
                    ));
                }
                tokio::time::sleep(wait.interval.min(wait.timeout - elapsed)).await;
            }
            Some("declined") => {
                return CalendarReadOutcome::text(calendar_wait_text(
                    &value,
                    "message",
                    CALENDAR_DECLINED,
                ))
            }
            _ => {
                return CalendarReadOutcome {
                    disclosed: is_shared_calendar_data(&value),
                    content: value.to_string().into(),
                }
            }
        }
    }
}
