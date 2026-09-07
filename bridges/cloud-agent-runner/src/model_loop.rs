use async_trait::async_trait;
use serde_json::{json, Value};

mod prompt;
mod provider;

pub use prompt::{cloud_sandbox_system_prompt, tool_catalog};
pub use provider::{OpenAiCompatibleProvider, OpenAiProviderConfig};

use crate::artifacts::export_sandbox_file;
use crate::client::{CloudAgentRun, CloudAgentRunClient, ProviderAuthMaterial, RunnerClientError};
use crate::sandbox_client::SandboxBackendHandle;
use crate::tool_policy::RunnerToolRequest;
use crate::tools::{CloudToolExecutor, CloudToolOutput};

pub const MAX_MODEL_CALLS: usize = 8;
pub const MAX_TOOL_CALLS: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelProviderResponse {
    FinalText(String),
    ToolCalls(Vec<ModelToolCall>),
}

#[derive(Debug, thiserror::Error)]
pub enum ModelLoopError {
    #[error("provider error: {0}")]
    Provider(String),
    #[error("tool loop limit exceeded")]
    LimitExceeded,
    #[error("runner client error: {0}")]
    Client(#[from] RunnerClientError),
}

#[async_trait]
pub trait CloudModelProvider {
    async fn next_response(
        &self,
        auth: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError>;
}

pub async fn run_model_loop<C, P>(
    client: &C,
    provider: &P,
    run: &CloudAgentRun,
    sandbox: &SandboxBackendHandle,
    auth_material: ProviderAuthMaterial,
) -> Result<String, ModelLoopError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let mut auth = OpenAiProviderConfig::from_material(&auth_material)?;
    auth.apply_runtime_route(&run.runtime_route, &auth_material.provider);
    let mut tools = prompt::tool_catalog();
    if run.subsession_id.is_some() {
        tools.retain(|tool| {
            let name = tool["function"]["name"].as_str().unwrap_or_default();
            name != "task_operator"
                && name != "export_artifact"
                && name != "bash"
                && (!run.subsession_write_scope.is_empty() || !matches!(name, "write" | "edit"))
        });
    }
    let executor = CloudToolExecutor::new(sandbox.clone());
    let system_prompt = [run.system_prompt.trim(), cloud_sandbox_system_prompt()]
        .into_iter()
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let system_prompt = if run.subsession_id.is_none()
        && (run.session_id.starts_with("session:group:")
            || run.session_id.starts_with("session:direct-person:"))
    {
        format!("{system_prompt}\n\nYou are participating in a shared conversation. Keep brief answers, clarifications, and immediate user decisions in this conversation. For self-contained extended research or multi-step work, use task_operator action=spawn before starting heavy work, unless the user explicitly asks to keep the work inline. Supply a concise taskTitle, a self-contained message and forkTurns=none. After successful creation, give a short task-specific acknowledgement and end this parent turn. The subsession owns progress and the final result; do not wait for or repeat them here. Never create a conversation channel or an ordinary message thread.")
    } else {
        system_prompt
    };
    let mut messages = vec![json!({ "role": "system", "content": system_prompt })];
    for message in &run.history_messages {
        match message["role"].as_str() {
            Some("runtimeIdentity") => {
                let identity: kordi_core::types::RuntimeIdentity =
                    serde_json::from_value(message["content"].clone()).map_err(|_| {
                        ModelLoopError::Provider("Invalid historical runtime identity".into())
                    })?;
                if let Some(current) = &run.turn_identity {
                    if !current.same_agent(&identity) {
                        return Err(ModelLoopError::Provider(
                            "Subsession Agent ownership cannot change".into(),
                        ));
                    }
                }
                messages.push(identity.provider_message());
            }
            Some("user" | "assistant") => messages.push(message.clone()),
            _ => {}
        }
    }
    if let Some(identity) = &run.turn_identity {
        if identity.owner_account_id != run.owner_account_id
            || identity.requester_account_id != run.requester_account_id
        {
            return Err(ModelLoopError::Provider(
                "Runtime identity does not match the admitted run".into(),
            ));
        }
        messages.push(identity.provider_message());
    }
    messages.push(json!({ "role": "user", "content": run.prompt }));
    let mut tool_calls_used = 0usize;

