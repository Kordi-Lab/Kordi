use async_trait::async_trait;
use kordi_omp_runtime::{
    AuthConfig, AuthKind, Capabilities, EventSink, HostTool, ModelConfig, OmpRuntime, Prompt,
    RunLimits, RunRequest, RuntimeEvent, ToolCall, ToolDefinition, ToolResult, WorkerCommand,
};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::client::{CloudAgentRun, CloudAgentRunClient, OmpState, ProviderAuthMaterial};
use crate::memory::{load_run_memory, memory_prompt_section, RunMemory};
use crate::sandbox_client::SandboxBackendHandle;
use crate::tools::CloudToolExecutor;

use super::provider::OpenAiApiMode;
use super::{
    cloud_sandbox_system_prompt, execute_model_tool, run_tool_catalog, ModelLoopError,
    ModelToolCall, OpenAiProviderConfig, MAX_MODEL_CALLS, MAX_TOOL_CALLS,
};

pub async fn run_omp_model_loop<C: CloudAgentRunClient + Sync>(
    client: &C,
    run: &CloudAgentRun,
    sandbox: &SandboxBackendHandle,
    auth_material: ProviderAuthMaterial,
) -> Result<(String, OmpState), ModelLoopError> {
    let mut auth = OpenAiProviderConfig::from_material(&auth_material)?;
    auth.apply_runtime_route(&run.runtime_route, &auth_material.provider)?;
    let omp_provider = omp_provider(&auth).to_string();
    let context = client
        .fetch_omp_context(
            &run.run_id,
            &omp_provider,
            &auth.model,
            &auth_material.snapshot_id,
        )
        .await?;
    let messages = normalize_omp_context(run, context.messages)?;
    let worker_path = std::env::var_os("KORDI_OMP_WORKER_ENTRY")
        .filter(|path| !path.is_empty())
        .ok_or_else(|| ModelLoopError::Provider("OMP worker path is not configured".into()))?;
    let worker_path = std::path::PathBuf::from(worker_path);
    if !worker_path.is_absolute() {
        return Err(ModelLoopError::Provider(
            "OMP worker path must be absolute".into(),
        ));
    }
    run_omp_with_config(
        client,
        run,
        sandbox,
        OmpTurnConfig {
            snapshot_id: auth_material.snapshot_id,
            auth,
            worker: crate::omp_pool::shared_runtime(WorkerCommand::sidecar(worker_path)),
            prompt: context.prompt,
            messages,
        },
    )
    .await
}

struct OmpTurnConfig {
    snapshot_id: String,
    auth: OpenAiProviderConfig,
    worker: OmpRuntime,
    prompt: String,
    messages: Vec<Value>,
}

