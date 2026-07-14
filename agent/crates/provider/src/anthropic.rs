pub mod capabilities;
mod events;

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use reqwest::Client;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::retry::with_retry;
use crate::transforms::convert_messages_for_anthropic;
use crate::{CompletionRequest, Provider, ProviderAuthMode, RequestOptions, StreamEvent};

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
        let url = format!("{}/v1/messages", options.base_url.trim_end_matches('/'));
        let is_oauth = matches!(options.auth_mode, ProviderAuthMode::OAuth);

        let mut messages = convert_messages_for_anthropic(&request.messages);
        apply_cache_control_to_last_user_message(&mut messages);

        let (tools, hosted_web_search) =
            build_anthropic_tools(&request.tools, &request.extra_tool_schemas);

        let mut body = json!({
            "model": request.model,
            "messages": messages,
            "max_tokens": request.max_tokens.unwrap_or(16384),
            "stream": true,
        });

        if is_oauth {
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

        if let Some(ref thinking) = request.thinking
            && thinking.as_str() != "default"
        {
            if supports_adaptive_thinking(&request.model) {
                let effort = match thinking.as_str() {
                    "minimal" | "low" => "low",
                    "medium" => "medium",
                    "high" => "high",
                    "xhigh" => {
                        if request.model.contains("opus-4-6") {
                            "max"
                        } else {
                            "high"
                        }
                    }
                    _ => "medium",
                };
                body["thinking"] = json!({ "type": "adaptive" });
                body["output_config"] = json!({ "effort": effort });
            } else {
                let budget = match thinking.as_str() {
                    "minimal" => 1024,
                    "low" => 2048,
                    "medium" => 8192,
                    "high" => 16384,
                    "xhigh" => 32768,
                    _ => 8192,
                };
                body["thinking"] = json!({
                    "type": "enabled",
                    "budget_tokens": budget,
                });
                if request.max_tokens.unwrap_or(0) < (budget as u32 + 4096) {
                    body["max_tokens"] = json!(budget + 4096);
                }
            }
        }

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
                async move {
                    let resp = r
                        .json(&body_clone)
                        .send()
                        .await
                        .map_err(|e| KordiError::Provider(format!("Request failed: {e}")))?;
                    if !resp.status().is_success() {
                        let status = resp.status();
                        let body = resp.text().await.unwrap_or_default();
                        return Err(KordiError::Provider(format!("HTTP {status}: {body}")));
                    }
                    Ok(resp)
                }
            },
        )
        .await?;

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

            let chunk =
                chunk_result.map_err(|e| KordiError::Provider(format!("Stream error: {e}")))?;
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
                                        .unwrap_or_else(|| data.to_string());
                                    let _ = tx.send(StreamEvent::Error {
                                        message: message.clone(),
                                    });
                                    return Err(KordiError::Provider(message));
                                }
                                event_state.process_sse_event(
                                    &event,
                                    &tx,
                                    cache_metrics_source_for_auth_mode(&options.auth_mode),
                                );
                            }
                            Err(_) if event_name == Some("error") => {
                                let message = data.to_string();
                                let _ = tx.send(StreamEvent::Error {
                                    message: message.clone(),
                                });
                                return Err(KordiError::Provider(message));
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

fn supports_adaptive_thinking(model: &str) -> bool {
    model.contains("claude-opus-4-6") || model.contains("claude-sonnet-4-6")
}

#[cfg(test)]
mod tests {
    use super::{
        CacheMetricsSource, ProviderAuthMode, anthropic_beta_header, anthropic_oauth_beta_header,
        apply_cache_control_to_last_user_message, build_anthropic_tools,
        cache_metrics_source_for_auth_mode, next_sse_block_delimiter, sse_block_event_name,
        system_text_block,
    };
    use serde_json::json;

    #[test]
    fn anthropic_tools_prefer_hosted_web_search_over_custom_function() {
        let tools = vec![
            json!({
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": "Search with custom DuckDuckGo fallback",
                    "parameters": {"type": "object", "properties": {"query": {"type": "string"}}}
                }
            }),
            json!({
                "type": "function",
                "function": {
                    "name": "read",
                    "description": "Read a file",
                    "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}
                }
            }),
        ];

        let (converted, hosted_web_search) = build_anthropic_tools(&tools, &[]);

        assert!(hosted_web_search);
        assert_eq!(converted.len(), 2);
        assert_eq!(converted[0]["type"], "web_search_20250305");
        assert_eq!(converted[0]["name"], "web_search");
        assert_eq!(converted[1]["name"], "read");
        assert_eq!(
            converted
                .iter()
                .filter(|tool| tool["name"] == "web_search")
                .count(),
            1,
        );
    }

    #[test]
    fn anthropic_beta_headers_enable_web_search_only_when_hosted_search_is_present() {
        assert_eq!(
            anthropic_beta_header(false),
            "fine-grained-tool-streaming-2025-05-14"
        );
        assert_eq!(
            anthropic_beta_header(true),
            "fine-grained-tool-streaming-2025-05-14,web-search-2025-03-05"
        );
        assert_eq!(
            anthropic_oauth_beta_header(true),
            "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,web-search-2025-03-05"
        );
    }

    #[test]
    fn api_key_uses_official_cache_metrics_and_oauth_uses_estimates() {
        assert_eq!(
            cache_metrics_source_for_auth_mode(&ProviderAuthMode::ApiKey),
            CacheMetricsSource::Official
        );
        assert_eq!(
            cache_metrics_source_for_auth_mode(&ProviderAuthMode::OAuth),
            CacheMetricsSource::Estimated
        );
    }

    #[test]
    fn parses_lf_and_crlf_sse_block_boundaries() {
        assert_eq!(
            next_sse_block_delimiter("event: ping\n\nrest"),
            Some((11, 2))
        );
        assert_eq!(
            next_sse_block_delimiter("event: ping\r\n\r\nrest"),
            Some((11, 4))
        );
        assert_eq!(
            sse_block_event_name("event: error\r\ndata: boom"),
            Some("error")
        );
    }

    #[test]
    fn system_blocks_include_ephemeral_cache_control() {
        let block = system_text_block("system prompt");
        assert_eq!(block["type"], "text");
        assert_eq!(block["text"], "system prompt");
        assert_eq!(block["cache_control"], json!({ "type": "ephemeral" }));
    }

    #[test]
    fn adds_cache_control_to_last_user_message_text_block() {
        let mut messages = vec![
            json!({"role": "assistant", "content": "previous"}),
            json!({"role": "user", "content": [{"type": "text", "text": "hello"}]}),
        ];

        apply_cache_control_to_last_user_message(&mut messages);

        assert_eq!(
            messages[1]["content"][0]["cache_control"],
            json!({ "type": "ephemeral" })
        );
    }

    #[test]
    fn converts_string_user_message_into_cacheable_text_block() {
        let mut messages = vec![json!({"role": "user", "content": "hello"})];

        apply_cache_control_to_last_user_message(&mut messages);

        assert_eq!(messages[0]["content"][0]["type"], "text");
        assert_eq!(messages[0]["content"][0]["text"], "hello");
        assert_eq!(
            messages[0]["content"][0]["cache_control"],
            json!({ "type": "ephemeral" })
        );
    }
}
