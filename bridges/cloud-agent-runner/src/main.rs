use std::time::Duration;

use anyhow::{Context, Result};
use kordi_cloud_agent_runner::client::HttpCloudAgentRunClient;
use kordi_cloud_agent_runner::runtime::{process_one_run, RunnerStepOutcome};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

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

    let client = HttpCloudAgentRunClient::new(base_url, runner_token, runner_id.clone());
    tracing::info!(runner_id, poll_ms, "starting kordi cloud agent runner");

    loop {
        match process_one_run(&client).await {
            Ok(RunnerStepOutcome::NoRun) => {}
            Ok(outcome) => tracing::info!(?outcome, "processed cloud agent run"),
            Err(err) => tracing::warn!(error = %err, "cloud agent runner step failed"),
        }
        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
    }
}
