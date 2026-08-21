pub mod capabilities;
mod codex;
mod responses;
mod sse;

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::error::{ProviderError, ProviderErrorFormat, unexpected_response_with_sensitive_values};
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

fn add_github_copilot_hint(error: ProviderError, model: &str) -> ProviderError {
    let ProviderError::Http(http) = error else {
        return error;
    };
    let http = *http;
    let lower = http.message.to_ascii_lowercase();
    let hint = if http.status == reqwest::StatusCode::UNAUTHORIZED {
        Some("Sign in to GitHub Copilot again and retry.")
    } else if http.status == reqwest::StatusCode::FORBIDDEN {
        Some("Confirm that this GitHub Copilot account and plan can use the selected model.")
    } else if lower.contains("model not supported") || lower.contains("unsupported model") {
        return ProviderError::Http(Box::new(http.with_hint(format!(
            "Enable `{model}` in GitHub Copilot or select another model."
        ))));
    } else {
        None
    };

    ProviderError::Http(Box::new(match hint {
        Some(hint) => http.with_hint(hint),
        None => http,
    }))
}

#[async_trait]
impl Provider for OpenAiProvider {
    fn name(&self) -> &str {
        "openai"
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

        let mut body = json!({
            "model": request.model,
            "messages": messages,
            "stream": true,
        });

        let is_groq = options.base_url.contains("groq.com");
        let is_ollama =
            options.base_url.contains("localhost") || options.base_url.contains("127.0.0.1");

        if let Some(max_tokens) = request.max_tokens {
            if is_groq || is_ollama {
                body["max_tokens"] = json!(max_tokens);
            } else {
                body["max_completion_tokens"] = json!(max_tokens);
            }
        }
        if !request.tools.is_empty() {
            body["tools"] = json!(request.tools);
        }

        if let Some(ref thinking) = request.thinking
            && let Some(effort) = openai_reasoning_effort(
                &request.model,
                thinking.as_str(),
                is_standard_openai_api_base(&options.base_url),
            )
        {
            body["reasoning_effort"] = json!(effort);
        }

        if is_standard_openai_api_base(&options.base_url) {
            body["prompt_cache_key"] = json!(default_prompt_cache_key(&request.model));
        }

        let is_copilot = is_github_copilot_request(&options);
        let model_name = request.model.clone();
        let provider_name = options.provider.clone();
        let sensitive_values = options.sensitive_values();

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
                let request_url = url.clone();
                let provider_name = provider_name.clone();
                let sensitive_values = sensitive_values.clone();
                async move {
                    let resp = r.json(&body_clone).send().await.map_err(|error| {
                        ProviderError::from_reqwest(
                            &provider_name,
                            "chat completions",
                            &request_url,
                            &error,
                        )
                    })?;
                    if !resp.status().is_success() {
                        let error = unexpected_response_with_sensitive_values(
                            &provider_name,
                            "chat completions",
                            ProviderErrorFormat::OpenAi,
                            resp,
                            &sensitive_values,
                        )
                        .await;
                        return Err(if is_copilot {
                            add_github_copilot_hint(error, &model_name)
                        } else {
                            error
                        });
                    }
                    Ok(resp)
                }
            },
        )
        .await
        .map_err(KordiError::from)?;

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

            let chunk = match chunk_result {
                Ok(chunk) => chunk,
                Err(error) => {
                    let _ = tx.send(StreamEvent::Error {
                        error: ProviderError::from_reqwest(
                            &options.provider,
                            "chat completions stream",
                            &url,
                            &error,
                        ),
                    });
                    let _ = tx.send(StreamEvent::Done);
                    return Ok(());
                }
            };
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
                                let message = openai_sse_error_message(&event);
                                let code = event
                                    .get("error")
                                    .and_then(|error| {
                                        error.get("code").or_else(|| error.get("type"))
                                    })
                                    .and_then(|value| value.as_str());
                                let _ = tx.send(StreamEvent::Error {
                                    error: ProviderError::stream_with_sensitive_values(
                                        &options.provider,
                                        "chat completions stream",
                                        message.as_deref(),
                                        code,
                                        &sensitive_values,
                                    ),
                                });
                                let _ = tx.send(StreamEvent::Done);
                                return Ok(());
                            }
                            process_openai_sse(&event, &tx, &mut tool_calls);
                        }
                        Err(_) if current_event_name.as_deref() == Some("error") => {
                            let _ = tx.send(StreamEvent::Error {
                                error: ProviderError::stream_with_sensitive_values(
                                    &options.provider,
                                    "chat completions stream",
                                    None,
                                    None,
                                    &sensitive_values,
                                ),
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

fn openai_reasoning_effort(
    model_id: &str,
    thinking: &str,
    official_openai: bool,
) -> Option<&'static str> {
    let route = if official_openai {
        capabilities::OpenAiAuthRoute::Api
    } else {
        capabilities::OpenAiAuthRoute::Compatible
    };
    capabilities::reasoning_effort(model_id, route, thinking)
}

#[cfg(test)]
mod tests {
    use super::{apply_bearer_auth, openai_reasoning_effort};
    use reqwest::Client;

    #[test]
    fn default_thinking_omits_reasoning_effort() {
        assert_eq!(
            openai_reasoning_effort("gpt-5.6-luna", "default", true),
            None
        );
        assert_eq!(
            openai_reasoning_effort("gpt-5.6-luna", "off", true),
            Some("none")
        );
        assert_eq!(
            openai_reasoning_effort("gpt-5.6-luna", "minimal", true),
            Some("minimal")
        );
        assert_eq!(
            openai_reasoning_effort("gpt-5.6-luna", "xhigh", true),
            Some("xhigh")
        );
        assert_eq!(
            openai_reasoning_effort("gpt-5.6-luna", "max", true),
            Some("max")
        );
        assert_eq!(
            openai_reasoning_effort("gpt-5.6-luna", "minimal", false),
            Some("low")
        );
        assert_eq!(
            openai_reasoning_effort("gpt-5.6-luna", "max", false),
            Some("high")
        );
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
