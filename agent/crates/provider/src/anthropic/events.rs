use std::collections::HashMap;

use kordi_core::types::CacheMetricsSource;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::{ProviderError, StreamEvent, UsageInfo};

#[derive(Clone, Debug)]
enum BlockKind {
    ToolUse,
    ServerToolUse,
}

#[derive(Clone, Debug)]
struct TrackedBlock {
    id: String,
    kind: BlockKind,
}

/// Per-stream block index → block metadata for correlating deltas.
#[derive(Default)]
pub(super) struct AnthropicEventState {
    block_id_map: HashMap<u64, TrackedBlock>,
}

fn event_type(event: &Value) -> Option<&str> {
    event.get("type").and_then(|value| value.as_str())
}

fn event_index(event: &Value) -> Option<u64> {
    event.get("index").and_then(|value| value.as_u64())
}

fn usage_info(usage: &Value, cache_metrics_source: CacheMetricsSource) -> UsageInfo {
    UsageInfo {
        input_tokens: usage
            .get("input_tokens")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        output_tokens: usage
            .get("output_tokens")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        cache_read_tokens: usage
            .get("cache_read_input_tokens")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        cache_write_tokens: usage
            .get("cache_creation_input_tokens")
            .and_then(|value| value.as_u64())
            .unwrap_or(0),
        cache_metrics_source,
    }
}

fn non_empty_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .filter(|s| !s.is_empty())
}

