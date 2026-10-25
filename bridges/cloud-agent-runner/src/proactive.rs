//! Proactive evaluation runs: one model turn with no tools and no sandbox.
//! The system prompt is the run's own plus the owner's memory section for
//! this conversation; the server parses the reply and decides what happens.

use serde_json::json;

use crate::client::{CloudAgentRun, CloudAgentRunClient, RunnerClientError};
use crate::memory::{load_run_memory, memory_prompt_section};
use crate::model_loop::{CloudModelProvider, ModelProviderResponse, OpenAiProviderConfig};
use crate::runtime::{CloudModelEngine, RunnerStepOutcome};

pub const RUN_PREFIX: &str = "proactive_eval_";
const TIMEOUT_SECONDS: u64 = 180;

/// The run's system prompt with the memory section, when memory is on. The
/// run has no tools, so memories are read here and never saved. A Mac that
/// runs the evaluation gets the same prompt from the server's claim.
pub(crate) fn system_prompt(run: &CloudAgentRun, memory: &crate::memory::RunMemory) -> String {
    let section = memory_prompt_section(run, memory);
    kordi_tools::memory_prompt::tool_less_system_prompt(&run.system_prompt, section.as_deref())
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
    let memory = load_run_memory(client, run).await;
    let system_prompt = system_prompt(run, &memory);
    let text = match engine {
        CloudModelEngine::Omp => {
            auth.thinking = crate::common_ground::omp_thinking(&auth.thinking).to_string();
            let run = CloudAgentRun {
                system_prompt,
                ..run.clone()
            };
            let job = crate::omp_job::Job {
                run: &run,
                auth: &auth,
                prompt: run.prompt.clone(),
                messages: vec![],
                resume: false,
                tools: vec![],
                timeout_ms: (TIMEOUT_SECONDS - 10) * 1000,
            };
            crate::omp_job::run(job, &crate::common_ground::NoTools, &|_| async { Ok(()) })
                .await
                .map_err(|error| error.to_string())?
                .text
        }
        CloudModelEngine::Rust => {
            let messages = [
                json!({ "role": "system", "content": system_prompt }),
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
    Ok(text)
}

/// Runs one evaluation, keeping its lease alive while the model works. An
/// empty reply is submitted as is: the server reads it as silence.
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
            let text = if text.trim().is_empty() {
                "{\"decision\":\"silence\"}".to_string()
            } else {
                text
            };
            client.complete_run(&run.run_id, &text).await?;
            Ok(RunnerStepOutcome::Completed { run_id })
        }
        Err(detail) => {
            // The detail can quote provider errors, so only its length is logged.
            tracing::warn!(run_id = %run.run_id, detail_len = detail.len(), "proactive evaluation failed");
            client
                .fail_run(
                    &run.run_id,
                    "proactive_evaluation_failed",
                    "Proactive evaluation failed.",
                )
                .await?;
            Ok(RunnerStepOutcome::FailedProviderError { run_id })
        }
    }
}
