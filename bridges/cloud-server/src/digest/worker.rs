use crate::server::ServerState;
use sqlx_core::query_as::query_as;
use std::sync::Arc;

/// Digests the worker reruns now, binding the quiet window, the maximum wait
/// and the safety check in minutes. A digest reruns when a change that
/// matters arrived and both the owner and their contacts have been quiet for
/// a while (or the maximum wait passed), when it was never built and has not
/// failed (a missing provider key would otherwise be retried every 30
/// seconds), or on the slow safety check. These runs stay within the caps on
/// automatic runs; pressing refresh runs at once.
pub(crate) const DUE: &str = "retry_after<=now() AND active_run_id IS NULL AND (
    (snapshot_json IS NULL AND error_code IS NULL)
    OR (dirty_since IS NOT NULL AND (
        (last_change_at <= now() - make_interval(mins => $1)
            AND (owner_active_at IS NULL OR owner_active_at <= now() - make_interval(mins => $1)))
        OR dirty_since <= now() - make_interval(mins => $2)))
    OR checked_at <= now() - make_interval(mins => $3))";

pub fn spawn(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let accounts: Result<Vec<(String,)>, _> = query_as(&format!(
                "UPDATE cloud_account_digests SET checked_at=now() WHERE account_id IN (
                    SELECT account_id FROM cloud_account_digests WHERE {DUE}
                    ORDER BY checked_at LIMIT 20)
                 RETURNING account_id"
            ))
            .bind(super::changes::QUIET_WINDOW_MINUTES as i32)
            .bind(super::changes::MAX_WAIT_MINUTES as i32)
            .bind(super::changes::SAFETY_CHECK_MINUTES as i32)
            .fetch_all(state.db_pool())
            .await;
            // Marked messages that may be urgent get their quick check once
            // a burst has settled.
            let urgent: Result<Vec<(String,)>, _> = query_as(
                "SELECT account_id FROM cloud_account_digests
                 WHERE urgent_since <= now() - make_interval(secs => $1)
                   AND active_run_id IS NULL AND retry_after <= now()
                 ORDER BY urgent_since LIMIT 20",
            )
            .bind(super::urgent::SETTLE_SECONDS as f64)
            .fetch_all(state.db_pool())
            .await;
            for (account,) in urgent.unwrap_or_default() {
                if super::urgent::start(state.db_pool(), &account)
                    .await
                    .is_err()
                {
                    tracing_failure();
                }
            }
            if let Ok(accounts) = accounts {
                for (account,) in accounts {
                    if super::store::refresh_as(
                        state.db_pool(),
                        &account,
                        super::store::Trigger::Automatic,
                    )
                    .await
                    .is_err()
                    {
                        tracing_failure();
                    }
                }
            }
        }
    })
}
fn tracing_failure() {
    eprintln!("[digest] Background refresh failed; retrying on the next sweep.");
}
