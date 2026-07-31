//! Request-metrics state transitions, cache estimates, and finalized observations.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::cache_metrics::{
    CacheMetricsSource, cache_effective_utilization_pct, cache_read_hit_rate_pct,
};

use super::canonical::{canonical_cacheable_prompt, canonical_json_from_serializable};
use super::divergence::{diff_prefix, estimate_tokens_from_bytes_for_model};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestMetricsState {
    pub last_request_hash: Option<String>,
    pub last_cacheable_prompt: Option<String>,
    pub context_epoch: u64,
}

#[derive(Clone, Debug, Default)]
pub struct RequestMetricsTracker {
    state: RequestMetricsState,
}

impl RequestMetricsTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_state(state: RequestMetricsState) -> Self {
        Self { state }
    }

    pub fn state(&self) -> &RequestMetricsState {
        &self.state
    }

    pub fn into_state(self) -> RequestMetricsState {
        self.state
    }

    pub fn increment_context_epoch(&mut self) {
        self.state.context_epoch = self.state.context_epoch.saturating_add(1);
    }

    pub fn reset_history(&mut self) {
        self.state.last_request_hash = None;
        self.state.last_cacheable_prompt = None;
        self.increment_context_epoch();
    }

    pub fn hydrate(&mut self, snapshot: &RequestMetricsSnapshot) -> Result<()> {
        hydrate_request_metrics_state(&mut self.state, snapshot)
    }

    pub fn prepare(&self, snapshot: &RequestMetricsSnapshot) -> Result<PreparedRequestMetrics> {
        prepare_request_metrics(&self.state, snapshot)
    }

    pub fn commit(&mut self, prepared: &PreparedRequestMetrics) {
        commit_request_metrics_state(&mut self.state, prepared);
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct RequestMetricsSnapshot {
    pub system_prompt: String,
    pub provider_messages: Vec<Value>,
    pub tool_definitions: Vec<Value>,
    pub extra_tool_definitions: Vec<Value>,
    pub model: String,
    pub max_tokens: Option<u32>,
    pub stream: bool,
    pub thinking: Option<String>,
}

impl RequestMetricsSnapshot {
    pub fn combined_tool_definitions(&self) -> Vec<Value> {
        self.tool_definitions
            .iter()
            .cloned()
            .chain(self.extra_tool_definitions.iter().cloned())
            .collect()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestMutationFlags {
    pub system_prompt_mutated: bool,
    pub context_rewritten: bool,
    pub request_rewritten: bool,
    pub post_compaction: bool,
}

/// Prepared request state captured before the provider call starts.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreparedRequestMetrics {
    pub request_id: String,
    pub stable_prefix_hash: String,
    pub stable_prefix_bytes: usize,
    pub full_request_hash: String,
    pub provider_messages_hash: String,
    pub tool_defs_hash: String,
    pub system_prompt_hash: String,
    pub previous_request_hash: Option<String>,
    pub first_divergence_byte: Option<usize>,
    pub first_divergence_token_estimate: Option<u64>,
    pub reused_prefix_bytes_estimate: Option<usize>,
    pub reused_prefix_tokens_estimate: Option<u64>,
    pub cacheable_prompt_bytes: usize,
    pub message_count: usize,
    pub tool_count: usize,
    pub cacheable_prompt: String,
    pub context_epoch: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResponseUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cache_metrics_source: CacheMetricsSource,
}

/// Resolved usage numbers after combining provider-reported and estimated cache signals.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedCacheUsage {
    pub cache_metrics_source: CacheMetricsSource,
    pub effective_input_tokens: u64,
    pub effective_output_tokens: u64,
    pub effective_cache_read_tokens: u64,
    pub effective_cache_write_tokens: u64,
    pub prompt_token_total: u64,
    pub provider_cache_read_tokens: Option<u64>,
    pub provider_cache_write_tokens: Option<u64>,
    pub estimated_cache_read_tokens: Option<u64>,
    pub estimated_cache_write_tokens: Option<u64>,
    pub warm_request: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestMetricsIdentity {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub turn_index: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct RequestMetricsTiming {
    pub request_started_at_ms: i64,
    pub first_stream_event_at_ms: Option<i64>,
    pub first_text_delta_at_ms: Option<i64>,
    pub finished_at_ms: i64,
    pub total_latency_ms: u64,
    pub tool_wait_ms: u64,
    pub resume_latency_ms: Option<u64>,
}

/// Final Phase-1 request-level cache/latency record.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RequestCacheMetrics {
    pub request_id: String,
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub turn_index: u32,
    pub context_epoch: u64,

    pub stable_prefix_hash: String,
    pub stable_prefix_bytes: usize,
    pub full_request_hash: String,
    pub provider_messages_hash: String,
    pub tool_defs_hash: String,
    pub system_prompt_hash: String,

    pub previous_request_hash: Option<String>,
    pub first_divergence_byte: Option<usize>,
    pub first_divergence_token_estimate: Option<u64>,
    pub reused_prefix_bytes_estimate: Option<usize>,
    pub reused_prefix_tokens_estimate: Option<u64>,

    pub prompt_bytes: usize,
    pub message_count: usize,
    pub tool_count: usize,

    pub cache_metrics_source: CacheMetricsSource,
    pub provider_cache_read_tokens: Option<u64>,
    pub provider_cache_write_tokens: Option<u64>,
    pub estimated_cache_read_tokens: Option<u64>,
    pub estimated_cache_write_tokens: Option<u64>,

    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub prompt_token_total: u64,
    pub cache_read_hit_rate_pct: Option<f64>,
    pub cache_effective_utilization_pct: Option<f64>,
    pub warm_request: bool,

    pub request_started_at_ms: i64,
    pub first_stream_event_at_ms: Option<i64>,
    pub first_text_delta_at_ms: Option<i64>,
    pub finished_at_ms: i64,

    pub ttft_ms: Option<u64>,
    pub total_latency_ms: u64,
    pub tool_wait_ms: u64,
    pub resume_latency_ms: Option<u64>,

    pub post_compaction: bool,
    pub system_prompt_mutated: bool,
    pub context_rewritten: bool,
    pub request_rewritten: bool,
}

pub fn hydrate_request_metrics_state(
    state: &mut RequestMetricsState,
    snapshot: &RequestMetricsSnapshot,
) -> Result<()> {
    let canonical_request = canonical_json_from_serializable(snapshot)?;
    let full_request_hash = sha256_hex(canonical_request.as_bytes());
    let cacheable_prompt = canonical_cacheable_prompt(snapshot)?;

    state.last_request_hash = Some(full_request_hash);
    state.last_cacheable_prompt = Some(cacheable_prompt);
    Ok(())
}

pub fn prepare_request_metrics(
    state: &RequestMetricsState,
    snapshot: &RequestMetricsSnapshot,
) -> Result<PreparedRequestMetrics> {
    let canonical_request = canonical_json_from_serializable(snapshot)?;
    let combined_tool_defs = snapshot.combined_tool_definitions();
    let cacheable_prompt = canonical_cacheable_prompt(snapshot)?;
    let stable_prefix_json = canonical_json_from_serializable(&serde_json::json!({
        "system_prompt": snapshot.system_prompt,
        "tools": combined_tool_defs,
    }))?;
    let provider_messages_json = canonical_json_from_serializable(&snapshot.provider_messages)?;
    let tool_defs_json = canonical_json_from_serializable(&combined_tool_defs)?;
    let system_prompt_json = canonical_json_from_serializable(&snapshot.system_prompt)?;

    let full_request_hash = sha256_hex(canonical_request.as_bytes());
    let stable_prefix_hash = sha256_hex(stable_prefix_json.as_bytes());
    let provider_messages_hash = sha256_hex(provider_messages_json.as_bytes());
    let tool_defs_hash = sha256_hex(tool_defs_json.as_bytes());
    let system_prompt_hash = sha256_hex(system_prompt_json.as_bytes());

    let previous_request_hash = state.last_request_hash.clone();
    let diff = state
        .last_cacheable_prompt
        .as_ref()
        .map(|previous| diff_prefix(previous, &cacheable_prompt));

    Ok(PreparedRequestMetrics {
        request_id: Uuid::new_v4().to_string(),
        stable_prefix_hash,
        stable_prefix_bytes: stable_prefix_json.len(),
        full_request_hash,
        provider_messages_hash,
        tool_defs_hash,
        system_prompt_hash,
        previous_request_hash,
        first_divergence_byte: diff.as_ref().and_then(|d| d.first_divergence_byte),
        first_divergence_token_estimate: diff.as_ref().and_then(|d| {
            d.first_divergence_byte
                .map(|bytes| estimate_tokens_from_bytes_for_model(bytes, &snapshot.model))
        }),
        reused_prefix_bytes_estimate: diff.as_ref().map(|d| d.common_prefix_bytes),
        reused_prefix_tokens_estimate: diff
            .as_ref()
            .map(|d| estimate_tokens_from_bytes_for_model(d.common_prefix_bytes, &snapshot.model)),
        cacheable_prompt_bytes: cacheable_prompt.len(),
        message_count: snapshot.provider_messages.len(),
        tool_count: snapshot.tool_definitions.len() + snapshot.extra_tool_definitions.len(),
        cacheable_prompt,
        context_epoch: state.context_epoch,
    })
}

pub fn commit_request_metrics_state(
    state: &mut RequestMetricsState,
    prepared: &PreparedRequestMetrics,
) {
    state.last_request_hash = Some(prepared.full_request_hash.clone());
    state.last_cacheable_prompt = Some(prepared.cacheable_prompt.clone());
}

pub fn resolve_cache_usage(
    prepared: &PreparedRequestMetrics,
    usage: &ResponseUsage,
) -> ResolvedCacheUsage {
    let provider_prompt_token_total =
        usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;

    match usage.cache_metrics_source {
        CacheMetricsSource::Official => ResolvedCacheUsage {
            cache_metrics_source: CacheMetricsSource::Official,
            effective_input_tokens: usage.input_tokens,
            effective_output_tokens: usage.output_tokens,
            effective_cache_read_tokens: usage.cache_read_tokens,
            effective_cache_write_tokens: usage.cache_write_tokens,
            prompt_token_total: provider_prompt_token_total,
            provider_cache_read_tokens: Some(usage.cache_read_tokens),
            provider_cache_write_tokens: Some(usage.cache_write_tokens),
            estimated_cache_read_tokens: None,
            estimated_cache_write_tokens: None,
            warm_request: usage.cache_read_tokens > 0,
        },
        CacheMetricsSource::Estimated => {
            let estimated_cache_read =
                normalized_estimated_cache_read_tokens(prepared, provider_prompt_token_total);
            let estimated_cache_write = 0;
            let effective_input_tokens = provider_prompt_token_total
                .saturating_sub(estimated_cache_read + estimated_cache_write);

            ResolvedCacheUsage {
                cache_metrics_source: CacheMetricsSource::Estimated,
                effective_input_tokens,
                effective_output_tokens: usage.output_tokens,
                effective_cache_read_tokens: estimated_cache_read,
                effective_cache_write_tokens: estimated_cache_write,
                prompt_token_total: provider_prompt_token_total,
                provider_cache_read_tokens: Some(usage.cache_read_tokens),
                provider_cache_write_tokens: Some(usage.cache_write_tokens),
                estimated_cache_read_tokens: Some(estimated_cache_read),
                estimated_cache_write_tokens: Some(estimated_cache_write),
                warm_request: estimated_cache_read > 0,
            }
        }
        CacheMetricsSource::Unknown => ResolvedCacheUsage {
            cache_metrics_source: CacheMetricsSource::Unknown,
            effective_input_tokens: usage.input_tokens,
            effective_output_tokens: usage.output_tokens,
            effective_cache_read_tokens: usage.cache_read_tokens,
            effective_cache_write_tokens: usage.cache_write_tokens,
            prompt_token_total: provider_prompt_token_total,
            provider_cache_read_tokens: Some(usage.cache_read_tokens),
            provider_cache_write_tokens: Some(usage.cache_write_tokens),
            estimated_cache_read_tokens: None,
            estimated_cache_write_tokens: None,
            warm_request: usage.cache_read_tokens > 0,
        },
    }
}

fn normalized_estimated_cache_read_tokens(
    prepared: &PreparedRequestMetrics,
    prompt_token_total: u64,
) -> u64 {
    if prompt_token_total == 0 {
        return 0;
    }

    let reused_prefix_bytes = prepared.reused_prefix_bytes_estimate.unwrap_or(0);
    let cacheable_prompt_bytes = prepared.cacheable_prompt_bytes;
    if reused_prefix_bytes == 0 || cacheable_prompt_bytes == 0 {
        return 0;
    }

    let reuse_ratio = reused_prefix_bytes as f64 / cacheable_prompt_bytes as f64;
    let mut estimated = (prompt_token_total as f64 * reuse_ratio).round() as u64;
    estimated = estimated.min(prompt_token_total);

    if reused_prefix_bytes < cacheable_prompt_bytes && estimated >= prompt_token_total {
        prompt_token_total.saturating_sub(1)
    } else {
        estimated
    }
}

pub fn build_final_request_metrics(
    prepared: PreparedRequestMetrics,
    identity: &RequestMetricsIdentity,
    mutation_flags: &RequestMutationFlags,
    timing: &RequestMetricsTiming,
    usage: &ResolvedCacheUsage,
) -> RequestCacheMetrics {
    let cache_read_hit_rate_pct = cache_read_hit_rate_pct(
        usage.effective_input_tokens,
        usage.effective_cache_read_tokens,
    );
    let cache_effective_utilization_pct = cache_effective_utilization_pct(
        usage.effective_input_tokens,
        usage.effective_cache_read_tokens,
        usage.effective_cache_write_tokens,
    );

    RequestCacheMetrics {
        request_id: prepared.request_id,
        session_id: identity.session_id.clone(),
        provider: identity.provider.clone(),
        model: identity.model.clone(),
        turn_index: identity.turn_index,
        context_epoch: prepared.context_epoch,

        stable_prefix_hash: prepared.stable_prefix_hash,
        stable_prefix_bytes: prepared.stable_prefix_bytes,
        full_request_hash: prepared.full_request_hash,
        provider_messages_hash: prepared.provider_messages_hash,
        tool_defs_hash: prepared.tool_defs_hash,
        system_prompt_hash: prepared.system_prompt_hash,

        previous_request_hash: prepared.previous_request_hash,
        first_divergence_byte: prepared.first_divergence_byte,
        first_divergence_token_estimate: prepared.first_divergence_token_estimate,
        reused_prefix_bytes_estimate: prepared.reused_prefix_bytes_estimate,
        reused_prefix_tokens_estimate: prepared.reused_prefix_tokens_estimate,

        prompt_bytes: prepared.cacheable_prompt_bytes,
        message_count: prepared.message_count,
        tool_count: prepared.tool_count,

        cache_metrics_source: usage.cache_metrics_source.clone(),
        provider_cache_read_tokens: usage.provider_cache_read_tokens,
        provider_cache_write_tokens: usage.provider_cache_write_tokens,
        estimated_cache_read_tokens: usage.estimated_cache_read_tokens,
        estimated_cache_write_tokens: usage.estimated_cache_write_tokens,

        cache_read_tokens: usage.effective_cache_read_tokens,
        cache_write_tokens: usage.effective_cache_write_tokens,
        input_tokens: usage.effective_input_tokens,
        output_tokens: usage.effective_output_tokens,
        prompt_token_total: usage.prompt_token_total,
        cache_read_hit_rate_pct,
        cache_effective_utilization_pct,
        warm_request: usage.warm_request,

        request_started_at_ms: timing.request_started_at_ms,
        first_stream_event_at_ms: timing.first_stream_event_at_ms,
        first_text_delta_at_ms: timing.first_text_delta_at_ms,
        finished_at_ms: timing.finished_at_ms,

        ttft_ms: timing
            .first_text_delta_at_ms
            .map(|first| first.saturating_sub(timing.request_started_at_ms) as u64),
        total_latency_ms: timing.total_latency_ms,
        tool_wait_ms: timing.tool_wait_ms,
        resume_latency_ms: timing.resume_latency_ms,

        post_compaction: mutation_flags.post_compaction,
        system_prompt_mutated: mutation_flags.system_prompt_mutated,
        context_rewritten: mutation_flags.context_rewritten,
        request_rewritten: mutation_flags.request_rewritten,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests;
