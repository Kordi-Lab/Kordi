//! Common ground runs (card builds, matching, room themes): one completion
//! with no tools and no sandbox.
//! The prompt holds redacted evidence or shared cards; the server parses the reply.

use serde_json::json;

use crate::client::{CloudAgentRun, CloudAgentRunClient, RunnerClientError};
use crate::model_loop::{CloudModelProvider, ModelProviderResponse, OpenAiProviderConfig};
use crate::runtime::{CloudModelEngine, RunnerStepOutcome};

pub const RUN_PREFIX: &str = "cg_";
const TIMEOUT_SECONDS: u64 = 180;

struct NoTools;

#[async_trait::async_trait]
impl kordi_omp_runtime::HostTool for NoTools {
    async fn execute(
        &self,
        _: kordi_omp_runtime::ToolCall,
        _: tokio_util::sync::CancellationToken,
    ) -> kordi_omp_runtime::ToolResult {
        crate::omp_job::tool_result(json!({ "error": "No tools are available." }))
    }
}

async fn generate<C, P>(
    client: &C,
    provider: &P,
    engine: CloudModelEngine,
    run: &CloudAgentRun,
) -> Result<String, String>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let material = client
        .fetch_provider_auth(&run.run_id)
        .await
        .map_err(|error| error.to_string())?;
    let mut auth = OpenAiProviderConfig::from_material(&material).map_err(|e| e.to_string())?;
    auth.apply_runtime_route(&run.runtime_route, &material.provider)
        .map_err(|error| error.to_string())?;
    let text = match engine {
        CloudModelEngine::Omp => {
            let job = crate::omp_job::Job {
                run,
                auth: &auth,
                prompt: run.prompt.clone(),
                messages: vec![],
                resume: false,
                tools: vec![],
                timeout_ms: (TIMEOUT_SECONDS - 10) * 1000,
            };
            crate::omp_job::run(job, &NoTools, &|_| async { Ok(()) })
                .await
                .map_err(|error| error.to_string())?
                .text
        }
        CloudModelEngine::Rust => {
            let messages = [
                json!({ "role": "system", "content": run.system_prompt }),
                json!({ "role": "user", "content": run.prompt }),
            ];
            match provider.next_response(&auth, &messages, &[]).await {
                Ok(ModelProviderResponse::FinalText(text)) => text,
                Ok(ModelProviderResponse::ToolCalls(_)) => {
                    return Err("unexpected tool call".into())
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    };
    if text.trim().is_empty() {
        return Err("the model finished without writing a card".into());
    }
    Ok(text)
}

/// Runs one card build, keeping its lease alive while the model works.
pub(crate) async fn step<C, P>(
    client: &C,
    provider: &P,
    engine: CloudModelEngine,
    run: CloudAgentRun,
) -> Result<RunnerStepOutcome, RunnerClientError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let run_id = run.run_id.clone();
    let generation = generate(client, provider, engine, &run);
    tokio::pin!(generation);
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(40));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    heartbeat.tick().await;
    let response = tokio::time::timeout(std::time::Duration::from_secs(TIMEOUT_SECONDS), async {
        loop {
            tokio::select! {
                result = &mut generation => break Ok::<_, RunnerClientError>(result),
                _ = heartbeat.tick() => client.mark_running(&run.run_id).await?,
            }
        }
    })
    .await
    .unwrap_or(Ok(Err("timed out".into())))?;
    match response {
        Ok(text) => {
            client.complete_run(&run.run_id, &text).await?;
            Ok(RunnerStepOutcome::Completed { run_id })
        }
        Err(detail) => {
            // The detail can quote provider errors, so only its length is logged.
            tracing::warn!(run_id = %run.run_id, detail_len = detail.len(), "common ground run failed");
            client
                .fail_run(
                    &run.run_id,
                    "common_ground_run_failed",
                    "Common ground run failed.",
                )
                .await?;
            Ok(RunnerStepOutcome::FailedProviderError { run_id })
        }
    }
}
