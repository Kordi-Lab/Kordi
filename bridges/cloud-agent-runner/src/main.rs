use std::time::Duration;

use anyhow::{Context, Result};
use kordi_cloud_agent_runner::client::HttpCloudAgentRunClient;
use kordi_cloud_agent_runner::config::canary_idle_enabled;
use kordi_cloud_agent_runner::runtime::{process_one_run, RunnerStepOutcome};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let base_url =
        std::env::var("KORDI_CLOUD_API_BASE").context("KORDI_CLOUD_API_BASE is required")?;
    let runner_token = std::env::var("KORDI_CLOUD_RUNNER_TOKEN")
        .context("KORDI_CLOUD_RUNNER_TOKEN is required")?;
    let runner_id = std::env::var("KORDI_CLOUD_RUNNER_ID")
        .unwrap_or_else(|_| format!("runner-{}", uuid::Uuid::new_v4().simple()));
    let poll_ms = std::env::var("KORDI_CLOUD_RUNNER_POLL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 100)
        .unwrap_or(2_000);

    if canary_idle_enabled(
        std::env::var("KORDI_CLOUD_RUNNER_CANARY_IDLE")
            .ok()
            .as_deref(),
    ) {
        tracing::info!(
            runner_id,
            "cloud agent runner canary idle mode enabled; not polling for runs"
        );
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }

    let canary_run_id = std::env::var("KORDI_CLOUD_RUNNER_CANARY_RUN_ID").ok();
    let client = HttpCloudAgentRunClient::with_canary_run_id(
        base_url,
        runner_token,
        runner_id.clone(),
        canary_run_id.clone(),
    );
    tracing::info!(
        runner_id,
        poll_ms,
        canary_run_id,
        "starting kordi cloud agent runner"
    );

    let mut workers = tokio::task::JoinSet::new();
    let mut poll = tokio::time::interval(Duration::from_millis(poll_ms));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            Some(result) = workers.join_next(), if !workers.is_empty() => match result {
                Ok(Ok(RunnerStepOutcome::NoRun)) => {},
                Ok(Ok(_)) => tracing::info!("cloud agent run finished"),
                _ => tracing::warn!("cloud agent runner step failed"),
            },
            _ = poll.tick(), if workers.len() < 4 => {
                let execution = client.for_execution();
                workers.spawn(async move { process_one_run(&execution).await });
            },
        }
    }
}