pub(super) fn sse_error_message(event: &Value) -> Option<String> {
    if event_type(event) != Some("error") {
        return None;
    }

    let error = event.get("error");
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(|value| value.as_str())
        .or_else(|| event.get("message").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let error_type = error
        .and_then(|error| error.get("type"))
        .and_then(|value| value.as_str())
        .or_else(|| event.get("error_type").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty());

    match (error_type, message) {
        (Some(error_type), Some(message)) => Some(format!("{error_type}: {message}")),
        (None, Some(message)) => Some(message.to_string()),
        _ => Some(event.to_string()),
    }
}

impl AnthropicEventState {
    fn track_block(&mut self, index: u64, id: &str, kind: BlockKind) {
        self.block_id_map.insert(
            index,
            TrackedBlock {
                id: id.to_string(),
                kind,
            },
        );
    }
}

fn server_tool_result_name(block_type: &str) -> Option<&str> {
    let stripped = block_type.trim_end_matches("_tool_result");
    (!stripped.is_empty() && stripped != block_type).then_some(stripped)
}

impl AnthropicEventState {
    pub(super) fn process_sse_event(
        &mut self,
        event: &Value,
        tx: &mpsc::UnboundedSender<StreamEvent>,
        cache_metrics_source: CacheMetricsSource,
    ) {
        match event_type(event) {
            Some("message_start") => {
                self.block_id_map.clear();
                if let Some(usage) = event
                    .get("message")
                    .and_then(|message| message.get("usage"))
                {
                    let _ = tx.send(StreamEvent::Usage(usage_info(usage, cache_metrics_source)));
                }
            }
            Some("content_block_start") => {
                let Some(block) = event.get("content_block") else {
                    return;
                };
                let Some(block_type) = event_type(block) else {
                    return;
                };
                match block_type {
                    "tool_use" => {
                        let Some(id) = non_empty_field(block, "id") else {
                            return;
                        };
                        let Some(name) = non_empty_field(block, "name") else {
                            return;
                        };
                        let Some(index) = event_index(event) else {
                            return;
                        };
                        self.track_block(index, id, BlockKind::ToolUse);
                        let _ = tx.send(StreamEvent::ToolCallStart {
                            id: id.to_string(),
                            name: name.to_string(),
                        });
                    }
                    "server_tool_use" => {
                        let Some(id) = non_empty_field(block, "id") else {
                            return;
                        };
                        let Some(name) = non_empty_field(block, "name") else {
                            return;
                        };
                        let Some(index) = event_index(event) else {
                            return;
                        };
                        self.track_block(index, id, BlockKind::ServerToolUse);
                        let _ = tx.send(StreamEvent::ServerToolUseStart {
                            id: id.to_string(),
                            name: name.to_string(),
                        });
                    }
                    other => {
                        let Some(name) = server_tool_result_name(other) else {
                            return;
                        };
                        let Some(tool_use_id) = non_empty_field(block, "tool_use_id")
                            .or_else(|| non_empty_field(block, "source_tool_use_id"))
                            .or_else(|| non_empty_field(block, "id"))
                        else {
                            return;
                        };
                        let is_error = block
                            .get("is_error")
                            .and_then(|value| value.as_bool())
                            .unwrap_or(false)
                            || block["error"].is_object()
                            || block["error"].is_string()
                            || block["status"].as_str() == Some("error");
                        let _ = tx.send(StreamEvent::ServerToolResult {
                            tool_use_id: tool_use_id.to_string(),
                            name: name.to_string(),
                            result: block.clone(),
                            is_error,
                        });
                    }
                }
            }
            Some("content_block_delta") => {
                let Some(delta) = event.get("delta") else {
                    return;
                };
                match event_type(delta) {
                    Some("text_delta") => {
                        if let Some(text) = non_empty_field(delta, "text") {
                            let _ = tx.send(StreamEvent::TextDelta {
                                text: text.to_string(),
                            });
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = non_empty_field(delta, "thinking") {
                            let _ = tx.send(StreamEvent::ThinkingDelta {
                                text: text.to_string(),
                            });
                        }
                    }
                    Some("input_json_delta") => {
                        let Some(json_str) = non_empty_field(delta, "partial_json") else {
                            return;
                        };
                        let Some(index) = event_index(event) else {
                            return;
                        };
                        let tracked = self.block_id_map.get(&index).cloned();
                        match tracked {
                            Some(TrackedBlock {
                                id,
                                kind: BlockKind::ToolUse,
                            }) => {
                                let _ = tx.send(StreamEvent::ToolCallDelta {
                                    id,
                                    arguments_delta: json_str.to_string(),
                                });
                            }
                            Some(TrackedBlock {
                                id,
                                kind: BlockKind::ServerToolUse,
                            }) => {
                                let _ = tx.send(StreamEvent::ServerToolUseDelta {
                                    id,
                                    arguments_delta: json_str.to_string(),
                                });
                            }
                            None => {}
                        }
                    }
                    _ => {}
                }
            }
            Some("content_block_stop") => {
                let Some(index) = event_index(event) else {
                    return;
                };
                if let Some(tracked) = self.block_id_map.remove(&index) {
                    match tracked.kind {
                        BlockKind::ToolUse => {
                            let _ = tx.send(StreamEvent::ToolCallEnd { id: tracked.id });
                        }
                        BlockKind::ServerToolUse => {
                            let _ = tx.send(StreamEvent::ServerToolUseEnd { id: tracked.id });
                        }
                    }
                }
            }
            Some("message_delta") => {
                if let Some(usage) = event.get("usage") {
                    let _ = tx.send(StreamEvent::Usage(usage_info(usage, cache_metrics_source)));
                }
            }
            Some("message_stop") => {
                let _ = tx.send(StreamEvent::Done);
            }
            Some("error") => {
                let message = sse_error_message(event);
                let code = event
                    .get("error")
                    .and_then(|error| error.get("type"))
                    .and_then(|value| value.as_str());
                let _ = tx.send(StreamEvent::Error {
                    error: ProviderError::stream(
                        "anthropic",
                        "messages stream",
                        message.as_deref(),
                        code,
                    ),
                });
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn drain_events(rx: &mut mpsc::UnboundedReceiver<StreamEvent>) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    #[test]
    fn parses_anthropic_error_events() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut state = AnthropicEventState::default();
        state.process_sse_event(
            &json!({
                "type": "error",
                "error": {
                    "type": "authentication_error",
                    "message": "Invalid authentication credentials"
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        drop(tx);

        match rx.blocking_recv().expect("error event") {
            StreamEvent::Error { error } => {
                assert_eq!(
                    error.to_string(),
                    "authentication_error: Invalid authentication credentials"
                );
            }
            other => panic!("expected StreamEvent::Error, got {:?}", other),
        }
    }

    #[test]
    fn parses_server_tool_use_events() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut state = AnthropicEventState::default();
        state.process_sse_event(
            &json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "server_tool_use",
                    "id": "srv_1",
                    "name": "web_search"
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        state.process_sse_event(
            &json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": "{\"query\":\"rust async\"}"
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        state.process_sse_event(
            &json!({
                "type": "content_block_stop",
                "index": 0
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        drop(tx);

        match rx.blocking_recv().expect("start") {
            StreamEvent::ServerToolUseStart { id, name } => {
                assert_eq!(id, "srv_1");
                assert_eq!(name, "web_search");
            }
            other => panic!("expected ServerToolUseStart, got {:?}", other),
        }
        match rx.blocking_recv().expect("delta") {
            StreamEvent::ServerToolUseDelta {
                id,
                arguments_delta,
            } => {
                assert_eq!(id, "srv_1");
                assert_eq!(arguments_delta, "{\"query\":\"rust async\"}");
            }
            other => panic!("expected ServerToolUseDelta, got {:?}", other),
        }
        match rx.blocking_recv().expect("stop") {
            StreamEvent::ServerToolUseEnd { id } => assert_eq!(id, "srv_1"),
            other => panic!("expected ServerToolUseEnd, got {:?}", other),
        }
    }

    #[test]
    fn parses_web_search_tool_result_blocks() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut state = AnthropicEventState::default();
        state.process_sse_event(
            &json!({
                "type": "content_block_start",
                "index": 1,
                "content_block": {
                    "type": "web_search_tool_result",
                    "tool_use_id": "srv_1",
                    "content": [
                        { "title": "Tokio", "url": "https://tokio.rs" }
                    ]
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        drop(tx);

        match rx.blocking_recv().expect("result") {
            StreamEvent::ServerToolResult {
                tool_use_id,
                name,
                result,
                is_error,
            } => {
                assert_eq!(tool_use_id, "srv_1");
                assert_eq!(name, "web_search");
                assert!(!is_error);
                assert_eq!(result["content"][0]["url"], "https://tokio.rs");
            }
            other => panic!("expected ServerToolResult, got {:?}", other),
        }
    }

    #[test]
    fn ignores_tool_start_events_without_required_metadata() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut state = AnthropicEventState::default();
        state.process_sse_event(
            &json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "",
                    "name": ""
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        assert!(drain_events(&mut rx).is_empty());
    }

    #[test]
    fn ignores_untracked_json_deltas_instead_of_emitting_synthetic_tool_calls() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut state = AnthropicEventState::default();
        state.process_sse_event(
            &json!({
                "type": "content_block_delta",
                "index": 7,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": "{\"query\":\"rust\"}"
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        assert!(drain_events(&mut rx).is_empty());
    }

    #[test]
    fn ignores_tool_result_blocks_without_any_tool_identifier() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut state = AnthropicEventState::default();
        state.process_sse_event(
            &json!({
                "type": "content_block_start",
                "content_block": {
                    "type": "web_search_tool_result",
                    "content": []
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        assert!(drain_events(&mut rx).is_empty());
    }

    #[test]
    fn message_start_clears_block_tracking_before_new_usage() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut state = AnthropicEventState::default();
        state.process_sse_event(
            &json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": "call_1",
                    "name": "read"
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        state.process_sse_event(
            &json!({
                "type": "message_start",
                "message": {
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 4,
                        "cache_read_input_tokens": 3,
                        "cache_creation_input_tokens": 1
                    }
                }
            }),
            &tx,
            CacheMetricsSource::Official,
        );
        state.process_sse_event(
            &json!({
                "type": "content_block_stop",
                "index": 0
            }),
            &tx,
            CacheMetricsSource::Official,
        );

        let events = drain_events(&mut rx);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], StreamEvent::ToolCallStart { .. }));
        assert!(matches!(events[1], StreamEvent::Usage(_)));
    }

    #[test]
    fn usage_events_preserve_requested_cache_metric_source() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut state = AnthropicEventState::default();
        state.process_sse_event(
            &json!({
                "type": "message_start",
                "message": {
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 4,
                        "cache_read_input_tokens": 3,
                        "cache_creation_input_tokens": 1
                    }
                }
            }),
            &tx,
            CacheMetricsSource::Estimated,
        );

        match rx.blocking_recv().expect("usage") {
            StreamEvent::Usage(usage) => {
                assert_eq!(usage.cache_metrics_source, CacheMetricsSource::Estimated);
                assert_eq!(usage.cache_read_tokens, 3);
                assert_eq!(usage.cache_write_tokens, 1);
            }
            other => panic!("expected Usage, got {:?}", other),
        }
    }
}
