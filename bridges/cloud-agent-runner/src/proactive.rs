//! Proactive evaluation runs: one model turn with no sandbox whose only tool
//! is `search_memory`, answered by the server for the run's lease
//! (docs/development/proactive-agent.md). Proactive runs get no preloaded
//! memory section ([`crate::memory::memory_prompt_section`]); they search
//! for what they need. The server parses the reply and decides what happens.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{json, Value};

use crate::client::{CloudAgentRun, CloudAgentRunClient, RunnerClientError};
use crate::model_loop::{
    CloudModelProvider, ModelProviderResponse, ModelToolCall, OpenAiProviderConfig,
};
use crate::runtime::{CloudModelEngine, RunnerStepOutcome};

pub const RUN_PREFIX: &str = "proactive_eval_";
/// Personal agent evaluations (docs/development/personal-agent.md) run the
/// same single turn; the server reads `share` or `skip` from the reply.
pub const PERSONAL_AGENT_RUN_PREFIX: &str = "personal_agent_eval_";
/// Runs the owner allowed. They search memories like an evaluation.
pub const APPROVED_RUN_PREFIX: &str = "proactive_run_";

/// Whether `run_id` is an evaluation this module runs.
pub fn is_evaluation(run_id: &str) -> bool {
    run_id.starts_with(RUN_PREFIX) || run_id.starts_with(PERSONAL_AGENT_RUN_PREFIX)
}
/// The server's memory search tool on a proactive run's lease.
pub const SEARCH_MEMORY_TOOL: &str = "search_memory";
/// Searches an evaluation may make before it must answer.
pub(crate) const MAX_SEARCHES: usize = 3;
/// Model requests of the Rust engine's turn: one per search, one more whose
/// calls are told that no searches are left, and the answer.
const MAX_REQUESTS: usize = MAX_SEARCHES + 2;
const TIMEOUT_SECONDS: u64 = 180;

/// The evaluation's tools: `search_memory` when the lease carries it, and
/// nothing else.
pub(crate) fn evaluation_tools(run: &CloudAgentRun) -> Vec<Value> {
    crate::connectors::tool_definitions(run)
        .into_iter()
        .filter(|tool| tool["function"]["name"] == SEARCH_MEMORY_TOOL)
        .collect()
}

/// Answers one tool call of the evaluation. Every call counts towards
/// [`MAX_SEARCHES`]; the server answers the searches.
async fn search<C: CloudAgentRunClient + Sync>(
    client: &C,
    run: &CloudAgentRun,
    name: &str,
    arguments: Value,
    searches: &AtomicUsize,
) -> Value {
    if searches.fetch_add(1, Ordering::Relaxed) >= MAX_SEARCHES {
        return json!({"error": "No searches are left in this run. Answer with what you have."});
    }
    let Some(tool) = run
        .connectors
        .descriptor(SEARCH_MEMORY_TOOL)
        .filter(|_| name == SEARCH_MEMORY_TOOL)
    else {
        return json!({"error": "Only search_memory is available in this run."});
    };
    client
        .call_connector_tool(&run.run_id, tool, arguments)
        .await
        .unwrap_or_else(|error| json!({"error": format!("The memory search failed: {error}")}))
}

struct SearchTools<'a, C> {
    client: &'a C,
    run: &'a CloudAgentRun,
    searches: AtomicUsize,
}

#[async_trait::async_trait]
impl<C: CloudAgentRunClient + Sync> kordi_omp_runtime::HostTool for SearchTools<'_, C> {
    async fn execute(
        &self,
        call: kordi_omp_runtime::ToolCall,
        _: tokio_util::sync::CancellationToken,
    ) -> kordi_omp_runtime::ToolResult {
        let value = search(
            self.client,
            self.run,
            &call.name,
            call.input,
            &self.searches,
        )
        .await;
        crate::omp_job::tool_result(value)
    }
}

/// The Rust engine's turn: up to [`MAX_SEARCHES`] searches, then calls are
/// answered with the line that asks for the answer. Every request offers the
/// tools: a provider refuses a request whose history holds tool calls but
/// defines no tools. A model that still calls tools after
/// [`MAX_REQUESTS`] requests fails the evaluation.
async fn generate_rust<C, P>(
    client: &C,
    provider: &P,
    auth: &OpenAiProviderConfig,
    run: &CloudAgentRun,
) -> Result<String, String>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let tools = evaluation_tools(run);
    let searches = AtomicUsize::new(0);
    let mut messages = vec![
        json!({ "role": "system", "content": run.system_prompt.trim() }),
        json!({ "role": "user", "content": run.prompt }),
    ];
    for _ in 0..MAX_REQUESTS {
        match provider.next_response(auth, &messages, &tools).await {
            Ok(ModelProviderResponse::FinalText(text)) => return Ok(text),
            Ok(ModelProviderResponse::ToolCalls(calls))
                if !tools.is_empty() && !calls.is_empty() =>
            {
                for ModelToolCall {
                    id,
                    name,
                    arguments,
                } in calls
                {
                    messages.push(
                        json!({"role": "assistant", "tool_calls": [{"id": id, "type": "function",
                        "function": {"name": name, "arguments": arguments.to_string()}}]}),
                    );
                    let result = search(client, run, &name, arguments, &searches).await;
                    messages.push(json!({"role": "tool", "tool_call_id": id, "name": name,
                        "content": result.to_string()}));
                }
            }
            Ok(ModelProviderResponse::ToolCalls(_)) => return Err("unexpected tool call".into()),
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("the evaluation kept searching instead of answering".into())
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
    match engine {
        CloudModelEngine::Omp => {
            auth.thinking = crate::common_ground::omp_thinking(&auth.thinking).to_string();
            let job = crate::omp_job::Job {
                run,
                auth: &auth,
                prompt: run.prompt.clone(),
                messages: vec![],
                resume: false,
                tools: evaluation_tools(run),
                timeout_ms: (TIMEOUT_SECONDS - 10) * 1000,
            };
            let host = SearchTools {
                client,
                run,
                searches: AtomicUsize::new(0),
            };
            Ok(crate::omp_job::run(job, &host, &|_| async { Ok(()) })
                .await
                .map_err(|error| error.to_string())?
                .text)
        }
        CloudModelEngine::Rust => generate_rust(client, provider, &auth, run).await,
    }
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
