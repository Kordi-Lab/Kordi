use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tokio::task::JoinHandle;

use crate::scheduled_tasks::store::claim_due_scheduled_task_runs;
use crate::server::ServerState;

pub fn scheduled_task_sweep_interval() -> Duration {
    Duration::from_secs(
        std::env::var("KORDI_SCHEDULED_TASK_SWEEP_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (5..=3600).contains(value))
            .unwrap_or(30),
    )
}

pub fn spawn_scheduled_task_worker(state: Arc<ServerState>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(scheduled_task_sweep_interval());
        loop {
            interval.tick().await;
            match claim_due_scheduled_task_runs(state.db_pool(), Utc::now(), 25).await {
                Ok(runs) => {
                    for run in runs {
                        if run.status == "waiting_for_desktop" {
                            eprintln!("[scheduled_tasks] run {} waiting_for_desktop", run.run_id);
                        }
                    }
                }
                Err(err) => eprintln!("[scheduled_tasks] sweep due jobs: {err}"),
            }
        }
    })
}
