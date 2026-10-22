use super::*;

use kordi_core::types::CacheMetricsSource;

use crate::UsageInfo;

fn usage_info(usage: &Value) -> UsageInfo {
    let input = usage
        .get("promptTokenCount")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let output = usage
        .get("candidatesTokenCount")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let cache_read = usage
        .get("cachedContentTokenCount")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    UsageInfo {
        input_tokens: input.saturating_sub(cache_read),
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: 0,
        cache_metrics_source: CacheMetricsSource::Official,
    }
}

pub(super) fn process_google_event(event: &Value, tx: &mpsc::UnboundedSender<StreamEvent>) {
    if let Some(usage) = event.get("usageMetadata") {
        let _ = tx.send(StreamEvent::Usage(usage_info(usage)));
    }

    let candidates = match event
        .get("candidates")
        .and_then(|candidate| candidate.as_array())
    {
        Some(candidates) => candidates,
        None => return,
    };

    for candidate in candidates {
        if let Some(chunks) = candidate["groundingMetadata"]["groundingChunks"].as_array() {
            let sources: Vec<_> = chunks
                .iter()
                .filter_map(|chunk| {
                    let web = &chunk["web"];
                    Some(json!({"url":web["uri"].as_str()?, "title":web["title"]}))
                })
                .collect();
            let _ = tx.send(StreamEvent::ServerToolResult {
                tool_use_id: "native-web-search".into(),
                name: "web_search".into(),
                result: json!({"sources":sources}),
                is_error: false,
            });
        }
        let parts = match candidate
            .get("content")
            .and_then(|content| content.get("parts"))
            .and_then(|parts| parts.as_array())
        {
            Some(parts) => parts,
            None => continue,
        };

        for part in parts {
            if let Some(text) = part
                .get("text")
                .and_then(|value| value.as_str())
                .filter(|text| !text.is_empty())
            {
                let _ = tx.send(StreamEvent::TextDelta {
                    text: text.to_string(),
                });
            }

            let Some(function_call) = part.get("functionCall") else {
                continue;
            };
            let Some(name) = function_call
                .get("name")
                .and_then(|value| value.as_str())
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            let args = function_call
                .get("args")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let id = format!("call_{name}");
            let _ = tx.send(StreamEvent::ToolCallStart {
                id: id.clone(),
                name: name.to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallDelta {
                id: id.clone(),
                arguments_delta: args.to_string(),
            });
            let _ = tx.send(StreamEvent::ToolCallEnd { id });
        }
    }
}
