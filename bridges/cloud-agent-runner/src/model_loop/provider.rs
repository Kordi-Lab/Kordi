use async_trait::async_trait;
use kordi_core::agent_session::DEFAULT_OPENAI_MODEL_ID;
use kordi_provider::anthropic::capabilities::DEFAULT_ANTHROPIC_MODEL_ID;
use kordi_provider::anthropic::AnthropicProvider;
use kordi_provider::openai::OpenAiProvider;
use kordi_provider::{CompletionRequest, Provider, ProviderAuthMode, RequestOptions, StreamEvent};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

use crate::client::ProviderAuthMaterial;

use super::{CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudProviderApi {
    OpenAiCompatible,
    Anthropic,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CloudProviderConfig {
    pub api: CloudProviderApi,
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub auth_mode: ProviderAuthMode,
    pub account_id: Option<String>,
}

impl std::fmt::Debug for CloudProviderConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CloudProviderConfig")
            .field("api", &self.api)
            .field("provider", &self.provider)
            .field("api_key", &"[redacted]")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("auth_mode", &self.auth_mode)
            .field("account_id", &self.account_id)
            .finish()
    }
}

impl CloudProviderConfig {
    pub fn from_material(material: &ProviderAuthMaterial) -> Result<Self, ModelLoopError> {
        let payload = &material.payload;
        let provider = material.provider.trim().to_ascii_lowercase();
        let api_mode = payload
            .get("apiMode")
            .and_then(Value::as_str)
            .map(str::trim);
        let (api, auth_mode, default_base_url) = match provider.as_str() {
            "openai-codex" if api_mode == Some("openai-codex-oauth") => (
                CloudProviderApi::OpenAiCompatible,
                ProviderAuthMode::OAuth,
                "https://chatgpt.com/backend-api",
            ),
            "openai" => (
                CloudProviderApi::OpenAiCompatible,
                ProviderAuthMode::ApiKey,
                "https://api.openai.com/v1",
            ),
            "openrouter" => (
                CloudProviderApi::OpenAiCompatible,
                ProviderAuthMode::ApiKey,
                "https://openrouter.ai/api/v1",
            ),
            "groq" => (
                CloudProviderApi::OpenAiCompatible,
                ProviderAuthMode::ApiKey,
                "https://api.groq.com/openai/v1",
            ),
            "xai" => (
                CloudProviderApi::OpenAiCompatible,
                ProviderAuthMode::ApiKey,
                "https://api.x.ai/v1",
            ),
            "anthropic" => (
                CloudProviderApi::Anthropic,
                if api_mode == Some("anthropic-oauth") {
                    ProviderAuthMode::OAuth
                } else {
                    ProviderAuthMode::ApiKey
                },
                "https://api.anthropic.com",
            ),
            _ => {
                return Err(ModelLoopError::Provider(format!(
                    "Cloud fallback provider is unsupported: {provider}"
                )));
            }
        };
        let api_key = payload
            .get("apiKey")
            .or_else(|| payload.get("accessToken"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if api_key.is_empty() {
            return Err(ModelLoopError::Provider(
                "Cloud fallback provider token is missing from the provider-auth snapshot."
                    .to_string(),
            ));
        }
        let base_url = payload
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(default_base_url)
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
            .unwrap_or(match api {
                CloudProviderApi::Anthropic => DEFAULT_ANTHROPIC_MODEL_ID,
                CloudProviderApi::OpenAiCompatible => DEFAULT_OPENAI_MODEL_ID,
            });
        let model = normalize_model_for_provider(model, &provider);
        let account_id = payload
            .get("accountId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        Ok(Self {
            api,
            provider,
            api_key,
            base_url,
            model,
            auth_mode,
            account_id,
        })
    }

    fn request_options(&self) -> RequestOptions {
        RequestOptions {
            provider: self.provider.clone(),
            api_key: self.api_key.clone(),
            auth_mode: self.auth_mode,
            auth_account_id: self.account_id.clone(),
            base_url: self.base_url.clone(),
            headers: HashMap::new(),
            cancel: CancellationToken::new(),
            retry_callback: None,
            max_retries: 2,
            retry_base_delay_ms: 250,
            max_retry_delay_ms: 2_000,
        }
    }
}

fn normalize_model_for_provider(model: &str, provider: &str) -> String {
    if provider == "openai-codex" {
        let model = model
            .strip_prefix("openai-codex/")
            .or_else(|| model.strip_prefix("openai/"))
            .unwrap_or(model);
        return if model.starts_with("claude-") {
            DEFAULT_OPENAI_MODEL_ID.to_string()
        } else {
            model.to_string()
        };
    }
    if provider == "anthropic" {
        let model = model.strip_prefix("anthropic/").unwrap_or(model);
        return if model.starts_with("claude-") {
            model.to_string()
        } else {
            DEFAULT_ANTHROPIC_MODEL_ID.to_string()
        };
    }
    model.to_string()
}

fn is_owner_local_provider_endpoint(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return true;
    };
    let Some(host) = url.host_str() else {
        return true;
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                ip.is_loopback()
                    || ip.is_private()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || ip.is_broadcast()
            }
            std::net::IpAddr::V6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
            }
        };
    }
    false
}

