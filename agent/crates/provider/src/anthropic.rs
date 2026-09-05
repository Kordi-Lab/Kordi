pub mod capabilities;
mod events;

use async_trait::async_trait;
use kordi_core::agent_session::ThinkingLevel;
use kordi_core::error::{KordiError, KordiResult};
use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::error::{ProviderError, ProviderErrorFormat, unexpected_response_with_sensitive_values};
use crate::retry::with_retry;
use crate::transforms::convert_messages_for_anthropic;
use crate::{CompletionRequest, Provider, ProviderAuthMode, RequestOptions, StreamEvent};

use capabilities::{
    ClaudeThinkingMode, ThinkingOffBehavior, adaptive_effort, capabilities_for_model,
    clamp_thinking_level,
};
use events::{AnthropicEventState, sse_error_message};
use kordi_core::types::CacheMetricsSource;

/// Anthropic Messages API provider.
pub struct AnthropicProvider {
    client: Client,
}

impl Default for AnthropicProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl AnthropicProvider {
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

#[async_trait]
impl Provider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    async fn stream(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let url = format!("{}/v1/messages", options.base_url.trim_end_matches('/'));
        let is_oauth = matches!(options.auth_mode, ProviderAuthMode::OAuth);

        let mut messages = convert_messages_for_anthropic(&request.messages);
        apply_cache_control_to_last_user_message(&mut messages);

        let (tools, hosted_web_search) =
            build_anthropic_tools(&request.tools, &request.extra_tool_schemas);

        let body = build_anthropic_request_body(&request, options.auth_mode, messages, tools);
        let provider_name = options.provider.clone();
        let sensitive_values = options.sensitive_values();

        let response = with_retry(
            options.max_retries,
            options.retry_base_delay_ms,
            options.max_retry_delay_ms,
            options.cancel.clone(),
            options.retry_callback.clone(),
            || {
                let mut r = self
                    .client
                    .post(&url)
                    .header("anthropic-version", "2023-06-01")
                    .header("content-type", "application/json")
                    .header("accept", "application/json")
                    .header("anthropic-dangerous-direct-browser-access", "true");

                if is_oauth {
                    r = r
                        .header("Authorization", format!("Bearer {}", options.api_key))
                        .header(
                            "anthropic-beta",
                            anthropic_oauth_beta_header(hosted_web_search),
                        )
                        .header("user-agent", "claude-cli/2.1.75")
                        .header("x-app", "cli");
                } else {
                    r = r
                        .header("x-api-key", &options.api_key)
                        .header("anthropic-beta", anthropic_beta_header(hosted_web_search));
                }

                for (k, v) in &options.headers {
                    r = r.header(k.as_str(), v.as_str());
                }
                let body_clone = body.clone();
                let request_url = url.clone();
                let provider_name = provider_name.clone();
                let sensitive_values = sensitive_values.clone();
                async move {
                    let resp = r.json(&body_clone).send().await.map_err(|error| {
                        ProviderError::from_reqwest(
                            &provider_name,
                            "messages",
                            &request_url,
                            &error,
                        )
                    })?;
                    if !resp.status().is_success() {
                        return Err(unexpected_response_with_sensitive_values(
                            &provider_name,
                            "messages",
                            ProviderErrorFormat::Anthropic,
                            resp,
                            &sensitive_values,
                        )
                        .await);
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
        let mut event_state = AnthropicEventState::default();

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
                            "messages stream",
                            &url,
                            &error,
                        ),
                    });
                    let _ = tx.send(StreamEvent::Done);
                    return Ok(());
                }
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            while let Some((pos, delimiter_len)) = next_sse_block_delimiter(&buffer) {
                let block = buffer[..pos].to_string();
                buffer = buffer[pos + delimiter_len..].to_string();
                let event_name = sse_block_event_name(&block);

                for line in block.lines() {
                    let line = line.trim_end_matches('\r');
                    if let Some(data) = line.strip_prefix("data:").map(str::trim_start) {
                        if data == "[DONE]" {
                            let _ = tx.send(StreamEvent::Done);
                            return Ok(());
                        }
                        match serde_json::from_str::<Value>(data) {
                            Ok(event) => {
                                if event_name == Some("error")
                                    || sse_error_message(&event).is_some()
                                {
                                    let message = sse_error_message(&event)
                                        .unwrap_or_else(|| "Unknown error".to_string());
                                    let code = event
                                        .get("error")
                                        .and_then(|error| error.get("type"))
                                        .and_then(|value| value.as_str())
                                        .or_else(|| {
                                            event.get("error_type").and_then(|value| value.as_str())
                                        });
                                    let _ = tx.send(StreamEvent::Error {
                                        error: ProviderError::stream_with_sensitive_values(
                                            &options.provider,
                                            "messages stream",
                                            Some(&message),
                                            code,
                                            &sensitive_values,
                                        ),
                                    });
                                    let _ = tx.send(StreamEvent::Done);
                                    return Ok(());
                                }
                                event_state.process_sse_event(
                                    &event,
                                    &tx,
                                    cache_metrics_source_for_auth_mode(&options.auth_mode),
                                );
                            }
                            Err(_) if event_name == Some("error") => {
                                let _ = tx.send(StreamEvent::Error {
                                    error: ProviderError::stream_with_sensitive_values(
                                        &options.provider,
                                        "messages stream",
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
        }

        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

fn function_tool_name(tool: &Value) -> Option<&str> {
    tool.get("function")?
        .get("name")?
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

fn build_anthropic_tools(tools: &[Value], extra_tool_schemas: &[Value]) -> (Vec<Value>, bool) {
    let mut converted = Vec::new();
    let mut hosted_web_search = false;

    for tool in tools {
        let Some(func) = tool.get("function") else {
            continue;
        };
        let name = function_tool_name(tool).unwrap_or("tool");
        if name == "web_search" {
            hosted_web_search = true;
            continue;
        }
        converted.push(json!({
            "name": name,
            "description": func.get("description").cloned().unwrap_or_else(|| json!("")),
            "input_schema": func.get("parameters").cloned().unwrap_or_else(|| json!({"type": "object"})),
        }));
    }

    if hosted_web_search {
        converted.insert(
            0,
            json!({
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 5,
            }),
        );
    }
    converted.extend(extra_tool_schemas.iter().cloned());

    (converted, hosted_web_search)
}

fn build_anthropic_request_body(
    request: &CompletionRequest,
    auth_mode: ProviderAuthMode,
    messages: Vec<Value>,
    tools: Vec<Value>,
) -> Value {
    let max_tokens = request.max_tokens.unwrap_or(16_384);
    let mut body = json!({
        "model": request.model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": true,
    });

    if matches!(auth_mode, ProviderAuthMode::OAuth) {
        let mut system_blocks = vec![system_text_block(
            "You are Claude Code, Anthropic's official CLI for Claude.",
        )];
        if !request.system_prompt.is_empty() {
            system_blocks.push(system_text_block(&request.system_prompt));
        }
        body["system"] = json!(system_blocks);
    } else if !request.system_prompt.is_empty() {
        body["system"] = json!([system_text_block(&request.system_prompt)]);
    }

    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }

    let Some(thinking) = request.thinking.as_deref() else {
        return body;
    };
    if thinking == "default" {
        return body;
    }

    let requested = ThinkingLevel::parse(thinking).unwrap_or(ThinkingLevel::Medium);
    let capabilities = capabilities_for_model(&request.model);
    if requested == ThinkingLevel::Off {
        if capabilities
            .is_some_and(|capabilities| capabilities.thinking_off == ThinkingOffBehavior::Disabled)
        {
            body["thinking"] = json!({ "type": "disabled" });
        }
        return body;
    }

    let effective = clamp_thinking_level(&request.model, requested).unwrap_or(match requested {
        ThinkingLevel::XHigh | ThinkingLevel::Max => ThinkingLevel::High,
        other => other,
    });

    if capabilities
        .is_some_and(|capabilities| capabilities.thinking_mode == ClaudeThinkingMode::Adaptive)
    {
        if let Some(effort) = adaptive_effort(&request.model, effective) {
            body["thinking"] = json!({
                "type": "adaptive",
                "display": "summarized",
            });
            body["output_config"] = json!({ "effort": effort });
        }
        return body;
    }

    let budget: u32 = match effective {
        ThinkingLevel::Minimal => 1_024,
        ThinkingLevel::Low => 2_048,
        ThinkingLevel::Medium => 8_192,
        ThinkingLevel::High | ThinkingLevel::XHigh | ThinkingLevel::Max => 16_384,
        ThinkingLevel::Off | ThinkingLevel::Default => return body,
    };
    body["thinking"] = json!({
        "type": "enabled",
        "budget_tokens": budget,
    });
    if max_tokens < budget + 4_096 {
        body["max_tokens"] = json!(budget + 4_096);
    }

    body
}

fn anthropic_beta_header(hosted_web_search: bool) -> &'static str {
    if hosted_web_search {
        "fine-grained-tool-streaming-2025-05-14,web-search-2025-03-05"
    } else {
        "fine-grained-tool-streaming-2025-05-14"
    }
}

fn anthropic_oauth_beta_header(hosted_web_search: bool) -> &'static str {
    if hosted_web_search {
        "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,web-search-2025-03-05"
    } else {
        "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14"
    }
}

fn cache_metrics_source_for_auth_mode(auth_mode: &ProviderAuthMode) -> CacheMetricsSource {
    match auth_mode {
        ProviderAuthMode::ApiKey => CacheMetricsSource::Official,
        ProviderAuthMode::OAuth => CacheMetricsSource::Estimated,
    }
}

fn next_sse_block_delimiter(buffer: &str) -> Option<(usize, usize)> {
    match (buffer.find("\n\n"), buffer.find("\r\n\r\n")) {
        (Some(lf), Some(crlf)) if crlf < lf => Some((crlf, 4)),
        (Some(lf), _) => Some((lf, 2)),
        (None, Some(crlf)) => Some((crlf, 4)),
        (None, None) => None,
    }
}

fn sse_block_event_name(block: &str) -> Option<&str> {
    block.lines().find_map(|line| {
        line.trim_end_matches('\r')
            .strip_prefix("event:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn anthropic_cache_control() -> Value {
    json!({ "type": "ephemeral" })
}

fn system_text_block(text: &str) -> Value {
    json!({
        "type": "text",
        "text": text,
        "cache_control": anthropic_cache_control(),
    })
}

fn apply_cache_control_to_last_user_message(messages: &mut [Value]) {
    let Some(last_message) = messages
        .iter_mut()
        .rev()
        .find(|message| message.get("role").and_then(|value| value.as_str()) == Some("user"))
    else {
        return;
    };

    match last_message.get_mut("content") {
        Some(Value::Array(parts)) => {
            if let Some(Value::Object(last_part)) = parts.last_mut() {
                let block_type = last_part.get("type").and_then(|value| value.as_str());
                if matches!(block_type, Some("text" | "image" | "tool_result")) {
                    last_part.insert("cache_control".to_string(), anthropic_cache_control());
                }
            }
        }
        Some(Value::String(text)) => {
            let converted = json!([{
                "type": "text",
                "text": text.clone(),
                "cache_control": anthropic_cache_control(),
            }]);
            last_message["content"] = converted;
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests;
