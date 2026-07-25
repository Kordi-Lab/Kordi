mod request;

#[cfg(test)]
mod request_tests;

use super::*;
use futures::StreamExt;
use std::collections::HashSet;

use crate::UsageInfo;
use crate::error::{ProviderError, ProviderErrorFormat, unexpected_response_with_sensitive_values};
use request::{
    codex_reasoning_effort, convert_messages_for_codex, convert_tools_for_codex, resolve_codex_url,
};

fn oauth_usage_info(usage: &Value) -> UsageInfo {
    let cached = usage
        .get("input_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let input = usage
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    UsageInfo {
        input_tokens: input.saturating_sub(cached),
        output_tokens: output,
        cache_read_tokens: cached,
        cache_write_tokens: 0,
        cache_metrics_source: kordi_core::types::CacheMetricsSource::Estimated,
    }
}

fn codex_error_message(event: &Value, fallback: &str) -> String {
    event
        .get("message")
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| {
            event
                .get("response")
                .and_then(|response| response.get("error"))
                .and_then(|error| error.get("message"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| {
            event
                .get("response")
                .and_then(|response| response.get("incomplete_details"))
                .and_then(|details| details.get("reason"))
                .and_then(|value| value.as_str())
        })
        .map(ToString::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

fn codex_error_code(event: &Value) -> Option<&str> {
    event
        .get("error")
        .and_then(|error| error.get("code").or_else(|| error.get("type")))
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .get("response")
                .and_then(|response| response.get("error"))
                .and_then(|error| error.get("code").or_else(|| error.get("type")))
                .and_then(|value| value.as_str())
        })
}

fn build_codex_request_body(request: &CompletionRequest) -> Value {
    let mut body = json!({
        "model": request.model,
        "store": false,
        "stream": true,
        "instructions": request.system_prompt,
        "input": convert_messages_for_codex(&request.messages),
        "text": { "verbosity": "medium" },
        "include": ["reasoning.encrypted_content"],
        "tool_choice": "auto",
        "parallel_tool_calls": false,
    });

    if !request.tools.is_empty() {
        body["tools"] = json!(convert_tools_for_codex(&request.tools));
    }
    if let Some(ref thinking) = request.thinking
        && let Some(effort) = codex_reasoning_effort(&request.model, thinking.as_str())
    {
        body["reasoning"] = json!({
            "effort": effort,
            "summary": "auto"
        });
    }
    body["prompt_cache_key"] = json!(super::default_prompt_cache_key(&request.model));
    body
}

impl OpenAiProvider {
    pub(super) async fn stream_codex_oauth(
        &self,
        request: CompletionRequest,
        options: RequestOptions,
        account_id: String,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> KordiResult<()> {
        let url = resolve_codex_url(&options.base_url);
        let body = build_codex_request_body(&request);
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
                    .header("Authorization", format!("Bearer {}", options.api_key))
                    .header("chatgpt-account-id", &account_id)
                    .header("OpenAI-Beta", "responses=experimental")
                    .header("accept", "text/event-stream")
                    .header("content-type", "application/json")
                    .header("originator", "kordi")
                    .header("User-Agent", "kordi");
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
                            "Codex OAuth responses",
                            &request_url,
                            &error,
                        )
                    })?;
                    if !resp.status().is_success() {
                        return Err(unexpected_response_with_sensitive_values(
                            &provider_name,
                            "Codex OAuth responses",
                            ProviderErrorFormat::OpenAi,
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

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut started_tool_calls: HashSet<String> = HashSet::new();
        let mut completed_tool_calls: HashSet<String> = HashSet::new();

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
                            "Codex OAuth response stream",
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
                    continue;
                }
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                if data == "[DONE]" {
                    let _ = tx.send(StreamEvent::Done);
                    return Ok(());
                }
                let Ok(event) = serde_json::from_str::<Value>(data) else {
                    continue;
                };

                match event.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "response.output_item.added" => {
                        if let Some(item) = event.get("item")
                            && item.get("type").and_then(|v| v.as_str()) == Some("function_call")
                        {
                            let call_id = item
                                .get("call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("toolcall");
                            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("item");
                            let id = format!("{call_id}|{item_id}");
                            let name = item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            if started_tool_calls.insert(id.clone()) {
                                let _ = tx.send(StreamEvent::ToolCallStart { id, name });
                            }
                        }
                    }
                    "response.output_text.delta" => {
                        if let Some(delta) = event.get("delta").and_then(|v| v.as_str())
                            && !delta.is_empty()
                        {
                            let _ = tx.send(StreamEvent::TextDelta {
                                text: delta.to_string(),
                            });
                        }
                    }
                    "response.reasoning_summary_text.delta" => {
                        if let Some(delta) = event.get("delta").and_then(|v| v.as_str())
                            && !delta.is_empty()
                        {
                            let _ = tx.send(StreamEvent::ThinkingDelta {
                                text: delta.to_string(),
                            });
                        }
                    }
                    "response.function_call_arguments.delta" => {}
                    "response.output_item.done" => {
                        if let Some(item) = event.get("item")
                            && item.get("type").and_then(|v| v.as_str()) == Some("function_call")
                        {
                            let call_id = item
                                .get("call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("toolcall");
                            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("item");
                            let id = format!("{call_id}|{item_id}");
                            let name = item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let arguments = item
                                .get("arguments")
                                .and_then(|v| v.as_str())
                                .unwrap_or("{}");

                            if started_tool_calls.insert(id.clone()) {
                                let _ = tx.send(StreamEvent::ToolCallStart {
                                    id: id.clone(),
                                    name,
                                });
                            }
                            let _ = tx.send(StreamEvent::ToolCallDelta {
                                id: id.clone(),
                                arguments_delta: arguments.to_string(),
                            });
                            if completed_tool_calls.insert(id.clone()) {
                                let _ = tx.send(StreamEvent::ToolCallEnd { id });
                            }
                        }
                    }
                    "response.completed" | "response.done" | "response.incomplete" => {
                        if let Some(usage) = event.get("response").and_then(|r| r.get("usage")) {
                            let _ = tx.send(StreamEvent::Usage(oauth_usage_info(usage)));
                        }
                        let _ = tx.send(StreamEvent::Done);
                        return Ok(());
                    }
                    "response.failed" => {
                        let message = codex_error_message(&event, "Codex response failed");
                        let code = codex_error_code(&event);
                        let _ = tx.send(StreamEvent::Error {
                            error: ProviderError::stream_with_sensitive_values(
                                &options.provider,
                                "Codex OAuth response stream",
                                Some(&message),
                                code,
                                &sensitive_values,
                            ),
                        });
                        let _ = tx.send(StreamEvent::Done);
                        return Ok(());
                    }
                    "error" => {
                        let message = codex_error_message(&event, "Codex stream error");
                        let code = codex_error_code(&event);
                        let _ = tx.send(StreamEvent::Error {
                            error: ProviderError::stream_with_sensitive_values(
                                &options.provider,
                                "Codex OAuth response stream",
                                Some(&message),
                                code,
                                &sensitive_values,
                            ),
                        });
                        let _ = tx.send(StreamEvent::Done);
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }

        let _ = tx.send(StreamEvent::Done);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{build_codex_request_body, oauth_usage_info};
    use crate::CompletionRequest;
    use kordi_core::types::CacheMetricsSource;
    use serde_json::json;

    #[test]
    fn oauth_usage_is_marked_as_estimated() {
        let usage = oauth_usage_info(&json!({
            "input_tokens": 120,
            "output_tokens": 30,
            "input_tokens_details": {"cached_tokens": 80}
        }));

        assert_eq!(usage.input_tokens, 40);
        assert_eq!(usage.output_tokens, 30);
        assert_eq!(usage.cache_read_tokens, 80);
        assert_eq!(usage.cache_metrics_source, CacheMetricsSource::Estimated);
    }

    #[test]
    fn codex_body_preserves_gpt_56_max_reasoning() {
        let mut request = CompletionRequest {
            system_prompt: "system".to_string(),
            messages: vec![],
            tools: vec![],
            extra_tool_schemas: vec![],
            model: "gpt-5.6-luna".to_string(),
            max_tokens: None,
            stream: true,
            thinking: Some("max".to_string()),
        };

        let body = build_codex_request_body(&request);
        assert_eq!(body["reasoning"]["effort"], "max");

        request.thinking = Some("xhigh".to_string());
        let body = build_codex_request_body(&request);
        assert_eq!(body["reasoning"]["effort"], "xhigh");

        request.thinking = Some("minimal".to_string());
        let body = build_codex_request_body(&request);
        assert_eq!(body["reasoning"]["effort"], "low");

        request.thinking = Some("off".to_string());
        let body = build_codex_request_body(&request);
        assert_eq!(body["reasoning"]["effort"], "none");
    }
}