async fn run_omp_with_config<C: CloudAgentRunClient + Sync>(
    client: &C,
    run: &CloudAgentRun,
    sandbox: &SandboxBackendHandle,
    config: OmpTurnConfig,
) -> Result<(String, OmpState), ModelLoopError> {
    let OmpTurnConfig {
        snapshot_id,
        auth,
        worker,
        prompt,
        messages,
    } = config;
    let memory = load_run_memory(client, run).await;
    let tools = tools_for_run(run, &memory)?;
    let mut system_prompt = system_prompt_for_run(run)?;
    if let Some(section) = memory_prompt_section(run, &memory) {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&section);
    }
    let mut headers = std::collections::BTreeMap::new();
    if let Some(account_id) = &auth.account_id {
        headers.insert("ChatGPT-Account-ID".to_string(), account_id.clone());
    }
    let request = RunRequest {
        run_id: run.run_id.clone(),
        request_id: run.run_id.clone(),
        attempt_id: uuid::Uuid::new_v4().to_string(),
        session_id: run.session_id.clone(),
        model: ModelConfig {
            provider: omp_provider(&auth).to_string(),
            id: auth.model.clone(),
            api: Some(api_for_provider(&auth).to_string()),
            base_url: Some(auth.base_url.clone()),
            context_window: None,
            max_tokens: None,
        },
        auth: AuthConfig {
            kind: if auth.api_mode == OpenAiApiMode::ChatCompletions {
                AuthKind::ApiKey
            } else {
                AuthKind::Oauth
            },
            credential: Some(auth.api_key),
            headers: (!headers.is_empty()).then_some(headers),
        },
        thinking: Some(auth.thinking),
        system_prompt,
        messages,
        message_entry_ids: None,
        prompt: Prompt {
            text: prompt,
            resume: false,
            entry_id: None,
            images: Vec::new(),
            trailing_messages: Vec::new(),
        },
        cwd: "/tmp".into(),
        tools,
        hooks: vec![],
        limits: RunLimits {
            timeout_ms: 590_000,
            max_output_bytes: 16 * 1024 * 1024,
            max_tool_calls: MAX_TOOL_CALLS,
            max_steps: MAX_MODEL_CALLS,
        },
        compaction: None,
        // Cloud never gains owner-device computer/browser capabilities.
        capabilities: Capabilities::default(),
    };
    let executor = CloudToolExecutor::new(sandbox.clone()).with_memory(memory.enabled);
    let host = CloudOmpTools {
        client,
        executor,
        sandbox,
        run,
    };
    let result = worker
        .run_turn(
            &request,
            &host,
            &CloudRunStatusSink,
            CancellationToken::new(),
        )
        .await
        .map_err(|error| ModelLoopError::Provider(error.to_string()))?;
    if result.context_messages.is_empty() {
        return Err(ModelLoopError::Provider(
            "OMP worker returned no durable context".into(),
        ));
    }
    let state = OmpState {
        schema_version: 1,
        provider: request.model.provider,
        model: request.model.id,
        auth_snapshot_id: snapshot_id,
        messages: result.context_messages,
        replayable: output_is_replayable(&result.messages),
        checkpoint: result.checkpoint.map(|checkpoint| {
            serde_json::to_value(checkpoint).expect("checkpoint is serializable")
        }),
    };
    Ok((result.text, state))
}

fn output_is_replayable(messages: &[Value]) -> bool {
    messages
        .iter()
        .filter(|message| message["role"] == "toolResult")
        .all(|message| {
            matches!(
                message
                    .get("tool_name")
                    .or_else(|| message.get("toolName"))
                    .and_then(Value::as_str),
                Some(
                    "read"
                        | "write"
                        | "edit"
                        | "ls"
                        | "find"
                        | "grep"
                        | "bash"
                        | "web_search"
                        | "web_fetch"
                        | "export_artifact"
                )
            )
        })
}

pub(crate) fn api_for_provider(auth: &OpenAiProviderConfig) -> &'static str {
    match auth.api_mode {
        OpenAiApiMode::CodexOAuth => "openai-codex-responses",
        OpenAiApiMode::AnthropicOAuth => "anthropic-messages",
        OpenAiApiMode::ChatCompletions if auth.provider == "anthropic" => "anthropic-messages",
        OpenAiApiMode::ChatCompletions if auth.provider == "google" => "google-generative-ai",
        OpenAiApiMode::ChatCompletions => "openai-completions",
    }
}

pub(crate) fn omp_provider(auth: &OpenAiProviderConfig) -> &str {
    if auth.api_mode == OpenAiApiMode::CodexOAuth {
        "openai-codex"
    } else {
        &auth.provider
    }
}

fn tools_for_run(
    run: &CloudAgentRun,
    memory: &RunMemory,
) -> Result<Vec<ToolDefinition>, ModelLoopError> {
    run_tool_catalog(run, memory)
        .into_iter()
        .map(|tool| {
            let function = &tool["function"];
            Ok(ToolDefinition {
                name: function["name"]
                    .as_str()
                    .ok_or_else(|| ModelLoopError::Provider("Invalid cloud tool name".into()))?
                    .into(),
                description: function["description"].as_str().unwrap_or_default().into(),
                input_schema: function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({"type":"object"})),
            })
        })
        .collect()
}

