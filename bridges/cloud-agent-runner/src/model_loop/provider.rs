use async_trait::async_trait;
use kordi_provider::{
    anthropic::AnthropicProvider, google::GoogleProvider, CompletionRequest, Provider,
    ProviderAuthMode, RequestOptions, StreamEvent,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

use crate::client::{AgentRuntimeRoute, ProviderAuthMaterial};

use super::{CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall};
pub use endpoint::PRIVATE_PROVIDER_ENDPOINTS_ENV;
use endpoint::{
    base_url_for, default_base_url, ensure_plain_api_key, ensure_provider_endpoint_allowed,
    ensure_supported_api, normalize_provider,
};
pub(crate) use endpoint::{
    ensure_endpoint_resolves_to_allowed_addresses, private_provider_endpoints_allowed,
};
use model_choice::snapshot_model;

mod endpoint;
mod model_choice;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiApiMode {
    ChatCompletions,
    CodexOAuth,
    AnthropicOAuth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiProviderConfig {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub thinking: String,
    pub api_mode: OpenAiApiMode,
    pub account_id: Option<String>,
}

/// The model a run with this material and route calls, as the model loop
/// resolves it, for "About this reply". `None` when the loop would refuse to
/// run.
pub fn effective_model(
    material: &ProviderAuthMaterial,
    route: &AgentRuntimeRoute,
) -> Option<String> {
    let mut config = OpenAiProviderConfig::from_material(material).ok()?;
    config.apply_runtime_route(route, &material.provider).ok()?;
    Some(config.model).filter(|model| !model.trim().is_empty())
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
        if api_key.is_empty() {
            return Err(ModelLoopError::Provider(
                "Cloud fallback provider token is missing from the provider-auth snapshot."
                    .to_string(),
            ));
        }
        let api_mode = match payload
            .get("apiMode")
            .and_then(Value::as_str)
            .map(str::trim)
        {
            Some("openai-codex-oauth") => OpenAiApiMode::CodexOAuth,
            Some("anthropic-oauth") => OpenAiApiMode::AnthropicOAuth,
            _ => OpenAiApiMode::ChatCompletions,
        };
        let provider = normalize_provider(&material.provider).to_string();
        ensure_plain_api_key(&provider, &api_key)?;
        ensure_supported_api(&provider, api_mode, payload)?;
        let base_url = base_url_for(&provider, api_mode, payload)?;
        ensure_provider_endpoint_allowed(&base_url, private_provider_endpoints_allowed())?;
        // Empty only for a custom account without a model; a route model may
        // still supply one in `apply_runtime_route`.
        let model = snapshot_model(payload, &provider)
            .map(|model| normalize_model_for_mode(model, api_mode).to_string())
            .unwrap_or_default();
        let account_id = payload
            .get("accountId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let thinking = payload
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("default")
            .to_string();
        Ok(Self {
            provider,
            api_key,
            base_url,
            model,
            thinking,
            api_mode,
            account_id,
        })
    }

    /// Applies the run route. For every provider, the route's `defaultModel`
    /// (for example `custom/deepseek-chat`) takes precedence over the model
    /// stored in the snapshot whenever both are present. A custom account
    /// with a model from neither fails instead of using a default model.
    pub fn apply_runtime_route(
        &mut self,
        route: &AgentRuntimeRoute,
        provider: &str,
    ) -> Result<(), ModelLoopError> {
        if let Some(model) = route
            .default_model
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            self.model = normalize_routed_model(model, provider, self.api_mode).to_string();
        }
        if let Some(thinking) = route
            .thinking
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            self.thinking = thinking.to_string();
        }
        if self.model.is_empty() {
            return Err(ModelLoopError::Provider(CUSTOM_MODEL_MISSING.to_string()));
        }
        Ok(())
    }

    /// Whether this account uses its provider's built-in vendor endpoint
    /// rather than a `baseUrl` of its own.
    pub fn uses_builtin_endpoint(&self) -> bool {
        default_base_url(&self.provider, self.api_mode) == Some(self.base_url.as_str())
    }

    fn request_options(&self) -> RequestOptions {
        RequestOptions {
            provider: self.provider.clone(),
            api_key: self.api_key.clone(),
            auth_mode: match self.api_mode {
                OpenAiApiMode::ChatCompletions => ProviderAuthMode::ApiKey,
                OpenAiApiMode::CodexOAuth | OpenAiApiMode::AnthropicOAuth => {
                    ProviderAuthMode::OAuth
                }
            },
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

fn normalize_model_for_mode(model: &str, api_mode: OpenAiApiMode) -> &str {
    if api_mode == OpenAiApiMode::CodexOAuth {
        return model.strip_prefix("openai/").unwrap_or(model);
    }
    model
}

fn normalize_routed_model<'a>(model: &'a str, provider: &str, api_mode: OpenAiApiMode) -> &'a str {
    let normalized = normalize_model_for_mode(model, api_mode);
    let Some((prefix, value)) = normalized.split_once('/') else {
        return normalized;
    };
    let prefix_matches = prefix.eq_ignore_ascii_case(provider)
        || (api_mode == OpenAiApiMode::CodexOAuth
            && matches!(
                prefix.to_ascii_lowercase().as_str(),
                "openai" | "openai-codex" | "codex"
            ));
    if prefix_matches && !value.trim().is_empty() {
        value
    } else {
        normalized
    }
}

const CUSTOM_MODEL_MISSING: &str =
    "This custom account has no model ID. Add one in Authentication.";

pub struct OpenAiCompatibleProvider {
    openai: kordi_provider::openai::OpenAiProvider,
    anthropic: AnthropicProvider,
    google: GoogleProvider,
}

impl Default for OpenAiCompatibleProvider {
    fn default() -> Self {
        Self::new(private_provider_endpoints_allowed())
    }
}

impl OpenAiCompatibleProvider {
    /// Provider clients for hosted runs. Every provider request uses a
    /// transport that ignores proxy settings, checks every DNS answer when it
    /// connects, and validates each redirect. By default it reaches only
    /// public addresses. With the operator's private-endpoint opt-in it also
    /// reaches private and loopback addresses, but never link-local or cloud
    /// metadata addresses.
    pub fn new(allow_private_endpoints: bool) -> Self {
        let client = if allow_private_endpoints {
            private_network_provider_client()
        } else {
            public_provider_client()
        };
        Self {
            openai: kordi_provider::openai::OpenAiProvider::with_client(client.clone()),
            anthropic: AnthropicProvider::with_client(client.clone()),
            google: GoogleProvider::with_client(client),
        }
    }
}

/// The public-address-only HTTP client for provider requests. It never falls
/// back to an unrestricted client.
pub fn public_provider_client() -> reqwest::Client {
    kordi_provider::with_provider_timeouts(kordi_tools::public_endpoint_client_builder())
        .build()
        .expect("the public provider HTTP client must be constructible")
}

/// The HTTP client for provider requests when the operator allows private
/// endpoints. It still refuses link-local and cloud metadata addresses and
/// never falls back to an unrestricted client.
pub fn private_network_provider_client() -> reqwest::Client {
    kordi_provider::with_provider_timeouts(kordi_tools::private_network_endpoint_client_builder())
        .build()
        .expect("the private-network provider HTTP client must be constructible")
}

#[async_trait]
impl CloudModelProvider for OpenAiCompatibleProvider {
    async fn next_response(
        &self,
        auth: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        let request = completion_request_from_cloud_messages(auth, messages, tools);
        let events = match auth.provider.as_str() {
            "anthropic" => {
                self.anthropic
                    .complete(request, auth.request_options())
                    .await
            }
            "google" => self.google.complete(request, auth.request_options()).await,
            _ => self.openai.complete(request, auth.request_options()).await,
        }
        .map_err(|err| ModelLoopError::Provider(err.to_string()))?;
        model_response_from_stream_events(events)
    }
}

const ANTHROPIC_MAX_TOKENS: u32 = 32_000;

fn completion_request_from_cloud_messages(
    auth: &OpenAiProviderConfig,
    messages: &[Value],
    tools: &[Value],
) -> CompletionRequest {
    let (system_prompt, messages) = split_system_messages(messages);
    let system_prompt =
        kordi_provider::with_active_model_context(&system_prompt, &auth.model, &auth.provider);
    CompletionRequest {
        system_prompt,
        messages,
        tools: tools.to_vec(),
        extra_tool_schemas: Vec::new(),
        model: auth.model.clone(),
        // Claude's default cap of 16,384 tokens covers thinking and the reply together, which a
        // long digest can use up before writing anything.
        max_tokens: (auth.provider == "anthropic").then_some(ANTHROPIC_MAX_TOKENS),
        stream: true,
        thinking: Some(auth.thinking.clone()),
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
    let mut thinking_chars = 0usize;
    let mut output_tokens = 0u64;
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
            StreamEvent::ThinkingDelta { text: delta } => thinking_chars += delta.len(),
            StreamEvent::Usage(usage) => output_tokens = output_tokens.max(usage.output_tokens),
            StreamEvent::ToolCallEnd { .. } | StreamEvent::Done => {}
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
        if text.trim().is_empty() {
            tracing::warn!(
                output_tokens,
                thinking_chars,
                "the model finished without a reply"
            );
        }
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
mod endpoint_tests;
#[cfg(test)]
mod tests;
