use std::sync::Arc;

use crate::server::ServerState;

const STALE_CHECK_EVERY_TICKS: u32 = 12;

/// Sweeps the watched groups on a fixed interval, moves proposals along with
/// their runs, and expires stale ones. Only new collaborator messages that
/// pass the free check queue a run, so an idle server issues no model calls.
pub fn spawn(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    super::push::install(state.notifications());
    tokio::spawn(async move {
        let config = super::ProactiveConfig::from_env();
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(config.sweep_seconds));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut ticks: u32 = 0;
        loop {
            timer.tick().await;
            ticks = ticks.wrapping_add(1);
            let pool = state.db_pool();
            if ticks.is_multiple_of(STALE_CHECK_EVERY_TICKS) {
                if let Err(error) = super::release_stale_runs(pool).await {
                    eprintln!("[proactive] Stale run check failed: {error}");
                }
            }
            if let Err(error) = super::sync_runs(pool, None).await {
                eprintln!("[proactive] Proposal sync failed: {error}");
            }
            if let Err(error) = super::sweep(pool, &config).await {
                eprintln!("[proactive] Sweep failed; retrying on the next tick: {error}");
            }
        }
    })
}
