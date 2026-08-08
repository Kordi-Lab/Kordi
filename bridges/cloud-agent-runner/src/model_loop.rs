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
    let auth_material = refresh_oauth_material_if_needed(client, run, auth_material).await?;
    let auth = OpenAiProviderConfig::from_material(&auth_material)?;
    let tools = prompt::tool_catalog();
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

const OAUTH_REFRESH_BUFFER_MS: i64 = 5 * 60 * 1_000;

async fn refresh_oauth_material_if_needed<C: CloudAgentRunClient + Sync>(
    client: &C,
    run: &CloudAgentRun,
    mut material: ProviderAuthMaterial,
) -> Result<ProviderAuthMaterial, ModelLoopError> {
    let mode = material
        .payload
        .get("apiMode")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let expiry_field = match mode.as_str() {
        "openai-codex-oauth" | "anthropic-oauth" => "expiresAt",
        "github-copilot-oauth" => "runtimeExpiresAt",
        _ => return Ok(material),
    };
    let Some(expires_at_ms) = material.payload.get(expiry_field).and_then(Value::as_i64) else {
        return Ok(material);
    };
    if expires_at_ms > chrono::Utc::now().timestamp_millis() + OAUTH_REFRESH_BUFFER_MS {
        return Ok(material);
    }

    let payload = material.payload.as_object_mut().ok_or_else(|| {
        ModelLoopError::Provider(
            "Cloud fallback OAuth snapshot payload is not an object.".to_string(),
        )
    })?;
    match mode.as_str() {
        "openai-codex-oauth" => {
            let refresh_token = payload_secret(payload, "refreshToken")?;
            let refreshed =
                kordi_cli::oauth::openai_codex::refresh_openai_codex_token(&refresh_token)
                    .await
                    .map_err(|error| {
                        ModelLoopError::Provider(format!(
                            "Cloud fallback could not refresh OpenAI OAuth: {error}"
                        ))
                    })?;
            payload.insert("accessToken".to_string(), Value::String(refreshed.access));
            payload.insert(
                "refreshToken".to_string(),
                Value::String(if refreshed.refresh.trim().is_empty() {
                    refresh_token
                } else {
                    refreshed.refresh
                }),
            );
            payload.insert(
                "expiresAt".to_string(),
                Value::Number(refreshed.expires.into()),
            );
            if let Some(account_id) = refreshed
                .extra
                .get("accountId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                payload.insert(
                    "accountId".to_string(),
                    Value::String(account_id.to_string()),
                );
            }
        }
        "anthropic-oauth" => {
            let refresh_token = payload_secret(payload, "refreshToken")?;
            let refreshed = kordi_cli::oauth::anthropic::refresh_anthropic_token(&refresh_token)
                .await
                .map_err(|error| {
                    ModelLoopError::Provider(format!(
                        "Cloud fallback could not refresh Anthropic OAuth: {error}"
                    ))
                })?;
            payload.insert("accessToken".to_string(), Value::String(refreshed.access));
            payload.insert(
                "refreshToken".to_string(),
                Value::String(if refreshed.refresh.trim().is_empty() {
                    refresh_token
                } else {
                    refreshed.refresh
                }),
            );
            payload.insert(
                "expiresAt".to_string(),
                Value::Number(refreshed.expires.into()),
            );
        }
        "github-copilot-oauth" => {
            let authority = payload
                .get("authority")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("github.com")
                .to_string();
            let github_access_expiring = payload
                .get("githubAccessExpiresAt")
                .and_then(Value::as_i64)
                .is_some_and(|expires| {
                    expires <= chrono::Utc::now().timestamp_millis() + OAUTH_REFRESH_BUFFER_MS
                });
            if github_access_expiring {
                let refresh_token = payload_secret(payload, "refreshToken")?;
                let refreshed = kordi_cli::oauth::github_copilot::refresh_github_copilot_token(
                    &refresh_token,
                    &authority,
                )
                .await
                .map_err(|error| {
                    ModelLoopError::Provider(format!(
                        "Cloud fallback could not refresh GitHub OAuth: {error}"
                    ))
                })?;
                payload.insert(
                    "githubAccessToken".to_string(),
                    Value::String(refreshed.access),
                );
                payload.insert(
                    "refreshToken".to_string(),
                    Value::String(if refreshed.refresh.trim().is_empty() {
                        refresh_token
                    } else {
                        refreshed.refresh
                    }),
                );
                payload.insert(
                    "githubAccessExpiresAt".to_string(),
                    Value::Number(refreshed.expires.into()),
                );
                copy_string_field(&refreshed.extra, payload, "copilot_token", "accessToken")?;
                copy_i64_field(
                    &refreshed.extra,
                    payload,
                    "copilot_expires_at",
                    "runtimeExpiresAt",
                )?;
                copy_optional_string_field(
                    &refreshed.extra,
                    payload,
                    "copilot_api_base_url",
                    "baseUrl",
                );
                copy_optional_string_field(&refreshed.extra, payload, "login", "accountLabel");
            } else {
                let github_access_token = payload_secret(payload, "githubAccessToken")?;
                let refreshed =
                    kordi_cli::oauth::github_copilot::exchange_github_token_for_copilot_session(
                        &authority,
                        &github_access_token,
                    )
                    .await
                    .map_err(|error| {
                        ModelLoopError::Provider(format!(
                            "Cloud fallback could not refresh GitHub Copilot OAuth: {error}"
                        ))
                    })?;
                payload.insert(
                    "accessToken".to_string(),
                    Value::String(refreshed.copilot_token),
                );
                payload.insert(
                    "runtimeExpiresAt".to_string(),
                    Value::Number(refreshed.copilot_expires_at_ms.into()),
                );
                payload.insert("baseUrl".to_string(), Value::String(refreshed.api_base_url));
                if let Some(login) = refreshed.login {
                    payload.insert("accountLabel".to_string(), Value::String(login));
                }
            }
        }
        _ => return Ok(material),
    }

    client
        .persist_refreshed_provider_auth(&run.run_id, &material.snapshot_id, &material.payload)
        .await?;
    Ok(material)
}

fn copy_string_field(
    source: &Value,
    target: &mut serde_json::Map<String, Value>,
    source_field: &str,
    target_field: &str,
) -> Result<(), ModelLoopError> {
    let value = source
        .get(source_field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ModelLoopError::Provider(format!(
                "Cloud fallback GitHub refresh response is missing {source_field}."
            ))
        })?;
    target.insert(target_field.to_string(), Value::String(value.to_string()));
    Ok(())
}

fn copy_i64_field(
    source: &Value,
    target: &mut serde_json::Map<String, Value>,
    source_field: &str,
    target_field: &str,
) -> Result<(), ModelLoopError> {
    let value = source
        .get(source_field)
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            ModelLoopError::Provider(format!(
                "Cloud fallback GitHub refresh response is missing {source_field}."
            ))
        })?;
    target.insert(target_field.to_string(), Value::Number(value.into()));
    Ok(())
}

fn copy_optional_string_field(
    source: &Value,
    target: &mut serde_json::Map<String, Value>,
    source_field: &str,
    target_field: &str,
) {
    if let Some(value) = source
        .get(source_field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        target.insert(target_field.to_string(), Value::String(value.to_string()));
    }
}

fn payload_secret(
    payload: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, ModelLoopError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| {
            ModelLoopError::Provider(format!("Cloud fallback OAuth snapshot is missing {field}."))
        })
}

async fn execute_model_tool<C: CloudAgentRunClient + Sync>(
    client: &C,
    executor: &CloudToolExecutor,
    sandbox: &SandboxBackendHandle,
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
