mod codex;
mod responses;
mod sse;

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::retry::with_retry;
use crate::transforms::{convert_messages_for_openai, strip_thinking_blocks};
use crate::{CompletionRequest, Provider, ProviderAuthMode, RequestOptions, StreamEvent};
use responses::should_use_responses_api;
use sse::{openai_sse_error_message, process_openai_sse};

/// OpenAI-compatible provider (works with OpenAI, Groq, Ollama, etc.)
pub struct OpenAiProvider {
    client: Client,
}

pub(super) fn default_prompt_cache_key(model: &str) -> String {
    format!("kordi:{model}")
}

pub(super) fn prompt_cache_key_for_request(model: &str, system_prompt: &str) -> String {
    if system_prompt.contains("<multi_participant_identity_context version=\"v1\">") {
        format!("kordi:{model}:identity-v1")
    } else {
        default_prompt_cache_key(model)
    }
}

pub(super) fn cached_tokens_from_usage(usage: &Value) -> u64 {
    usage
        .get("prompt_tokens_details")
        .or_else(|| usage.get("input_tokens_details"))
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

impl Default for OpenAiProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenAiProvider {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(300))
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }
}

fn is_github_copilot_request(options: &RequestOptions) -> bool {
    options
        .headers
        .get("OpenAI-Organization")
        .is_some_and(|value| value == "github-copilot")
        || options.base_url.contains("githubcopilot.com")
        || options.base_url.contains("/api/copilot")
}

fn is_standard_openai_api_base(base_url: &str) -> bool {
    let trimmed = base_url.trim_end_matches('/');
    trimmed == "https://api.openai.com/v1" || trimmed == "https://api.openai.com"
}

pub(super) fn apply_bearer_auth(
    builder: reqwest::RequestBuilder,
    api_key: &str,
) -> reqwest::RequestBuilder {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        builder
    } else {
        builder.header("Authorization", format!("Bearer {api_key}"))
    }
}

fn format_github_copilot_error(status: reqwest::StatusCode, body: &str, model: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let mut lines = vec![format!("HTTP {status}: {body}")];

    if status == reqwest::StatusCode::UNAUTHORIZED {
        lines.push(
            "GitHub Copilot authentication appears invalid or expired. Run `/login` and select GitHub Copilot to refresh the GitHub/Copilot session."
                .to_string(),
        );
    }

    if status == reqwest::StatusCode::FORBIDDEN {
        lines.push(
            "GitHub Copilot rejected this request. Your account may not have access to this model or your Copilot plan/enterprise policy may block it."
                .to_string(),
        );
    }

    if lower.contains("model not supported") || lower.contains("unsupported model") {
        lines.push(format!(
            "Copilot reported that model `{model}` is not supported. In pi's provider docs, GitHub recommends enabling the model in VS Code: Copilot Chat → model selector → select model → Enable."
        ));
    }

    if lower.contains("missing required authorization header") {
        lines.push(
            "The Copilot runtime token was not accepted. Re-run `/login` for GitHub Copilot and try again."
                .to_string(),
        );
    }

    lines.push(
        "Use `/session` to inspect saved Copilot authority, login, cached models, and token expiry info."
            .to_string(),
    );
    lines.join("\n")
}

#[async_trait]
impl Provider for OpenAiProvider {
    fn name(&self) -> &str {
        "openai"
    }

    async fn complete(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
    ) -> KordiResult<Vec<StreamEvent>> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        self.stream(request, options, tx).await?;

        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        Ok(events)
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        if matches!(options.auth_mode, ProviderAuthMode::OAuth)
            && let Some(account_id) = options.auth_account_id.clone()
        {
            return self
                .stream_codex_oauth(request, options, account_id, tx)
                .await;
        }

        let url = format!(
            "{}/chat/completions",
            options.base_url.trim_end_matches('/')
        );

        let transformed = strip_thinking_blocks(&request.messages);
        let converted = convert_messages_for_openai(&transformed);

        let mut messages = Vec::new();
        if !request.system_prompt.is_empty() {
            messages.push(json!({"role": "system", "content": request.system_prompt}));
        }
        messages.extend(converted);

        if should_use_responses_api(&request, &options) {
            return self
                .stream_responses_api(request, options, messages, tx)
                .await;
        }

        let body = build_chat_completions_request_body(&request, messages, &options.base_url);

        let is_copilot = is_github_copilot_request(&options);
        let model_name = request.model.clone();

