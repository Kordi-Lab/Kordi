//! Background upkeep of pool bookkeeping.

use std::sync::Arc;

use super::store;
use crate::resource_pools::Executor;
use crate::server::ServerState;

const MAINTENANCE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
/// About once a minute.
const SETTLE_EVERY_TICKS: u32 = 12;
/// About once an hour.
const PRUNE_EVERY_TICKS: u32 = 720;

/// Keeps pool bookkeeping current whether or not the System agent's group
/// chat runs: pool worker runs that can no longer finish end within seconds
/// (about once a minute while no pool has a worker), runs that ended by
/// another path settle their usage about once a minute, and old usage is
/// pruned about once an hour.
pub fn spawn_maintenance(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if state.system_agent().is_none() {
            return;
        }
        let mut timer = tokio::time::interval(MAINTENANCE_INTERVAL);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut ticks: u32 = 0;
        loop {
            timer.tick().await;
            ticks = ticks.wrapping_add(1);
            maintain(&state, ticks).await;
        }
    })
}

/// One maintenance pass; `ticks` counts passes.
pub async fn maintain(state: &ServerState, ticks: u32) {
    let Some(system_agent) = state.system_agent() else {
        return;
    };
    let pools = system_agent.config().resource_pools();
    let db = state.db_pool();
    let any_worker = pools
        .pools()
        .iter()
        .any(|pool| pool.executor() == Executor::PoolWorker);
    if any_worker || ticks.is_multiple_of(SETTLE_EVERY_TICKS) {
        if let Err(error) = store::expire(db, &pools).await {
            eprintln!("[pool-workers] Expiring runs failed: {error}");
        }
    }
    if ticks.is_multiple_of(SETTLE_EVERY_TICKS) {
        if let Err(error) = crate::resource_pools::usage::settle_ended_runs(db).await {
            eprintln!("[resource-pools] Settlement failed: {error}");
        }
    }
    if ticks.is_multiple_of(PRUNE_EVERY_TICKS) {
        if let Err(error) = crate::resource_pools::usage::prune(db).await {
            eprintln!("[resource-pools] Usage pruning failed: {error}");
        }
    }
}
