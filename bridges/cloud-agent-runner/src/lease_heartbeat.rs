//! Renewable ownership for long-running Cloud agent model work.

use std::{future::Future, time::Duration};

use crate::client::{CloudAgentRun, CloudAgentRunClient, ProviderAuthMaterial, RunnerClientError};
use crate::model_loop::{run_model_loop, CloudModelProvider, ModelLoopError};
use crate::sandbox_client::SandboxBackendHandle;

const RUN_LEASE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

pub(crate) async fn run_with_heartbeat<C, P>(
    client: &C,
    provider: &P,
    run: &CloudAgentRun,
    sandbox: &SandboxBackendHandle,
    auth_material: ProviderAuthMaterial,
) -> Result<Result<String, ModelLoopError>, RunnerClientError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    run_with_lease_heartbeat_at_interval(
        || client.mark_running(&run.run_id),
        RUN_LEASE_HEARTBEAT_INTERVAL,
        run_model_loop(client, provider, run, sandbox, auth_material),
    )
    .await
}

async fn run_with_lease_heartbeat_at_interval<R, RF, F, T>(
    mut renew: R,
    heartbeat_interval: Duration,
    work: F,
) -> Result<T, RunnerClientError>
where
    R: FnMut() -> RF,
    RF: Future<Output = Result<(), RunnerClientError>>,
    F: Future<Output = T>,
{
    tokio::pin!(work);
    let first_heartbeat = tokio::time::Instant::now() + heartbeat_interval;
    let mut heartbeat = tokio::time::interval_at(first_heartbeat, heartbeat_interval);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            output = &mut work => return Ok(output),
            _ = heartbeat.tick() => renew().await?,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use super::*;

    #[tokio::test]
    async fn long_model_work_renews_the_running_lease_until_it_finishes() {
        let renewals = Arc::new(AtomicUsize::new(0));
        let completed = run_with_lease_heartbeat_at_interval(
            {
                let renewals = Arc::clone(&renewals);
                move || {
                    let renewals = Arc::clone(&renewals);
                    async move {
                        renewals.fetch_add(1, Ordering::Relaxed);
                        Ok(())
                    }
                }
            },
            Duration::from_millis(10),
            async {
                tokio::time::sleep(Duration::from_millis(25)).await;
                "finished"
            },
        )
        .await
        .unwrap();

        assert_eq!(completed, "finished");
        assert_eq!(renewals.load(Ordering::Relaxed), 2);
    }
}
