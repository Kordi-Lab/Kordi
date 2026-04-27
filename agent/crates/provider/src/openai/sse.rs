use super::*;

use kordi_core::types::CacheMetricsSource;

use crate::UsageInfo;

pub(super) fn openai_sse_error_message(event: &Value) -> Option<String> {
    event
        .get("message")
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|value| value.as_str())
        })
        .map(ToString::to_string)
}

pub(super) fn process_openai_sse(
    event: &Value,
    tx: &mpsc::UnboundedSender<StreamEvent>,
    tool_calls: &mut Vec<(String, String, String)>,
) {
    if let Some(choices) = event.get("choices").and_then(|c| c.as_array()) {
        for choice in choices {
            let delta = &choice["delta"];

            if let Some(content) = delta.get("content").and_then(|c| c.as_str())
                && !content.is_empty()
            {
                let _ = tx.send(StreamEvent::TextDelta {
                    text: content.to_string(),
                });
            }

            for field in ["reasoning_content", "reasoning", "thinking"] {
                if let Some(thinking) = delta.get(field).and_then(|value| value.as_str())
                    && !thinking.is_empty()
                {
                    let _ = tx.send(StreamEvent::ThinkingDelta {
                        text: thinking.to_string(),
                    });
                }
            }

            if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                for tc in tcs {
                    let index = tc["index"].as_u64().unwrap_or(0) as usize;

                    while tool_calls.len() <= index {
                        tool_calls.push((String::new(), String::new(), String::new()));
                    }

                    if let Some(id) = tc["id"].as_str() {
                        tool_calls[index].0 = id.to_string();
                    }
                    if let Some(name) = tc["function"]["name"].as_str() {
                        tool_calls[index].1 = name.to_string();
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        tool_calls[index].2.push_str(args);
                    }
                }
            }
        }
    }

    if let Some(usage) = event.get("usage") {
        let cached = usage
            .get("prompt_tokens_details")
            .and_then(|d| d.get("cached_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let prompt = usage["prompt_tokens"].as_u64().unwrap_or(0);
        let _ = tx.send(StreamEvent::Usage(UsageInfo {
            input_tokens: prompt.saturating_sub(cached),
            output_tokens: usage["completion_tokens"].as_u64().unwrap_or(0),
            cache_read_tokens: cached,
            cache_write_tokens: 0,
            cache_metrics_source: CacheMetricsSource::Official,
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StreamEvent;
    use serde_json::json;
    use tokio::sync::mpsc;

    #[test]
    fn extracts_lm_studio_stream_error_message() {
        let message = openai_sse_error_message(&json!({
            "error": {"message": "context is too large"},
            "message": "context is too large"
        }));

        assert_eq!(message.as_deref(), Some("context is too large"));
    }

    #[test]
    fn forwards_lm_studio_reasoning_content_as_thinking_delta() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut tool_calls = Vec::new();
        process_openai_sse(
            &json!({
                "choices": [{
                    "delta": {
                        "reasoning_content": "thinking out loud",
                        "content": "answer"
                    }
                }]
            }),
            &tx,
            &mut tool_calls,
        );
        drop(tx);

        match rx.blocking_recv().expect("text delta") {
            StreamEvent::TextDelta { text } => assert_eq!(text, "answer"),
            other => panic!("unexpected first event: {other:?}"),
        }
        match rx.blocking_recv().expect("thinking delta") {
            StreamEvent::ThinkingDelta { text } => assert_eq!(text, "thinking out loud"),
            other => panic!("unexpected second event: {other:?}"),
        }
    }
}
