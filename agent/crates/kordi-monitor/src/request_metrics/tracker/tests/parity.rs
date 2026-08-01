//! Estimated-versus-official cache metric parity scenarios.

use super::*;

#[test]
fn estimated_metrics_stay_close_to_official_for_repeated_identical_request() {
    let session_messages = vec![AgentMessage::User(UserMessage {
        content: vec![ContentBlock::Text {
            text: "summarize the cache warmup plan".to_string(),
        }],
        timestamp: 0,
    })];
    let snapshot = parity_test_snapshot(
        kordi_core::agent_session::messages_to_provider(&session_messages),
        vec![],
    );
    let mut state = RequestMetricsState::default();
    hydrate_request_metrics_state(&mut state, &snapshot).expect("seed state");

    let prepared = prepare_request_metrics(&state, &snapshot).expect("prepare repeated request");
    let prompt_token_total = 240;
    let estimated_read = normalized_estimated_cache_read_tokens(&prepared, prompt_token_total);
    assert!(estimated_read > 0);

    let official_read = estimated_read.saturating_sub(4);
    let official_usage = resolve_cache_usage(
        &prepared,
        &response_usage_with_source(
            prompt_token_total,
            official_read,
            24,
            CacheMetricsSource::Official,
        ),
    );
    let estimated_usage = resolve_cache_usage(
        &prepared,
        &response_usage_with_source(
            prompt_token_total,
            official_read,
            24,
            CacheMetricsSource::Estimated,
        ),
    );

    let identity = RequestMetricsIdentity {
        session_id: "session".to_string(),
        provider: "anthropic".to_string(),
        model: "claude-sonnet-4-6".to_string(),
        turn_index: 2,
    };
    let timing = RequestMetricsTiming {
        request_started_at_ms: 0,
        first_stream_event_at_ms: Some(10),
        first_text_delta_at_ms: Some(20),
        finished_at_ms: 40,
        total_latency_ms: 40,
        tool_wait_ms: 0,
        resume_latency_ms: None,
    };
    let official_metrics = build_final_request_metrics(
        prepared.clone(),
        &identity,
        &RequestMutationFlags::default(),
        &timing,
        &official_usage,
    );
    let estimated_metrics = build_final_request_metrics(
        prepared,
        &identity,
        &RequestMutationFlags::default(),
        &timing,
        &estimated_usage,
    );

    assert_eq!(
        official_metrics.cache_metrics_source,
        CacheMetricsSource::Official
    );
    assert_eq!(
        estimated_metrics.cache_metrics_source,
        CacheMetricsSource::Estimated
    );
    assert_eq!(official_metrics.estimated_cache_read_tokens, None);
    assert_eq!(
        estimated_metrics.provider_cache_read_tokens,
        Some(official_read)
    );
    assert_eq!(
        estimated_metrics.estimated_cache_read_tokens,
        Some(estimated_read)
    );
    assert_estimate_close_to_official(&estimated_metrics, &official_metrics, 4, 2.5);
}

#[test]
fn estimated_metrics_stay_close_to_official_with_tools_and_history() {
    let snapshot = parity_test_snapshot(
        vec![
            json!({"role": "user", "content": "fetch repo data"}),
            json!({
                "role": "assistant",
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "web_fetch",
                        "arguments": "{\"url\":\"https://example.com\"}"
                    }
                }]
            }),
            json!({
                "role": "tool",
                "tool_call_id": "call_1",
                "content": "{\"ok\":true,\"stars\":42}"
            }),
            json!({"role": "user", "content": "now explain the result concisely"}),
        ],
        vec![json!({
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Fetch a URL",
                "parameters": {
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"]
                }
            }
        })],
    );
    let mut state = RequestMetricsState::default();
    hydrate_request_metrics_state(&mut state, &snapshot).expect("seed state");

    let prepared = prepare_request_metrics(&state, &snapshot).expect("prepare repeated request");
    let prompt_token_total = 320;
    let estimated_read = normalized_estimated_cache_read_tokens(&prepared, prompt_token_total);
    assert!(estimated_read > 0);

    let official_read = estimated_read.saturating_sub(8);
    let official_usage = resolve_cache_usage(
        &prepared,
        &response_usage_with_source(
            prompt_token_total,
            official_read,
            31,
            CacheMetricsSource::Official,
        ),
    );
    let estimated_usage = resolve_cache_usage(
        &prepared,
        &response_usage_with_source(
            prompt_token_total,
            official_read,
            31,
            CacheMetricsSource::Estimated,
        ),
    );

    let identity = RequestMetricsIdentity {
        session_id: "session".to_string(),
        provider: "anthropic".to_string(),
        model: "claude-sonnet-4-6".to_string(),
        turn_index: 3,
    };
    let timing = RequestMetricsTiming {
        request_started_at_ms: 0,
        first_stream_event_at_ms: Some(12),
        first_text_delta_at_ms: Some(22),
        finished_at_ms: 48,
        total_latency_ms: 48,
        tool_wait_ms: 0,
        resume_latency_ms: None,
    };
    let official_metrics = build_final_request_metrics(
        prepared.clone(),
        &identity,
        &RequestMutationFlags::default(),
        &timing,
        &official_usage,
    );
    let estimated_metrics = build_final_request_metrics(
        prepared,
        &identity,
        &RequestMutationFlags::default(),
        &timing,
        &estimated_usage,
    );

    assert_estimate_close_to_official(&estimated_metrics, &official_metrics, 8, 2.5);
}