#[derive(Default)]
pub struct ConfiguredCloudProvider {
    openai: OpenAiProvider,
    anthropic: AnthropicProvider,
}

#[async_trait]
impl CloudModelProvider for ConfiguredCloudProvider {
    async fn next_response(
        &self,
        auth: &CloudProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        let request = completion_request_from_cloud_messages(auth, messages, tools);
        let events = match auth.api {
            CloudProviderApi::OpenAiCompatible => {
                self.openai.complete(request, auth.request_options()).await
            }
            CloudProviderApi::Anthropic => {
                self.anthropic
                    .complete(request, auth.request_options())
                    .await
            }
        }
        .map_err(|err| ModelLoopError::Provider(err.to_string()))?;
        model_response_from_stream_events(events)
    }
}

fn completion_request_from_cloud_messages(
    auth: &CloudProviderConfig,
    messages: &[Value],
    tools: &[Value],
) -> CompletionRequest {
    let (system_prompt, messages) = split_system_messages(messages);
    CompletionRequest {
        system_prompt,
        messages,
        tools: tools.to_vec(),
        extra_tool_schemas: Vec::new(),
        model: auth.model.clone(),
        max_tokens: None,
        stream: true,
        thinking: Some("default".to_string()),
    }
}

fn split_system_messages(messages: &[Value]) -> (String, Vec<Value>) {
    let mut system_parts = Vec::new();
    let mut non_system = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("system") {
            let text = message_content_text(message);
            if !text.trim().is_empty() {
                system_parts.push(text);
            }
        } else {
            non_system.push(message.clone());
        }
    }
    (system_parts.join("\n"), non_system)
}

fn message_content_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

#[derive(Debug, Default)]
struct PendingToolCall {
    name: String,
    arguments: String,
}

fn model_response_from_stream_events(
    events: Vec<StreamEvent>,
) -> Result<ModelProviderResponse, ModelLoopError> {
    let mut text = String::new();
    let mut tool_order = Vec::new();
    let mut tool_calls: HashMap<String, PendingToolCall> = HashMap::new();

    for event in events {
        match event {
            StreamEvent::TextDelta { text: delta } => text.push_str(&delta),
            StreamEvent::ToolCallStart { id, name } => {
                if !tool_calls.contains_key(&id) {
                    tool_order.push(id.clone());
                }
                tool_calls.entry(id).or_default().name = name;
            }
            StreamEvent::ToolCallDelta {
                id,
                arguments_delta,
            } => {
                if !tool_calls.contains_key(&id) {
                    tool_order.push(id.clone());
                }
                tool_calls
                    .entry(id)
                    .or_default()
                    .arguments
                    .push_str(&arguments_delta);
            }
            StreamEvent::ToolCallEnd { .. }
            | StreamEvent::ThinkingDelta { .. }
            | StreamEvent::Usage(_)
            | StreamEvent::Done => {}
            StreamEvent::ServerToolUseStart { .. }
            | StreamEvent::ServerToolUseDelta { .. }
            | StreamEvent::ServerToolUseEnd { .. }
            | StreamEvent::ServerToolResult { .. } => {}
            StreamEvent::Error { error } => {
                return Err(ModelLoopError::Provider(error.to_string()));
            }
        }
    }

    if tool_order.is_empty() {
        return Ok(ModelProviderResponse::FinalText(text));
    }

    let mut parsed = Vec::new();
    for id in tool_order {
        let call = tool_calls.remove(&id).unwrap_or_default();
        let arguments = if call.arguments.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&call.arguments).map_err(|err| {
                ModelLoopError::Provider(format!("tool call arguments are not JSON: {err}"))
            })?
        };
        parsed.push(ModelToolCall {
            id,
            name: call.name,
            arguments,
        });
    }
    Ok(ModelProviderResponse::ToolCalls(parsed))
}

#[cfg(test)]
mod tests;