    for _ in 0..MAX_MODEL_CALLS {
        match provider.next_response(&auth, &messages, &tools).await? {
            ModelProviderResponse::FinalText(text) => return Ok(text),
            ModelProviderResponse::ToolCalls(calls) => {
                if calls.is_empty() {
                    return Err(ModelLoopError::Provider(
                        "model returned an empty tool call list".to_string(),
                    ));
                }
                for call in calls {
                    tool_calls_used += 1;
                    if tool_calls_used > MAX_TOOL_CALLS {
                        return Err(ModelLoopError::LimitExceeded);
                    }
                    if run.subsession_id.is_some()
                        && matches!(
                            call.name.as_str(),
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
                    {
                        client
                            .subsession_progress(&run.run_id, &call.id, &call.name)
                            .await?;
                    }
                    messages.push(json!({
                        "role": "assistant",
                        "tool_calls": [{
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments.to_string()
                            }
                        }]
                    }));
                    let content = execute_model_tool(client, &executor, sandbox, run, &call).await;
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call.id,
                        "name": call.name,
                        "content": content,
                    }));
                }
            }
        }
    }

    Err(ModelLoopError::LimitExceeded)
}

async fn execute_model_tool<C: CloudAgentRunClient + Sync>(
    client: &C,
    executor: &CloudToolExecutor,
    sandbox: &SandboxBackendHandle,
    run: &CloudAgentRun,
    call: &ModelToolCall,
) -> String {
    if call.name == "task_operator" {
        if run.subsession_id.is_some() {
            return "Nested execution subsessions are not supported.".into();
        }
        return match client
            .task_operator(&run.run_id, &call.id, call.arguments.clone())
            .await
        {
            Ok(record) => format!("Background session: {record}"),
            Err(_) => {
                "The subsession could not be created or accessed. Do not claim it started.".into()
            }
        };
    }
    if run.subsession_id.is_some() {
        if matches!(call.name.as_str(), "bash" | "export_artifact") {
            return "This tool is unavailable in an execution subsession.".into();
        }
        if matches!(call.name.as_str(), "write" | "edit") {
            let path = call.arguments["path"].as_str().unwrap_or_default();
            if !run.subsession_write_scope.iter().any(|scope| {
                path == scope || path.starts_with(&format!("{}/", scope.trim_end_matches('/')))
            }) {
                return "The path is outside this subsession's write scope.".into();
            }
        }
    }
    if matches!(call.name.as_str(), "search_sessions" | "read_session") {
        return match client.read_context(&run.run_id, &call.name, call.arguments.clone()).await {
            Ok(value) => value.to_string(),
            Err(_) => "Conversation retrieval is unavailable or access was revoked. Do not infer missing context.".to_string(),
        };
    }
    if call.name == "export_artifact" {
        return export_model_artifact(client, sandbox, run, &call.arguments).await;
    }

    let primary = primary_arg(&call.name, &call.arguments).unwrap_or_default();
    let content = call
        .arguments
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let path_args = if matches!(
        call.name.as_str(),
        "read" | "write" | "edit" | "ls" | "find" | "grep"
    ) {
        vec![primary.as_str()]
    } else {
        Vec::new()
    };
    let url_args = if matches!(call.name.as_str(), "web_fetch" | "browser_fetch") {
        call.arguments
            .get("url")
            .and_then(Value::as_str)
            .map(|url| vec![url])
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let request = RunnerToolRequest {
        tool_name: &call.name,
        path_args,
        url_args,
        requester_account_id: &run.requester_account_id,
        owner_account_id: &run.owner_account_id,
        data_owner_account_id: None,
    };

    match executor
        .execute(
            request,
            Some(primary.as_str()),
            Some(content),
            &call.arguments,
        )
        .await
    {
        Ok(output) => format_tool_output(output),
        Err(err) => err.to_string(),
    }
}

async fn export_model_artifact<C: CloudAgentRunClient + Sync>(
    client: &C,
    sandbox: &SandboxBackendHandle,
    run: &CloudAgentRun,
    arguments: &Value,
) -> String {
    let path = arguments
        .get("path")
        .or_else(|| arguments.get("sandboxPath"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = arguments
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(path);
    let content_type = arguments
        .get("contentType")
        .or_else(|| arguments.get("content_type"))
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");

    match export_sandbox_file(client, sandbox, &run.run_id, path, name, content_type).await {
        Ok(artifact) => format!(
            "exported artifact {} as attachment {} ({})",
            artifact.name, artifact.attachment_id, artifact.sandbox_path
        ),
        Err(err) => format!("artifact export failed: {err}"),
    }
}

fn primary_arg(tool_name: &str, arguments: &Value) -> Option<String> {
    let key = if tool_name == "bash" {
        "command"
    } else {
        "path"
    };
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn format_tool_output(output: CloudToolOutput) -> String {
    match output {
        CloudToolOutput::Text(text) => text,
        CloudToolOutput::List(items) => items.join("\n"),
        CloudToolOutput::Bash(output) => format!(
            "exit_code={}\nstdout:\n{}\nstderr:\n{}",
            output.exit_code, output.stdout, output.stderr
        ),
    }
}
