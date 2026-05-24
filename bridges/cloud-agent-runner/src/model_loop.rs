use async_trait::async_trait;
use serde_json::{json, Value};

use crate::artifacts::export_sandbox_file;
use crate::client::{CloudAgentRun, CloudAgentRunClient, ProviderAuthMaterial, RunnerClientError};
use crate::sandbox_client::LocalSandboxBackend;
use crate::tool_policy::RunnerToolRequest;
use crate::tools::{CloudToolExecutor, CloudToolOutput};

pub const MAX_MODEL_CALLS: usize = 3;
pub const MAX_TOOL_CALLS: usize = 5;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiProviderConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl OpenAiProviderConfig {
    pub fn from_material(material: &ProviderAuthMaterial) -> Result<Self, ModelLoopError> {
        let payload = &material.payload;
        let api_key = payload
            .get("apiKey")
            .or_else(|| payload.get("accessToken"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let base_url = payload
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default_base_url(&material.provider))
            .trim_end_matches('/')
            .to_string();
        if is_owner_local_provider_endpoint(&base_url) {
            return Err(ModelLoopError::Provider(
                "Cloud fallback cannot use owner-local provider endpoints such as localhost or private networks."
                    .to_string(),
            ));
        }
        let model = payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("gpt-4.1-mini")
            .to_string();
        Ok(Self {
            api_key,
            base_url,
            model,
        })
    }
}

fn default_base_url(provider: &str) -> &'static str {
    match provider {
        "openai" => "https://api.openai.com/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "xai" => "https://api.x.ai/v1",
        _ => "https://api.openai.com/v1",
    }
}

fn is_owner_local_provider_endpoint(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    lower.contains("localhost")
        || lower.contains("127.0.0.1")
        || lower.contains("[::1]")
        || lower.contains("://10.")
        || lower.contains("://192.168.")
        || lower.contains("://172.16.")
        || lower.contains("://172.17.")
        || lower.contains("://172.18.")
        || lower.contains("://172.19.")
        || lower.contains("://172.20.")
        || lower.contains("://172.21.")
        || lower.contains("://172.22.")
        || lower.contains("://172.23.")
        || lower.contains("://172.24.")
        || lower.contains("://172.25.")
        || lower.contains("://172.26.")
        || lower.contains("://172.27.")
        || lower.contains("://172.28.")
        || lower.contains("://172.29.")
        || lower.contains("://172.30.")
        || lower.contains("://172.31.")
        || lower.contains("://169.254.")
}

pub fn cloud_sandbox_system_prompt() -> &'static str {
    "You are running in Kordi Cloud fallback because the owner device is offline. \
You may work only inside the Cloud sandbox workspace. You cannot read owner laptop files, \
owner-local services, localhost/private networks, other users' data, or unsynced private resources. \
Do not ask for approval prompts; unavailable actions should be explained as runtime boundaries. \
Export artifacts only when explicitly useful to share; unexported sandbox files remain private."
}

pub fn tool_catalog() -> Vec<Value> {
    vec![
        tool_schema(
            "read",
            "Read a UTF-8 text file inside the Cloud sandbox.",
            vec![("path", "string")],
        ),
        tool_schema(
            "write",
            "Write a UTF-8 text file inside the Cloud sandbox.",
            vec![("path", "string"), ("content", "string")],
        ),
        tool_schema(
            "edit",
            "Replace file content inside the Cloud sandbox.",
            vec![("path", "string"), ("content", "string")],
        ),
        tool_schema(
            "ls",
            "List a Cloud sandbox directory.",
            vec![("path", "string")],
        ),
        tool_schema(
            "find",
            "Find entries inside a Cloud sandbox directory.",
            vec![("path", "string")],
        ),
        tool_schema(
            "grep",
            "Search entries inside a Cloud sandbox directory.",
            vec![("path", "string")],
        ),
        tool_schema(
            "bash",
            "Run a shell command inside the Cloud sandbox.",
            vec![("command", "string")],
        ),
        tool_schema(
            "export_artifact",
            "Export a file from the Cloud sandbox into chat attachments.",
            vec![
                ("path", "string"),
                ("name", "string"),
                ("contentType", "string"),
            ],
        ),
    ]
}

fn tool_schema(name: &str, description: &str, properties: Vec<(&str, &str)>) -> Value {
    let mut props = serde_json::Map::new();
    let mut required = Vec::new();
    for (property, kind) in properties {
        props.insert(property.to_string(), json!({ "type": kind }));
        required.push(Value::String(property.to_string()));
    }
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": props,
                "required": required
            }
        }
    })
}

