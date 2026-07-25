use async_trait::async_trait;
use kordi_provider::{CompletionRequest, Provider, ProviderAuthMode, RequestOptions, StreamEvent};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

use crate::client::ProviderAuthMaterial;

use super::{CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiApiMode {
    ChatCompletions,
    CodexOAuth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiProviderConfig {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    pub api_mode: OpenAiApiMode,
    pub account_id: Option<String>,
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
            _ => OpenAiApiMode::ChatCompletions,
        };
        let base_url = payload
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default_base_url_for_mode(&material.provider, api_mode))
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
            .unwrap_or("gpt-4.1-mini");
        let model = normalize_model_for_mode(model, api_mode).to_string();
        let account_id = payload
            .get("accountId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        Ok(Self {
            provider: material.provider.clone(),
            api_key,
            base_url,
            model,
            api_mode,
            account_id,
        })
    }

    fn request_options(&self) -> RequestOptions {
        RequestOptions {
            provider: self.provider.clone(),
            api_key: self.api_key.clone(),
            auth_mode: match self.api_mode {
                OpenAiApiMode::ChatCompletions => ProviderAuthMode::ApiKey,
                OpenAiApiMode::CodexOAuth => ProviderAuthMode::OAuth,
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

fn default_base_url_for_mode(provider: &str, api_mode: OpenAiApiMode) -> &'static str {
    if api_mode == OpenAiApiMode::CodexOAuth {
        return "https://chatgpt.com/backend-api";
    }
    match provider {
        "openai" => "https://api.openai.com/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "xai" => "https://api.x.ai/v1",
        _ => "https://api.openai.com/v1",
    }
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
pub struct OpenAiCompatibleProvider {
    provider: kordi_provider::openai::OpenAiProvider,
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
        let events = self
            .provider
            .complete(request, auth.request_options())
            .await
            .map_err(|err| ModelLoopError::Provider(err.to_string()))?;
        model_response_from_stream_events(events)
    }
}

fn completion_request_from_cloud_messages(
    auth: &OpenAiProviderConfig,
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
mod tests {
    use super::*;

    #[test]
    fn openai_config_rejects_missing_provider_tokens() {
        let material = ProviderAuthMaterial {
            snapshot_id: "snap".to_string(),
            provider: "openai".to_string(),
            auth_choice: "default".to_string(),
            payload: json!({ "baseUrl": "https://api.openai.com/v1" }),
        };

        let error = OpenAiProviderConfig::from_material(&material).unwrap_err();
        assert!(error.to_string().contains("provider token"));
    }

    #[test]
    fn openai_config_allows_public_hosts_that_contain_localhost_text() {
        let material = ProviderAuthMaterial {
            snapshot_id: "snap".to_string(),
            provider: "openai".to_string(),
            auth_choice: "default".to_string(),
            payload: json!({
                "apiKey": "key",
                "baseUrl": "https://localhost-docs.example.com/v1"
            }),
        };

        let config = OpenAiProviderConfig::from_material(&material).unwrap();
        assert_eq!(config.base_url, "https://localhost-docs.example.com/v1");
    }

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
    fn openai_config_accepts_codex_oauth_material_and_preserves_model() {
        let material = ProviderAuthMaterial {
            snapshot_id: "snap".to_string(),
            provider: "openai-codex".to_string(),
            auth_choice: "local-active-oauth".to_string(),
            payload: json!({
                "apiMode": "openai-codex-oauth",
                "accessToken": "oauth-token",
                "accountId": "account-123",
                "model": "gpt-5.5"
            }),
        };

        let config = OpenAiProviderConfig::from_material(&material).unwrap();
        assert_eq!(config.api_mode, OpenAiApiMode::CodexOAuth);
        assert_eq!(config.api_key, "oauth-token");
        assert_eq!(config.account_id.as_deref(), Some("account-123"));
        assert_eq!(config.model, "gpt-5.5");

        let options = config.request_options();
        assert_eq!(options.auth_mode, ProviderAuthMode::OAuth);
        assert_eq!(options.auth_account_id.as_deref(), Some("account-123"));
        assert_eq!(options.base_url, "https://chatgpt.com/backend-api");
    }

    #[test]
    fn codex_oauth_snapshot_strips_provider_prefix_from_route_model() {
        let material = ProviderAuthMaterial {
            snapshot_id: "snap".to_string(),
            provider: "openai-codex".to_string(),
            auth_choice: "local-active-oauth".to_string(),
            payload: json!({
                "apiMode": "openai-codex-oauth",
                "accessToken": "oauth-token",
                "accountId": "account-123",
                "model": "openai/gpt-5.5"
            }),
        };

        let config = OpenAiProviderConfig::from_material(&material).unwrap();

        assert_eq!(config.model, "gpt-5.5");
    }

    #[test]
    fn completion_request_uses_shared_provider_shape_without_rewriting_model() {
        let auth = OpenAiProviderConfig {
            provider: "openai".to_string(),
            api_key: "token".to_string(),
            base_url: "https://chatgpt.com/backend-api".to_string(),
            model: "gpt-5.5".to_string(),
            api_mode: OpenAiApiMode::CodexOAuth,
            account_id: Some("acct".to_string()),
        };
        let request = completion_request_from_cloud_messages(
            &auth,
            &[
                json!({"role":"system","content":"System A"}),
                json!({"role":"user","content":"Hello"}),
            ],
            &[json!({"type":"function","function":{"name":"read"}})],
        );

        assert_eq!(request.model, "gpt-5.5");
        assert_eq!(request.system_prompt, "System A");
        assert_eq!(
            request.messages,
            vec![json!({"role":"user","content":"Hello"})]
        );
        assert_eq!(request.tools.len(), 1);
        assert_eq!(request.thinking.as_deref(), Some("default"));
    }

    #[test]
    fn stream_events_convert_to_tool_call_response() {
        let response = model_response_from_stream_events(vec![
            StreamEvent::ToolCallStart {
                id: "call_1".to_string(),
                name: "read".to_string(),
            },
            StreamEvent::ToolCallDelta {
                id: "call_1".to_string(),
                arguments_delta: "{\"path\":\"file.txt\"}".to_string(),
            },
            StreamEvent::ToolCallEnd {
                id: "call_1".to_string(),
            },
            StreamEvent::Done,
        ])
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

    #[test]
    fn stream_events_convert_to_final_text() {
        let response = model_response_from_stream_events(vec![
            StreamEvent::TextDelta {
                text: "hello".to_string(),
            },
            StreamEvent::TextDelta {
                text: " world".to_string(),
            },
            StreamEvent::Done,
        ])
        .unwrap();

        assert_eq!(
            response,
            ModelProviderResponse::FinalText("hello world".to_string())
        );
    }
}
