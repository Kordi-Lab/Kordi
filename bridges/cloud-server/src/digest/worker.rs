use crate::server::ServerState;
use sqlx_core::query_as::query_as;
use std::sync::Arc;

pub fn spawn(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            // A digest reruns when its chats changed and have been quiet for
            // a while (or the maximum wait passed), when it was never built,
            // or on the slow safety check. Opening the digest or pressing
            // refresh runs it at once through the routes instead.
            let accounts: Result<Vec<(String,)>, _> = query_as(
                "UPDATE cloud_account_digests SET checked_at=now() WHERE account_id IN (
                    SELECT account_id FROM cloud_account_digests
                    WHERE retry_after<=now() AND active_run_id IS NULL AND (
                        snapshot_json IS NULL
                        OR (dirty_since IS NOT NULL AND (
                            last_change_at <= now() - make_interval(mins => $1)
                            OR dirty_since <= now() - make_interval(mins => $2)))
                        OR checked_at <= now() - make_interval(mins => $3))
                    ORDER BY checked_at LIMIT 20)
                 RETURNING account_id",
            )
            .bind(super::changes::QUIET_WINDOW_MINUTES as i32)
            .bind(super::changes::MAX_WAIT_MINUTES as i32)
            .bind(super::changes::SAFETY_CHECK_MINUTES as i32)
            .fetch_all(state.db_pool())
            .await;
            if let Ok(accounts) = accounts {
                for (account,) in accounts {
                    if super::store::refresh(state.db_pool(), &account)
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