pub async fn run_model_loop<C, P>(
    client: &C,
    provider: &P,
    run: &CloudAgentRun,
    sandbox: &LocalSandboxBackend,
    auth_material: ProviderAuthMaterial,
) -> Result<String, ModelLoopError>
where
    C: CloudAgentRunClient + Sync,
    P: CloudModelProvider + Sync,
{
    let auth = OpenAiProviderConfig::from_material(&auth_material)?;
    let tools = tool_catalog();
    let executor = CloudToolExecutor::new(sandbox.clone());
    let mut messages = vec![
        json!({ "role": "system", "content": cloud_sandbox_system_prompt() }),
        json!({ "role": "user", "content": run.prompt }),
    ];
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
    sandbox: &LocalSandboxBackend,
    run: &CloudAgentRun,
    call: &ModelToolCall,
) -> String {
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
    let request = RunnerToolRequest {
        tool_name: &call.name,
        path_args,
        url_args: Vec::new(),
        requester_account_id: &run.requester_account_id,
        owner_account_id: &run.owner_account_id,
        data_owner_account_id: None,
    };

    match executor
        .execute(request, Some(primary.as_str()), Some(content))
        .await
    {
        Ok(output) => format_tool_output(output),
        Err(err) => err.to_string(),
    }
}

async fn export_model_artifact<C: CloudAgentRunClient + Sync>(
    client: &C,
    sandbox: &LocalSandboxBackend,
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
        CloudToolOutput::RemoteWebAllowed => "remote web access is allowed by policy".to_string(),
    }
}

#[derive(Default)]
pub struct OpenAiCompatibleProvider {
    http: reqwest::Client,
}

#[async_trait]
impl CloudModelProvider for OpenAiCompatibleProvider {
    async fn next_response(
        &self,
        auth: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        let response = self
            .http
            .post(format!("{}/chat/completions", auth.base_url))
            .bearer_auth(&auth.api_key)
            .json(&json!({
                "model": auth.model,
                "messages": messages,
                "tools": tools,
            }))
            .send()
            .await
            .map_err(|err| ModelLoopError::Provider(err.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| ModelLoopError::Provider(err.to_string()))?;
        if !status.is_success() {
            return Err(ModelLoopError::Provider(format!(
                "chat/completions returned {status}: {text}"
            )));
        }
        parse_openai_chat_response(&text)
    }
}

fn parse_openai_chat_response(text: &str) -> Result<ModelProviderResponse, ModelLoopError> {
    let body: Value = serde_json::from_str(text)
        .map_err(|err| ModelLoopError::Provider(format!("invalid chat response JSON: {err}")))?;
    let message = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .ok_or_else(|| ModelLoopError::Provider("chat response missing message".to_string()))?;

    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        if !tool_calls.is_empty() {
            let mut parsed = Vec::new();
            for call in tool_calls {
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("tool_call")
                    .to_string();
                let function = call.get("function").unwrap_or(&Value::Null);
                let name = function
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ModelLoopError::Provider("tool call missing function name".to_string())
                    })?
                    .to_string();
                let raw_arguments = function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                let arguments = serde_json::from_str(raw_arguments).map_err(|err| {
                    ModelLoopError::Provider(format!("tool call arguments are not JSON: {err}"))
                })?;
                parsed.push(ModelToolCall {
                    id,
                    name,
                    arguments,
                });
            }
            return Ok(ModelProviderResponse::ToolCalls(parsed));
        }
    }

    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(ModelProviderResponse::FinalText(content))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_config_rejects_owner_local_provider_endpoints() {
        let material = ProviderAuthMaterial {
            snapshot_id: "snap".to_string(),
            provider: "openai".to_string(),
            auth_choice: "default".to_string(),
            payload: json!({ "apiKey": "key", "baseUrl": "http://localhost:1234/v1" }),
        };

        let error = OpenAiProviderConfig::from_material(&material).unwrap_err();
        assert!(error.to_string().contains("owner-local provider endpoints"));
    }

    #[test]
    fn parse_openai_tool_calls() {
        let response = parse_openai_chat_response(
            r#"{"choices":[{"message":{"tool_calls":[{"id":"call_1","function":{"name":"read","arguments":"{\"path\":\"file.txt\"}"}}]}}]}"#,
        )
        .unwrap();

        assert_eq!(
            response,
            ModelProviderResponse::ToolCalls(vec![ModelToolCall {
                id: "call_1".to_string(),
                name: "read".to_string(),
                arguments: json!({"path":"file.txt"}),
            }])
        );
    }
}
