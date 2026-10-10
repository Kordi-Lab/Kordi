//! OMP driver for sandbox-free jobs. Hosts supply only their admitted tools.

use kordi_omp_runtime::{
    AuthConfig, AuthKind, Capabilities, EventSink, HostTool, ModelConfig, OmpRuntime, Prompt,
    RunLimits, RunRequest, RunResult, RuntimeError, ToolDefinition, WorkerCommand,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::client::CloudAgentRun;
use crate::model_loop::omp::{api_for_provider, omp_provider};
use crate::model_loop::{OpenAiApiMode, OpenAiProviderConfig};

pub(crate) struct Job<'a> {
    pub run: &'a CloudAgentRun,
    pub auth: &'a OpenAiProviderConfig,
    pub prompt: String,
    pub messages: Vec<Value>,
    pub resume: bool,
    pub tools: Vec<Value>,
    pub timeout_ms: u64,
    pub max_steps: usize,
    pub max_tool_calls: usize,
}

pub(crate) fn worker_command() -> Result<WorkerCommand, RuntimeError> {
    let path = std::env::var_os("KORDI_OMP_WORKER_ENTRY")
        .filter(|path| !path.is_empty())
        .ok_or(RuntimeError::Spawn)?;
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute() {
        return Err(RuntimeError::InvalidRequest);
    }
    Ok(WorkerCommand::sidecar(path))
}

impl Job<'_> {
    fn request(self) -> Result<RunRequest, RuntimeError> {
        let tools = self
            .tools
            .into_iter()
            .map(|tool| {
                let function = &tool["function"];
                Ok(ToolDefinition {
                    name: function["name"]
                        .as_str()
                        .ok_or(RuntimeError::InvalidRequest)?
                        .into(),
                    description: function["description"].as_str().unwrap_or_default().into(),
                    input_schema: function["parameters"].clone(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut headers = std::collections::BTreeMap::new();
        if let Some(account_id) = &self.auth.account_id {
            headers.insert("ChatGPT-Account-ID".into(), account_id.clone());
        }
        Ok(RunRequest {
            run_id: self.run.run_id.clone(),
            request_id: self.run.run_id.clone(),
            attempt_id: uuid::Uuid::new_v4().to_string(),
            session_id: self.run.session_id.clone(),
            model: ModelConfig {
                provider: omp_provider(self.auth).into(),
                id: self.auth.model.clone(),
                api: Some(api_for_provider(self.auth).into()),
                base_url: Some(self.auth.base_url.clone()),
                context_window: None,
                max_tokens: None,
            },
            auth: AuthConfig {
                kind: if self.auth.api_mode == OpenAiApiMode::ChatCompletions {
                    AuthKind::ApiKey
                } else {
                    AuthKind::Oauth
                },
                credential: Some(self.auth.api_key.clone()),
                headers: (!headers.is_empty()).then_some(headers),
            },
            thinking: Some(self.auth.thinking.clone()),
            system_prompt: self.run.system_prompt.clone(),
            messages: self.messages,
            message_entry_ids: None,
            prompt: Prompt {
                text: self.prompt,
                resume: self.resume,
                ..Prompt::default()
            },
            cwd: "/tmp".into(),
            tools,
            hooks: vec![],
            capabilities: Capabilities::default(),
            compaction: None,
            limits: RunLimits {
                timeout_ms: self.timeout_ms,
                max_output_bytes: 16 * 1024 * 1024,
                max_steps: self.max_steps,
                max_tool_calls: self.max_tool_calls,
            },
        })
    }
}

pub(crate) async fn run<H: HostTool, E: EventSink>(
    job: Job<'_>,
    host: &H,
    events: &E,
) -> Result<RunResult, RuntimeError> {
    let runtime = crate::omp_pool::shared_runtime(worker_command()?);
    run_on(job, host, events, &runtime).await
}

#[cfg(test)]
async fn run_with_worker<H: HostTool, E: EventSink>(
    job: Job<'_>,
    host: &H,
    events: &E,
    worker: WorkerCommand,
) -> Result<RunResult, RuntimeError> {
    run_on(job, host, events, &OmpRuntime::new(worker)).await
}

async fn run_on<H: HostTool, E: EventSink>(
    job: Job<'_>,
    host: &H,
    events: &E,
    runtime: &OmpRuntime,
) -> Result<RunResult, RuntimeError> {
    let request = job.request()?;
    runtime
        .run_turn(&request, host, events, CancellationToken::new())
        .await
}

#[cfg(test)]
mod tests;

pub(crate) fn tool_result(value: Value) -> kordi_omp_runtime::ToolResult {
    kordi_omp_runtime::ToolResult {
        ok: value.get("error").is_none(),
        content: vec![serde_json::json!({"type":"text", "text":value.to_string()})],
        details: None,
    }
}
