use async_trait::async_trait;
use serde_json::{json, Value};

use crate::client::ProviderAuthMaterial;

use super::{CloudModelProvider, ModelLoopError, ModelProviderResponse, ModelToolCall};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiApiMode {
    ChatCompletions,
    CodexOAuth,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiProviderConfig {
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
            .unwrap_or("gpt-4.1-mini")
            .to_string();
        let account_id = payload
            .get("accountId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        Ok(Self {
            api_key,
            base_url,
            model,
            api_mode,
            account_id,
        })
    }
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
    http: reqwest::Client,
}

impl OpenAiCompatibleProvider {
    async fn next_codex_oauth_response(
        &self,
        auth: &OpenAiProviderConfig,
        messages: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        let response = self
            .http
            .post(codex_responses_url(&auth.base_url))
            .bearer_auth(&auth.api_key)
            .header("OpenAI-Beta", "responses=experimental")
            .header("accept", "text/event-stream")
            .header("content-type", "application/json")
            .header("originator", "kordi")
            .header("User-Agent", "kordi-cloud-agent-runner")
            .header(
                "chatgpt-account-id",
                auth.account_id.as_deref().unwrap_or(""),
            )
            .json(&json!({
                "model": auth.model,
                "store": false,
                "stream": true,
                "instructions": codex_instructions(messages),
                "input": codex_input(messages),
                "text": {"verbosity": "low"},
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
                "codex/responses returned {status}: {text}"
            )));
        }
        parse_codex_oauth_sse_response(&text)
    }
}

#[async_trait]
impl CloudModelProvider for OpenAiCompatibleProvider {
    async fn next_response(
        &self,
        auth: &OpenAiProviderConfig,
        messages: &[Value],
        tools: &[Value],
    ) -> Result<ModelProviderResponse, ModelLoopError> {
        match auth.api_mode {
            OpenAiApiMode::ChatCompletions => {
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
            OpenAiApiMode::CodexOAuth => self.next_codex_oauth_response(auth, messages).await,
        }
    }
}

fn codex_responses_url(base_url: &str) -> String {
    let raw = if base_url.trim().is_empty() || base_url.contains("api.openai.com") {
        "https://chatgpt.com/backend-api".to_string()
    } else {
        base_url.trim_end_matches('/').to_string()
    };
    if raw.ends_with("/codex/responses") {
        raw
    } else if raw.ends_with("/codex") {
        format!("{raw}/responses")
    } else {
        format!("{raw}/codex/responses")
    }
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

fn codex_instructions(messages: &[Value]) -> String {
    messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("system"))
        .map(message_content_text)
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn codex_input(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) != Some("system"))
        .map(|message| {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            json!({
                "role": if role == "assistant" { "assistant" } else { "user" },
                "content": [{"type": "input_text", "text": message_content_text(message)}],
            })
        })
        .collect()
}

fn parse_codex_oauth_sse_response(text: &str) -> Result<ModelProviderResponse, ModelLoopError> {
    let mut output = String::new();
    for line in text.lines() {
        let Some(data) = line.trim().strip_prefix("data: ") else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        let event: Value = serde_json::from_str(data)
            .map_err(|err| ModelLoopError::Provider(format!("invalid codex SSE JSON: {err}")))?;
        match event.get("type").and_then(Value::as_str).unwrap_or("") {
            "response.output_text.delta" => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    output.push_str(delta);
                }
            }
            "response.failed" | "error" => {
                let message = event
                    .get("message")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        event
                            .get("error")
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str)
                    })
                    .unwrap_or("Codex response failed");
                return Err(ModelLoopError::Provider(message.to_string()));
            }
            "response.completed" | "response.done" => break,
            _ => {}
        }
    }
    Ok(ModelProviderResponse::FinalText(output))
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
    fn openai_config_accepts_codex_oauth_material() {
        let material = ProviderAuthMaterial {
            snapshot_id: "snap".to_string(),
            provider: "openai-codex".to_string(),
            auth_choice: "local-active-oauth".to_string(),
            payload: json!({
                "apiMode": "openai-codex-oauth",
                "accessToken": "oauth-token",
                "accountId": "account-123",
                "model": "gpt-5"
            }),
        };

        let config = OpenAiProviderConfig::from_material(&material).unwrap();
        assert_eq!(config.api_mode, OpenAiApiMode::CodexOAuth);
        assert_eq!(config.api_key, "oauth-token");
        assert_eq!(config.account_id.as_deref(), Some("account-123"));
        assert_eq!(config.model, "gpt-5");
    }

    #[test]
    fn parse_codex_oauth_sse_final_text() {
        let text = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n\
                    data: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\n\n\
                    data: {\"type\":\"response.completed\"}\n\n";
        let response = parse_codex_oauth_sse_response(text).unwrap();
        assert_eq!(
            response,
            ModelProviderResponse::FinalText("hello world".to_string())
        );
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