        let response = with_retry(
            options.max_retries,
            options.retry_base_delay_ms,
            options.max_retry_delay_ms,
            options.cancel.clone(),
            options.retry_callback.clone(),
            || {
                let mut r = apply_bearer_auth(
                    self.client
                        .post(&url)
                        .header("Content-Type", "application/json"),
                    &options.api_key,
                );
                for (k, v) in &options.headers {
                    r = r.header(k.as_str(), v.as_str());
                }
                let body_clone = body.clone();
                let model_name = model_name.clone();
                async move {
                    let resp = r
                        .json(&body_clone)
                        .send()
                        .await
                        .map_err(|e| KordiError::Provider(format!("Request failed: {e}")))?;
                    if !resp.status().is_success() {
                        let status = resp.status();
                        let body = resp.text().await.unwrap_or_default();
                        let message = if is_copilot {
                            format_github_copilot_error(status, &body, &model_name)
                        } else {
                            format!("HTTP {status}: {body}")
                        };
                        return Err(KordiError::Provider(message));
                    }
                    Ok(resp)
                }
            },
        )
        .await?;

        use futures::StreamExt;
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut current_event_name: Option<String> = None;
        let mut tool_calls: Vec<(String, String, String)> = Vec::new();

        loop {
            let chunk_result = tokio::select! {
                _ = options.cancel.cancelled() => {
                    let _ = tx.send(StreamEvent::Done);
                    return Ok(());
                }
                chunk_result = stream.next() => chunk_result,
            };
            let Some(chunk_result) = chunk_result else {
                break;
            };

            let chunk =
                chunk_result.map_err(|e| KordiError::Provider(format!("Stream error: {e}")))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();

                if line.is_empty() {
                    current_event_name = None;
                    continue;
                }

                if let Some(event_name) = line.strip_prefix("event:").map(str::trim) {
                    current_event_name = Some(event_name.to_string());
                    continue;
                }

                if let Some(data) = line.strip_prefix("data:").map(str::trim_start) {
                    if data == "[DONE]" {
                        for (id, name, args) in &tool_calls {
                            let _ = tx.send(StreamEvent::ToolCallStart {
                                id: id.clone(),
                                name: name.clone(),
                            });
                            let _ = tx.send(StreamEvent::ToolCallDelta {
                                id: id.clone(),
                                arguments_delta: args.clone(),
                            });
                            let _ = tx.send(StreamEvent::ToolCallEnd { id: id.clone() });
                        }
                        let _ = tx.send(StreamEvent::Done);
                        return Ok(());
                    }

                    match serde_json::from_str::<Value>(data) {
                        Ok(event) => {
                            if current_event_name.as_deref() == Some("error")
                                || openai_sse_error_message(&event).is_some()
                            {
                                let message = openai_sse_error_message(&event)
                                    .unwrap_or_else(|| data.to_string());
                                let _ = tx.send(StreamEvent::Error { message });
                                let _ = tx.send(StreamEvent::Done);
                                return Ok(());
                            }
                            process_openai_sse(&event, &tx, &mut tool_calls);
                        }
                        Err(_) if current_event_name.as_deref() == Some("error") => {
                            let _ = tx.send(StreamEvent::Error {
                                message: data.to_string(),
                            });
                            let _ = tx.send(StreamEvent::Done);
                            return Ok(());
                        }
                        Err(_) => {}
                    }
                }
            }
        }

        for (id, name, args) in &tool_calls {
            let _ = tx.send(StreamEvent::ToolCallStart {
                id: id.clone(),
                name: name.clone(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: id.clone(),
                arguments_delta: args.clone(),
            });
            let _ = tx.send(StreamEvent::ToolCallEnd { id: id.clone() });
        }
        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

fn build_chat_completions_request_body(
    request: &CompletionRequest,
    messages: Vec<Value>,
    base_url: &str,
) -> Value {
    let mut body = json!({
        "model": &request.model,
        "messages": messages,
        "stream": true,
    });

    let is_groq = base_url.contains("groq.com");
    let is_ollama = base_url.contains("localhost") || base_url.contains("127.0.0.1");

    if let Some(max_tokens) = request.max_tokens {
        if is_groq || is_ollama {
            body["max_tokens"] = json!(max_tokens);
        } else {
            body["max_completion_tokens"] = json!(max_tokens);
        }
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(&request.tools);
    }

    if let Some(ref thinking) = request.thinking
        && let Some(effort) = openai_reasoning_effort(thinking.as_str())
    {
        body["reasoning_effort"] = json!(effort);
    }

    if is_standard_openai_api_base(base_url) {
        body["prompt_cache_key"] = json!(prompt_cache_key_for_request(
            &request.model,
            &request.system_prompt,
        ));
    }

    body
}

fn openai_reasoning_effort(thinking: &str) -> Option<&'static str> {
    match thinking {
        "default" => None,
        "off" => Some("none"),
        "low" | "minimal" => Some("low"),
        "medium" => Some("medium"),
        "high" | "xhigh" => Some("high"),
        _ => Some("medium"),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_bearer_auth, build_chat_completions_request_body, openai_reasoning_effort,
        prompt_cache_key_for_request,
    };
    use crate::CompletionRequest;
    use reqwest::Client;
    use serde_json::json;

    fn completion_request(model: &str, system_prompt: &str) -> CompletionRequest {
        CompletionRequest {
            system_prompt: system_prompt.to_string(),
            messages: vec![],
            tools: vec![],
            extra_tool_schemas: vec![],
            model: model.to_string(),
            max_tokens: None,
            stream: true,
            thinking: None,
        }
    }

    fn identity_prompt_with_dynamic_ids() -> String {
        concat!(
            "stable instructions\n",
            "<multi_participant_identity_context version=\"v1\">\n",
            "session_id: session-high-cardinality-123\n",
            "participant_graph_hash: graph-hash-abcdef\n",
            "permission_policy_hash: policy-hash-987654\n",
            "humanId: human-secret-id\n",
            "agentId: agent-secret-id\n",
            "bridgeNodeId: bridge-node-secret\n",
            "identityId: human:alice\n",
            "identityId: agent:alice-kordi\n",
        )
        .to_string()
    }

    #[test]
    fn prompt_cache_key_for_ordinary_prompt_uses_model_key() {
        assert_eq!(
            prompt_cache_key_for_request("gpt-4.1", "ordinary system prompt"),
            "kordi:gpt-4.1"
        );
    }

    #[test]
    fn prompt_cache_key_for_identity_prompt_is_low_cardinality() {
        let key = prompt_cache_key_for_request("gpt-4.1", &identity_prompt_with_dynamic_ids());

        assert_eq!(key, "kordi:gpt-4.1:identity-v1");
        for forbidden in [
            "session-high-cardinality-123",
            "graph-hash-abcdef",
            "policy-hash-987654",
            "human-secret-id",
            "agent-secret-id",
            "bridge-node-secret",
            "human:alice",
            "agent:alice-kordi",
        ] {
            assert!(!key.contains(forbidden), "cache key leaked {forbidden}");
        }
    }

    #[test]
    fn chat_completions_body_uses_identity_prompt_cache_key_without_retention_by_default() {
        let request = completion_request("gpt-4.1", &identity_prompt_with_dynamic_ids());
        let body = build_chat_completions_request_body(
            &request,
            vec![json!({"role": "system", "content": &request.system_prompt})],
            "https://api.openai.com/v1",
        );

        assert_eq!(
            body["prompt_cache_key"],
            prompt_cache_key_for_request("gpt-4.1", request.system_prompt.as_str())
        );
        assert_eq!(body["prompt_cache_key"], "kordi:gpt-4.1:identity-v1");
        assert!(body.get("prompt_cache_retention").is_none());
    }

    #[test]
    fn default_thinking_omits_reasoning_effort() {
        assert_eq!(openai_reasoning_effort("default"), None);
        assert_eq!(openai_reasoning_effort("off"), Some("none"));
        assert_eq!(openai_reasoning_effort("minimal"), Some("low"));
        assert_eq!(openai_reasoning_effort("xhigh"), Some("high"));
    }

    #[test]
    fn bearer_auth_is_omitted_when_api_key_is_empty() {
        let request = apply_bearer_auth(Client::new().get("http://localhost/v1/models"), "")
            .build()
            .expect("request builds");

        assert!(request.headers().get("Authorization").is_none());
    }

    #[test]
    fn bearer_auth_is_added_when_api_key_is_present() {
        let request = apply_bearer_auth(
            Client::new().get("http://localhost/v1/models"),
            " local-secret ",
        )
        .build()
        .expect("request builds");

        assert_eq!(
            request
                .headers()
                .get("Authorization")
                .and_then(|value| value.to_str().ok()),
            Some("Bearer local-secret")
        );
    }
}
