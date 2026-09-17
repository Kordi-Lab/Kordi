use std::sync::Arc;

use crate::server::ServerState;

const SWEEP_INTERVAL_SECS: u64 = 5;
const STALE_CHECK_EVERY_TICKS: u32 = 12;

/// Sweeps PiP's conversations on a fixed interval. Only changed inputs or a
/// due reminder queue a run, so an idle server issues no model calls.
pub fn spawn(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let Some(pip) = state.pip().cloned() else {
            return;
        };
        let config = pip.config().clone();
        let mut timer = tokio::time::interval(std::time::Duration::from_secs(SWEEP_INTERVAL_SECS));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut ticks: u32 = 0;
        loop {
            timer.tick().await;
            ticks = ticks.wrapping_add(1);
            if ticks.is_multiple_of(STALE_CHECK_EVERY_TICKS) {
                if let Err(error) = super::store::release_stale_runs(state.db_pool()).await {
                    eprintln!("[pip] Stale run check failed: {error}");
                }
            }
            if let Err(error) = super::store::sweep(state.db_pool(), &config).await {
                eprintln!("[pip] Sweep failed; retrying on the next tick: {error}");
            }
        }
    })
}