fn system_prompt_for_run(run: &CloudAgentRun) -> Result<String, ModelLoopError> {
    if let Some(identity) = &run.turn_identity {
        if identity.owner_account_id != run.owner_account_id
            || identity.requester_account_id != run.requester_account_id
        {
            return Err(ModelLoopError::Provider(
                "Runtime identity does not match the admitted run".into(),
            ));
        }
    }
    let mut system_prompt = [run.system_prompt.trim(), cloud_sandbox_system_prompt()]
        .into_iter()
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if run.subsession_id.is_none()
        && (run.session_id.starts_with("session:group:")
            || run.session_id.starts_with("session:direct-person:"))
    {
        system_prompt.push_str("\n\nYou are participating in a shared conversation. Keep brief answers, clarifications, and immediate user decisions in this conversation. For self-contained extended research or multi-step work, use task_operator action=spawn before starting heavy work, unless the user explicitly asks to keep the work inline. Supply a concise taskTitle, a self-contained message and forkTurns=none. After successful creation, give a short task-specific acknowledgement and end this parent turn. The subsession owns progress and the final result; do not wait for or repeat them here. Never create a conversation channel or an ordinary message thread.");
    }
    if let Some(section) = crate::connectors::prompt_section(run) {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&section);
    }
    if let Some(identity) = &run.turn_identity {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(&identity.prompt());
    }
    Ok(system_prompt)
}

fn normalize_omp_context(
    run: &CloudAgentRun,
    messages: Vec<Value>,
) -> Result<Vec<Value>, ModelLoopError> {
    let mut normalized = Vec::with_capacity(messages.len());
    for message in messages {
        match message.get("role").and_then(Value::as_str) {
            Some("runtimeIdentity") => {
                let identity: kordi_core::types::RuntimeIdentity =
                    serde_json::from_value(message["content"].clone()).map_err(|_| {
                        ModelLoopError::Provider("Invalid historical runtime identity".into())
                    })?;
                if run
                    .turn_identity
                    .as_ref()
                    .is_some_and(|current| !current.same_agent(&identity))
                {
                    return Err(ModelLoopError::Provider(
                        "Subsession Agent ownership cannot change".into(),
                    ));
                }
            }
            Some(
                "user" | "assistant" | "toolResult" | "custom" | "compactionSummary"
                | "branchSummary",
            ) => normalized.push(message),
            _ => {
                return Err(ModelLoopError::Provider(
                    "Invalid OMP context message role".into(),
                ))
            }
        }
    }
    Ok(normalized)
}

struct CloudOmpTools<'a, C> {
    client: &'a C,
    executor: CloudToolExecutor,
    sandbox: &'a SandboxBackendHandle,
    run: &'a CloudAgentRun,
}

#[async_trait]
impl<C: CloudAgentRunClient + Sync> HostTool for CloudOmpTools<'_, C> {
    async fn execute(&self, call: ToolCall, cancel: CancellationToken) -> ToolResult {
        if cancel.is_cancelled() {
            return ToolResult {
                ok: false,
                content: vec![json!({"type":"text","text":"Tool cancelled."})],
                details: None,
            };
        }
        let model_call = ModelToolCall {
            id: call.call_id,
            name: call.name,
            arguments: call.input,
        };
        if self.run.subsession_id.is_some()
            && matches!(
                model_call.name.as_str(),
                "web_search"
                    | "web_fetch"
                    | "search_sessions"
                    | "read_session"
                    | "read"
                    | "ls"
                    | "find"
                    | "grep"
                    | "write"
                    | "edit"
            )
            && self
                .client
                .subsession_progress(&self.run.run_id, &model_call.id, &model_call.name)
                .await
                .is_err()
        {
            return ToolResult {
                ok: false,
                content: vec![
                    json!({"type":"text","text":"Subsession progress could not be recorded."}),
                ],
                details: None,
            };
        }
        let output = execute_model_tool(
            self.client,
            &self.executor,
            self.sandbox,
            self.run,
            &model_call,
        )
        .await;
        let content = match output {
            Value::Array(blocks) => blocks,
            Value::String(text) => vec![json!({"type":"text","text":text})],
            other => vec![json!({"type":"text","text":other.to_string()})],
        };
        ToolResult {
            ok: true,
            content,
            details: None,
        }
    }
}

/// The leased run's queued/running/terminal status is persisted by the outer
/// runner lifecycle; tool starts for subsessions are persisted by CloudOmpTools.
/// Ordinary cloud turns currently publish final text atomically at completion,
/// matching the existing cloud runner's lack of token-streaming storage.
struct CloudRunStatusSink;
#[async_trait]
impl EventSink for CloudRunStatusSink {
    async fn on_event(&self, _: RuntimeEvent) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "omp_tests.rs"]
mod tests;
