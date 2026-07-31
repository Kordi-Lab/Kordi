//! Shared fixtures for request-metrics tracker regression scenarios.

use super::{
    CacheMetricsSource, PreparedRequestMetrics, RequestCacheMetrics, RequestMetricsIdentity,
    RequestMetricsSnapshot, RequestMetricsState, RequestMetricsTiming, RequestMetricsTracker,
    RequestMutationFlags, ResponseUsage, build_final_request_metrics,
    hydrate_request_metrics_state, normalized_estimated_cache_read_tokens, prepare_request_metrics,
    resolve_cache_usage,
};
use kordi_core::types::{AgentMessage, ContentBlock, UserMessage};
use serde_json::json;

fn parity_test_snapshot(
    provider_messages: Vec<serde_json::Value>,
    tool_definitions: Vec<serde_json::Value>,
) -> RequestMetricsSnapshot {
    RequestMetricsSnapshot {
        system_prompt: "system prompt with stable cacheable instructions".to_string(),
        provider_messages,
        tool_definitions,
        extra_tool_definitions: vec![],
        model: "claude-sonnet-4-6".to_string(),
        max_tokens: Some(512),
        stream: true,
        thinking: None,
    }
}

fn response_usage_with_source(
    prompt_token_total: u64,
    cache_read_tokens: u64,
    output_tokens: u64,
    cache_metrics_source: CacheMetricsSource,
) -> ResponseUsage {
    ResponseUsage {
        input_tokens: prompt_token_total.saturating_sub(cache_read_tokens),
        output_tokens,
        cache_read_tokens,
        cache_write_tokens: 0,
        cache_metrics_source,
    }
}

fn assert_estimate_close_to_official(
    estimated: &RequestCacheMetrics,
    official: &RequestCacheMetrics,
    max_token_delta: u64,
    max_rate_delta_pct: f64,
) {
    assert_eq!(estimated.prompt_token_total, official.prompt_token_total);
    assert_eq!(estimated.output_tokens, official.output_tokens);
    assert_eq!(estimated.cache_write_tokens, 0);
    assert_eq!(official.cache_write_tokens, 0);

    let token_delta = estimated
        .cache_read_tokens
        .abs_diff(official.cache_read_tokens);
    assert!(
        token_delta <= max_token_delta,
        "cache read token delta {token_delta} exceeded tolerance {max_token_delta} (estimated={}, official={})",
        estimated.cache_read_tokens,
        official.cache_read_tokens,
    );

    let estimated_hit_rate = estimated
        .cache_read_hit_rate_pct
        .expect("estimated hit rate");
    let official_hit_rate = official.cache_read_hit_rate_pct.expect("official hit rate");
    let hit_rate_delta = (estimated_hit_rate - official_hit_rate).abs();
    assert!(
        hit_rate_delta <= max_rate_delta_pct,
        "cache hit rate delta {hit_rate_delta:.3} exceeded tolerance {max_rate_delta_pct:.3} (estimated={estimated_hit_rate:.3}, official={official_hit_rate:.3})",
    );

    let estimated_util = estimated
        .cache_effective_utilization_pct
        .expect("estimated utilization");
    let official_util = official
        .cache_effective_utilization_pct
        .expect("official utilization");
    let util_delta = (estimated_util - official_util).abs();
    assert!(
        util_delta <= max_rate_delta_pct,
        "cache utilization delta {util_delta:.3} exceeded tolerance {max_rate_delta_pct:.3} (estimated={estimated_util:.3}, official={official_util:.3})",
    );
}

mod cache_usage;
mod final_metrics;
mod parity;
mod tracker_state;
