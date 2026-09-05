use crate::server::ServerState;
use sqlx_core::query_as::query_as;
use std::sync::Arc;

pub fn spawn(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let accounts:Result<Vec<(String,)>,_>=query_as("UPDATE cloud_account_digests SET checked_at=now() WHERE account_id IN (SELECT account_id FROM cloud_account_digests WHERE retry_after<=now() AND active_run_id IS NULL ORDER BY checked_at LIMIT 20) RETURNING account_id").fetch_all(state.db_pool()).await;
            if let Ok(accounts) = accounts {
                for (account,) in accounts {
                    if super::store::refresh(state.db_pool(), &account, false)
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
