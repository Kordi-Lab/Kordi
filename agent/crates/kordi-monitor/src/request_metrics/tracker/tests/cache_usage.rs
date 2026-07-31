//! Cache-source resolution and normalized prefix-estimation scenarios.

use super::*;

#[test]
fn resolve_cache_usage_prefers_provider_values_for_official_metrics() {
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
        reused_prefix_bytes_estimate: Some(40),
        reused_prefix_tokens_estimate: Some(10),
        cacheable_prompt_bytes: 80,
        message_count: 1,
        tool_count: 0,
        cacheable_prompt: "prompt".to_string(),
        context_epoch: 0,
    };
    let usage = ResponseUsage {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 40,
        cache_write_tokens: 5,
        cache_metrics_source: CacheMetricsSource::Official,
    };

    let resolved = resolve_cache_usage(&prepared, &usage);
    assert_eq!(resolved.cache_metrics_source, CacheMetricsSource::Official);
    assert_eq!(resolved.effective_input_tokens, 100);
    assert_eq!(resolved.effective_cache_read_tokens, 40);
    assert_eq!(resolved.effective_cache_write_tokens, 5);
    assert_eq!(resolved.provider_cache_read_tokens, Some(40));
    assert_eq!(resolved.estimated_cache_read_tokens, None);
}

#[test]
fn resolve_cache_usage_uses_normalized_prefix_estimate_for_estimated_metrics() {
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
        context_epoch: 0,
    };
    let usage = ResponseUsage {
        input_tokens: 70,
        output_tokens: 15,
        cache_read_tokens: 20,
        cache_write_tokens: 3,
        cache_metrics_source: CacheMetricsSource::Estimated,
    };

    let resolved = resolve_cache_usage(&prepared, &usage);
    assert_eq!(resolved.cache_metrics_source, CacheMetricsSource::Estimated);
    assert_eq!(resolved.prompt_token_total, 93);
    assert_eq!(resolved.effective_cache_read_tokens, 47);
    assert_eq!(resolved.effective_cache_write_tokens, 0);
    assert_eq!(resolved.effective_input_tokens, 46);
    assert_eq!(resolved.provider_cache_read_tokens, Some(20));
    assert_eq!(resolved.estimated_cache_read_tokens, Some(47));
    assert!(resolved.warm_request);
}

#[test]
fn normalized_estimate_does_not_peg_changed_prompts_to_hundred_percent() {
    let prepared = PreparedRequestMetrics {
        request_id: "req".to_string(),
        stable_prefix_hash: "stable".to_string(),
        stable_prefix_bytes: 10,
        full_request_hash: "full".to_string(),
        provider_messages_hash: "messages".to_string(),
        tool_defs_hash: "tools".to_string(),
        system_prompt_hash: "system".to_string(),
        previous_request_hash: Some("prev".to_string()),
        first_divergence_byte: Some(990),
        first_divergence_token_estimate: Some(248),
        reused_prefix_bytes_estimate: Some(999),
        reused_prefix_tokens_estimate: Some(1_100),
        cacheable_prompt_bytes: 1_000,
        message_count: 1,
        tool_count: 0,
        cacheable_prompt: "prompt".to_string(),
        context_epoch: 0,
    };

    let estimated = normalized_estimated_cache_read_tokens(&prepared, 1_000);
    assert_eq!(estimated, 999);

    let resolved = resolve_cache_usage(
        &prepared,
        &ResponseUsage {
            input_tokens: 1_000,
            output_tokens: 10,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cache_metrics_source: CacheMetricsSource::Estimated,
        },
    );
    assert_eq!(resolved.effective_cache_read_tokens, 999);
    assert_eq!(resolved.effective_input_tokens, 1);
}
