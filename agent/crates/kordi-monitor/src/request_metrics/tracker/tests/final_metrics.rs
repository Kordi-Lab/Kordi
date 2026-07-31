//! Final metric construction and state-hydration scenarios.

use super::*;

#[test]
fn build_final_request_metrics_computes_latency_and_rates() {
    let prepared = PreparedRequestMetrics {
        request_id: "req".to_string(),
        stable_prefix_hash: "stable".to_string(),
        stable_prefix_bytes: 10,
        full_request_hash: "full".to_string(),
        provider_messages_hash: "messages".to_string(),
        tool_defs_hash: "tools".to_string(),
        system_prompt_hash: "system".to_string(),
        previous_request_hash: Some("prev".to_string()),
        first_divergence_byte: Some(10),
        first_divergence_token_estimate: Some(3),
        reused_prefix_bytes_estimate: Some(48),
        reused_prefix_tokens_estimate: Some(12),
        cacheable_prompt_bytes: 96,
        message_count: 1,
        tool_count: 0,
        cacheable_prompt: "prompt".to_string(),
        context_epoch: 2,
    };
    let resolved = resolve_cache_usage(
        &prepared,
        &ResponseUsage {
            input_tokens: 70,
            output_tokens: 15,
            cache_read_tokens: 20,
            cache_write_tokens: 3,
            cache_metrics_source: CacheMetricsSource::Estimated,
        },
    );
    let metrics = build_final_request_metrics(
        prepared,
        &RequestMetricsIdentity {
            session_id: "session-1".to_string(),
            provider: "anthropic".to_string(),
            model: "claude-sonnet".to_string(),
            turn_index: 4,
        },
        &RequestMutationFlags {
            request_rewritten: true,
            ..Default::default()
        },
        &RequestMetricsTiming {
            request_started_at_ms: 100,
            first_stream_event_at_ms: Some(110),
            first_text_delta_at_ms: Some(130),
            finished_at_ms: 200,
            total_latency_ms: 100,
            tool_wait_ms: 7,
            resume_latency_ms: Some(5),
        },
        &resolved,
    );

    assert_eq!(metrics.context_epoch, 2);
    assert_eq!(metrics.turn_index, 4);
    assert_eq!(metrics.ttft_ms, Some(30));
    assert_eq!(metrics.total_latency_ms, 100);
    assert_eq!(metrics.tool_wait_ms, 7);
    assert_eq!(metrics.resume_latency_ms, Some(5));
    assert!(metrics.request_rewritten);
    assert!(metrics.cache_read_hit_rate_pct.is_some());
    assert!(metrics.cache_effective_utilization_pct.is_some());
}

#[test]
fn hydrate_state_seeds_previous_request_hash() {
    let session_messages = vec![AgentMessage::User(UserMessage {
        content: vec![ContentBlock::Text {
            text: "hello".to_string(),
        }],
        timestamp: 0,
    })];
    let provider_messages = kordi_core::agent_session::messages_to_provider(&session_messages);
    let snapshot = RequestMetricsSnapshot {
        system_prompt: "system".to_string(),
        provider_messages,
        tool_definitions: vec![],
        extra_tool_definitions: vec![],
        model: "dummy-model".to_string(),
        max_tokens: Some(42),
        stream: true,
        thinking: None,
    };

    let mut state = RequestMetricsState::default();
    hydrate_request_metrics_state(&mut state, &snapshot).expect("hydrate state");
    let prepared = prepare_request_metrics(&state, &snapshot).expect("prepare metrics");

    assert!(prepared.previous_request_hash.is_some());
    assert_eq!(prepared.first_divergence_byte, None);
    assert_eq!(
        prepared.reused_prefix_bytes_estimate,
        Some(prepared.cacheable_prompt_bytes)
    );
    assert!(prepared.reused_prefix_bytes_estimate.unwrap_or_default() > 0);
}
