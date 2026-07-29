use anyhow::Result;
use chrono::Utc;
use kordi_core::agent_loop::is_context_overflow;
use kordi_core::agent_session::messages_to_provider;
use kordi_core::types::{AgentMessage, StopReason};
use kordi_hooks::Event;
use kordi_monitor::{
    RequestMetricsIdentity, RequestMetricsSnapshot, RequestMetricsTiming, RequestMutationFlags,
    ResponseUsage, append_request_metrics_jsonl, build_final_request_metrics,
    prepare_request_metrics, resolve_cache_usage,
};
use kordi_provider::{
    CollectedResponse, CompletionRequest, ProviderAuthMode, ProviderError, ProviderRetryEvent,
    RequestOptions, RetryCallback, StreamEvent,
};
use kordi_session::context;
use sha2::{Digest, Sha256};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::compaction_exec::execute_session_compaction;

use super::TurnConfig;
use super::TurnEvent;
use super::hooks::{request_mutation_flags, send_extension_event_safe};
use super::panic::catch_contained_panics;
use super::persistence::{
    append_assistant_cancelled_message, append_assistant_error_message, append_assistant_message,
    append_custom_message,
};
use super::tools::{ToolExecutionEnv, append_cancelled_tool_results, execute_tool_calls};

struct StreamCollection {
    events: Vec<StreamEvent>,
    context_overflow_error: Option<String>,
    first_stream_event_at_ms: Option<i64>,
    first_text_delta_at_ms: Option<i64>,
    cancelled: bool,
}

const DEFAULT_LOCAL_MODEL_OVERLOAD_TIMEOUT_SECS: u64 = 120;
const LOCAL_MODEL_LOCK_STALE_AFTER_SECS: u64 = 10 * 60;
const LOCAL_MODEL_LOCK_DIR: &str = "kordi-local-inference-locks";

#[cfg(test)]
static LOCAL_MODEL_OVERLOAD_TIMEOUT_OVERRIDE_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
pub(super) fn set_local_model_overload_timeout_override_for_tests(timeout: Option<Duration>) {
    use std::sync::atomic::Ordering;
    LOCAL_MODEL_OVERLOAD_TIMEOUT_OVERRIDE_MS.store(
        timeout.map(|value| value.as_millis() as u64).unwrap_or(0),
        Ordering::SeqCst,
    );
}

struct LocalInferenceLock {
    path: PathBuf,
}

impl Drop for LocalInferenceLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn local_model_overload_timeout() -> Duration {
    #[cfg(test)]
    {
        use std::sync::atomic::Ordering;
        let override_ms = LOCAL_MODEL_OVERLOAD_TIMEOUT_OVERRIDE_MS.load(Ordering::SeqCst);
        if override_ms > 0 {
            return Duration::from_millis(override_ms);
        }
    }

    let seconds = std::env::var("KORDI_LOCAL_MODEL_OVERLOAD_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value >= 15)
        .unwrap_or(DEFAULT_LOCAL_MODEL_OVERLOAD_TIMEOUT_SECS);
    Duration::from_secs(seconds)
}

fn local_request_label(config: &TurnConfig) -> Option<String> {
    let normalized_provider =
        crate::login::normalize_provider_for_model_selection(&config.model.provider);
    if !crate::login::provider_allows_no_auth(&normalized_provider, Some(&config.base_url)) {
        return None;
    }

    let provider_label = crate::login::provider_display_name(&normalized_provider);
    Some(format!("{provider_label} `{}`", config.model.id))
}

fn local_model_overload_message(config: &TurnConfig, timeout: Duration) -> String {
    let label =
        local_request_label(config).unwrap_or_else(|| format!("local model `{}`", config.model.id));
    format!(
        "Local model overloaded or unresponsive: {label} did not produce response data for {} seconds. Kordi stopped this request to keep the app responsive. Try a smaller model, shorter context, fewer concurrent local requests, or restart the local model server.",
        timeout.as_secs().max(1)
    )
}

fn local_model_busy_message(config: &TurnConfig) -> String {
    let label =
        local_request_label(config).unwrap_or_else(|| format!("local model `{}`", config.model.id));
    format!(
        "Local model is busy: {label} is already running another Kordi request. To avoid overloading this machine, Kordi only allows one local inference per local server at a time. Wait for the other response to finish or stop it, then try again."
    )
}

fn acquire_local_inference_lock(config: &TurnConfig) -> Result<Option<LocalInferenceLock>> {
    if local_request_label(config).is_none() {
        return Ok(None);
    }

    let lock_path = local_inference_lock_path(&config.model.provider, &config.base_url)?;
    match create_local_lock_file(&lock_path, config) {
        Ok(()) => Ok(Some(LocalInferenceLock { path: lock_path })),
        Err(err) if err.kind() == ErrorKind::AlreadyExists => {
            if is_local_lock_stale(&lock_path) {
                let _ = std::fs::remove_file(&lock_path);
                if create_local_lock_file(&lock_path, config).is_ok() {
                    return Ok(Some(LocalInferenceLock { path: lock_path }));
                }
            }
            Err(anyhow::anyhow!(local_model_busy_message(config)))
        }
        Err(err) => Err(anyhow::anyhow!(
            "Unable to reserve the local model server before inference: {err}"
        )),
    }
}

fn local_inference_lock_path(provider: &str, base_url: &str) -> Result<PathBuf> {
    let normalized_provider = crate::login::normalize_provider_for_model_selection(provider);
    let key = format!("{}|{}", normalized_provider, base_url.trim_end_matches('/'));
    let digest = Sha256::digest(key.as_bytes());
    let file_name = format!("{digest:x}.lock");
    let dir = std::env::temp_dir().join(LOCAL_MODEL_LOCK_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(file_name))
}

fn create_local_lock_file(path: &Path, config: &TurnConfig) -> std::io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    writeln!(file, "pid={}", std::process::id())?;
    writeln!(file, "provider={}", config.model.provider)?;
    writeln!(file, "model={}", config.model.id)?;
    writeln!(file, "base_url={}", config.base_url)?;
    Ok(())
}

fn is_local_lock_stale(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age > Duration::from_secs(LOCAL_MODEL_LOCK_STALE_AFTER_SECS))
}

async fn wait_for_optional_timeout(timeout: Option<Duration>) {
    match timeout {
        Some(timeout) => tokio::time::sleep(timeout).await,
        None => std::future::pending::<()>().await,
    }
}

async fn maybe_execute_auto_compaction(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    force: bool,
) -> Result<bool> {
    let conn = config.conn.lock().await;
    let active_path = kordi_session::tree::active_path(&conn, &config.session_id)?;
    let context_tokens = context::build_context_from_path(&active_path)
        .ok()
        .map(|ctx| kordi_session::compaction::estimate_context_tokens(&ctx.messages).tokens)
        .unwrap_or(0);
    let should_run = force
        || kordi_session::compaction::should_compact(
            context_tokens,
            config.model.context_window,
            &config.compaction_settings,
        );
    if !should_run {
        return Ok(false);
    }
    let parent_id = crate::turn_runner::get_leaf_raw(&conn, &config.session_id);
    let db_path = match conn.path().map(std::path::PathBuf::from) {
        Some(path) => path,
        None => return Ok(false),
    };
    drop(conn);

    let _ = event_tx.send(TurnEvent::AutoCompactionStart);

    let (auth_mode, auth_account_id) =
        crate::compaction_exec::compaction_auth_options(config.auth.as_ref());

    let local_lock = match acquire_local_inference_lock(config) {
        Ok(lock) => lock,
        Err(err) => {
            let message = format!("Auto-compaction failed: {err}");
            let _ = event_tx.send(TurnEvent::Status(message.clone()));
            append_assistant_error_message(
                &config.conn,
                &config.session_id,
                &config.model,
                &message,
            )
            .await?;
            return Err(anyhow::anyhow!(message));
        }
    };
    let local_timeout = local_lock.as_ref().map(|_| local_model_overload_timeout());

    let compaction = execute_session_compaction(
        active_path,
        parent_id,
        db_path,
        &config.session_id,
        config.provider.clone(),
        &config.model.id,
        &config.api_key,
        auth_mode,
        auth_account_id,
        &config.base_url,
        &config.headers,
        &config.compaction_settings,
        None,
        CancellationToken::new(),
    );
    let compaction_result = if let Some(timeout) = local_timeout {
        match tokio::time::timeout(timeout, compaction).await {
            Ok(result) => result,
            Err(_) => Err(anyhow::anyhow!(local_model_overload_message(
                config, timeout,
            ))),
        }
    } else {
        compaction.await
    };

    match compaction_result {
        Ok(result) => {
            let _ = event_tx.send(TurnEvent::Status(format!(
                "Auto-compacted session: {} summarized, {} kept, {} tokens before",
                result.summarized_count, result.kept_count, result.tokens_before
            )));
            Ok(true)
        }
        Err(err) if err.to_string() == "Nothing to compact" => Ok(false),
        Err(err) => {
            let message = format!("Auto-compaction failed: {err}");
            let _ = event_tx.send(TurnEvent::Status(message.clone()));
            append_assistant_error_message(
                &config.conn,
                &config.session_id,
                &config.model,
                &message,
            )
            .await?;
            Err(anyhow::anyhow!(message))
        }
    }
}

pub(crate) async fn run_turn(
    config: TurnConfig,
    event_tx: mpsc::UnboundedSender<TurnEvent>,
    user_prompt: String,
) -> (TurnConfig, Result<()>) {
    let result = catch_contained_panics(run_turn_inner(&config, &event_tx, &user_prompt)).await;

    let result = match result {
        Ok(result) => result,
        Err(message) => {
            let message = format!("turn runner panicked: {message}");
            let _ = event_tx.send(TurnEvent::Error(message.clone()));
            let _ = catch_contained_panics(config.extensions.send_event(&Event::AgentEnd)).await;
            Err(anyhow::anyhow!(message))
        }
    };

    (config, result)
}

pub(crate) async fn run_turn_inner(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    user_prompt: &str,
) -> Result<()> {
    let mut turn_index: u32 = 0;
    let mut system_prompt = config.system_prompt.clone();
    let mut overflow_recovery_attempted = false;
    let mut tool_wait_ms_total: u64 = 0;
    let mut resume_latency_ms: Option<u64> = None;
    let mut system_prompt_mutated = false;

    if let Some(result) = send_extension_event_safe(
        &config.extensions,
        Event::BeforeAgentStart {
            prompt: user_prompt.to_string(),
            system_prompt: system_prompt.clone(),
        },
        event_tx,
        "BeforeAgentStart",
    )
    .await
    {
        if let Some(updated_prompt) = result.system_prompt {
            if updated_prompt != system_prompt {
                system_prompt_mutated = true;
            }
            system_prompt = updated_prompt;
        }
        if let Some(message) = result.message {
            append_custom_message(&config.conn, &config.session_id, message).await?;
        }
    }

    loop {
        if maybe_execute_auto_compaction(config, event_tx, false).await? {
            let mut tracker = config.request_metrics_tracker.lock().await;
            tracker.increment_context_epoch();
        }

        let _ = event_tx.send(TurnEvent::TurnStart { turn_index });
        let _ = send_extension_event_safe(
            &config.extensions,
            Event::TurnStart { turn_index },
            event_tx,
            "TurnStart",
        )
        .await;

        if config.cancel.is_cancelled() {
            append_assistant_cancelled_message(&config.conn, &config.session_id, &config.model)
                .await?;
            let _ = event_tx.send(TurnEvent::Done {
                text: String::new(),
            });
            break;
        }

        let request_started_at_ms = Utc::now().timestamp_millis();
        let (request, mut mutation_flags) = build_request(config, event_tx, &system_prompt).await?;
        mutation_flags.system_prompt_mutated = system_prompt_mutated;

        let prepared_metrics = {
            let tracker = config.request_metrics_tracker.lock().await;
            let state = tracker.state().clone();
            prepare_request_metrics(&state, &request_metrics_snapshot(&request))?
        };
        let stream = match collect_stream_events_with_retry(config, event_tx, request).await {
            Ok(stream) => stream,
            Err(error) => {
                if config.cancel.is_cancelled() {
                    append_assistant_cancelled_message(
                        &config.conn,
                        &config.session_id,
                        &config.model,
                    )
                    .await?;
                    let _ = event_tx.send(TurnEvent::Done {
                        text: String::new(),
                    });
                    break;
                }
                let message = error.to_string();
                let _ = append_assistant_error_message(
                    &config.conn,
                    &config.session_id,
                    &config.model,
                    &message,
                )
                .await;
                return Err(error);
            }
        };

        if let Some(message) = stream.context_overflow_error {
            if overflow_recovery_attempted {
                let _ = event_tx.send(TurnEvent::ContextOverflow { message });
                break;
            }
            if maybe_execute_auto_compaction(config, event_tx, true).await? {
                overflow_recovery_attempted = true;
                let mut tracker = config.request_metrics_tracker.lock().await;
                tracker.increment_context_epoch();
                continue;
            }
            let _ = event_tx.send(TurnEvent::ContextOverflow { message });
            break;
        }

        if let Some(error) = first_stream_error(&stream.events) {
            let message = error.to_string();
            let _ = append_assistant_error_message(
                &config.conn,
                &config.session_id,
                &config.model,
                &message,
            )
            .await;
            return Err(anyhow::anyhow!(message));
        }

        let collected = CollectedResponse::from_events(&stream.events);
        let resolved_usage = resolve_cache_usage(
            &prepared_metrics,
            &ResponseUsage {
                input_tokens: collected.input_tokens,
                output_tokens: collected.output_tokens,
                cache_read_tokens: collected.cache_read_tokens,
                cache_write_tokens: collected.cache_write_tokens,
                cache_metrics_source: collected.cache_metrics_source.clone(),
            },
        );
        let has_assistant_content = !collected.text.is_empty()
            || !collected.thinking.is_empty()
            || !collected.tool_calls.is_empty();
        if has_assistant_content {
            let stop_reason = if !collected.tool_calls.is_empty() {
                StopReason::ToolUse
            } else if stream.cancelled || config.cancel.is_cancelled() {
                StopReason::Aborted
            } else {
                StopReason::Stop
            };
            let conn = config.conn.lock().await;
            append_assistant_message(
                &conn,
                &config.session_id,
                &config.model,
                &collected,
                &resolved_usage,
                stop_reason,
            )?;
        } else if stream.cancelled || config.cancel.is_cancelled() {
            append_assistant_cancelled_message(&config.conn, &config.session_id, &config.model)
                .await?;
        }
        overflow_recovery_attempted = false;

        let finished_at_ms = Utc::now().timestamp_millis();
        let total_latency_ms = finished_at_ms.saturating_sub(request_started_at_ms) as u64;
        let metrics = build_final_request_metrics(
            prepared_metrics.clone(),
            &RequestMetricsIdentity {
                session_id: config.session_id.clone(),
                provider: config.provider.name().to_string(),
                model: config.model.id.clone(),
                turn_index,
            },
            &mutation_flags,
            &RequestMetricsTiming {
                request_started_at_ms,
                first_stream_event_at_ms: stream.first_stream_event_at_ms,
                first_text_delta_at_ms: stream.first_text_delta_at_ms,
                finished_at_ms,
                total_latency_ms,
                tool_wait_ms: tool_wait_ms_total,
                resume_latency_ms,
            },
            &resolved_usage,
        );
        if let Some(path) = &config.request_metrics_log_path {
            let _ = append_request_metrics_jsonl(path, &metrics);
        }
        {
            let mut tracker = config.request_metrics_tracker.lock().await;
            tracker.commit(&prepared_metrics);
        }

        if config.cancel.is_cancelled() && !collected.tool_calls.is_empty() {
            append_cancelled_tool_results(
                &collected,
                ToolExecutionEnv {
                    conn: &config.conn,
                    session_id: &config.session_id,
                    tools: config.tool_registry.active_tools(),
                    tool_ctx: &config.tool_ctx,
                    cancel: &config.cancel,
                    extensions: &config.extensions,
                    event_tx,
                },
            )
            .await?;
        }

        let _ = event_tx.send(TurnEvent::TurnEnd);
        let _ = send_extension_event_safe(
            &config.extensions,
            Event::TurnEnd { turn_index },
            event_tx,
            "TurnEnd",
        )
        .await;

        if collected.tool_calls.is_empty() || config.cancel.is_cancelled() {
            let _ = event_tx.send(TurnEvent::Done {
                text: collected.text,
            });
            break;
        }

        let tool_wait_started = std::time::Instant::now();
        execute_tool_calls(
            &collected,
            ToolExecutionEnv {
                conn: &config.conn,
                session_id: &config.session_id,
                tools: config.tool_registry.active_tools(),
                tool_ctx: &config.tool_ctx,
                cancel: &config.cancel,
                extensions: &config.extensions,
                event_tx,
            },
        )
        .await?;
        tool_wait_ms_total = tool_wait_started.elapsed().as_millis() as u64;
        resume_latency_ms = None;

        turn_index += 1;
        system_prompt_mutated = false;
    }

    let _ =
        send_extension_event_safe(&config.extensions, Event::AgentEnd, event_tx, "AgentEnd").await;
    Ok(())
}

async fn build_request(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    system_prompt: &str,
) -> Result<(CompletionRequest, RequestMutationFlags)> {
    let conn = config.conn.lock().await;
    let context = context::build_context(&conn, &config.session_id)?;
    drop(conn);

    let (messages, context_rewritten) =
        apply_context_hook(config, event_tx, context.messages).await?;
    let provider_messages = messages_to_provider(&messages);

    let mut mutation_flags = request_mutation_flags(context_rewritten);

    let mut tool_defs = config.tool_registry.tool_defs().to_vec();
    if config.tool_ctx.reach_out.is_none() {
        tool_defs.retain(|tool| {
            tool.get("function")
                .and_then(|function| function.get("name"))
                .and_then(|name| name.as_str())
                != Some("reach_out")
        });
    }

    let mut request = CompletionRequest {
        system_prompt: system_prompt.to_string(),
        messages: provider_messages,
        tools: tool_defs,
        extra_tool_schemas: vec![],
        model: config.model.id.clone(),
        max_tokens: Some(config.model.max_tokens as u32),
        stream: true,
        thinking: config.thinking.clone(),
    };

    if let Some(result) = send_extension_event_safe(
        &config.extensions,
        Event::BeforeProviderRequest {
            payload: serde_json::to_value(&request).unwrap_or_default(),
        },
        event_tx,
        "BeforeProviderRequest",
    )
    .await
        && let Some(payload) = result.payload
        && let Ok(updated_request) = serde_json::from_value::<CompletionRequest>(payload)
    {
        mutation_flags.request_rewritten = true;
        request = updated_request;
    }

    Ok((request, mutation_flags))
}

async fn apply_context_hook(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    mut messages: Vec<AgentMessage>,
) -> Result<(Vec<AgentMessage>, bool)> {
    let mut rewritten = false;
    if let Some(result) = send_extension_event_safe(
        &config.extensions,
        Event::Context(kordi_hooks::events::ContextEvent::new(messages.clone())),
        event_tx,
        "Context",
    )
    .await
        && let Some(replacement) = result.messages
    {
        rewritten = true;
        messages = replacement
            .into_iter()
            .filter_map(|message| serde_json::from_value::<AgentMessage>(message).ok())
            .collect();
    }

    Ok((messages, rewritten))
}

async fn collect_stream_events_with_retry(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    request: CompletionRequest,
) -> Result<StreamCollection> {
    let max_attempts = if config.retry_enabled {
        config.retry_max_retries.max(1)
    } else {
        1
    };
    let mut retry_attempt = 0_u32;

    loop {
        let stream = collect_stream_events(config, event_tx, request.clone()).await?;
        let Some(error) = first_stream_error(&stream.events) else {
            if retry_attempt > 0 {
                let _ = event_tx.send(TurnEvent::AutoRetryEnd);
            }
            return Ok(stream);
        };

        let message = error.to_string();
        let retry_delay_ms = error.retry_after_ms();
        let retry_delay_is_allowed = retry_delay_ms.is_none_or(|delay_ms| {
            config.retry_max_delay_ms == 0 || delay_ms <= config.retry_max_delay_ms
        });
        let retryable = error.is_retryable()
            && !stream_has_visible_output_before_error(&stream.events)
            && retry_delay_is_allowed;
        if retryable && retry_attempt + 1 < max_attempts && !config.cancel.is_cancelled() {
            retry_attempt += 1;
            let uncapped_delay_ms = config
                .retry_base_delay_ms
                .saturating_mul(2_u64.saturating_pow(retry_attempt - 1));
            let delay_ms = retry_delay_ms.unwrap_or_else(|| {
                if config.retry_max_delay_ms > 0 {
                    uncapped_delay_ms.min(config.retry_max_delay_ms)
                } else {
                    uncapped_delay_ms
                }
            });
            let _ = event_tx.send(TurnEvent::AutoRetryStart {
                attempt: retry_attempt,
                max_attempts,
                delay_ms,
                error_message: message,
            });
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                _ = config.cancel.cancelled() => {
                    let _ = event_tx.send(TurnEvent::AutoRetryEnd);
                    return Ok(stream);
                }
            }
            continue;
        }

        if retry_attempt > 0 {
            let _ = event_tx.send(TurnEvent::AutoRetryEnd);
        }
        let _ = event_tx.send(TurnEvent::Error(message));
        return Ok(stream);
    }
}

async fn collect_stream_events(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    request: CompletionRequest,
) -> Result<StreamCollection> {
    if config.api_key.trim().is_empty()
        && provider_requires_credentials(&config.model.provider, &config.base_url)
    {
        let message = missing_credentials_message(&config.model.provider);
        let _ = event_tx.send(TurnEvent::Error(message.clone()));
        return Err(anyhow::anyhow!(message));
    }

    let local_lock = match acquire_local_inference_lock(config) {
        Ok(lock) => lock,
        Err(err) => {
            let message = err.to_string();
            let _ = event_tx.send(TurnEvent::Error(message.clone()));
            return Err(anyhow::anyhow!(message));
        }
    };
    let local_timeout = local_lock.as_ref().map(|_| local_model_overload_timeout());

    let (stream_tx, mut stream_rx) = mpsc::unbounded_channel();
    let provider = config.provider.clone();
    let stream_cancel = config.cancel.clone();
    let options = build_request_options(config, event_tx.clone());

    let stream_handle = tokio::spawn(async move {
        let result = catch_contained_panics(provider.stream(request, options, stream_tx)).await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                if !stream_cancel.is_cancelled() {
                    Err(error)
                } else {
                    Ok(())
                }
            }
            Err(message) => {
                if !stream_cancel.is_cancelled() {
                    Err(kordi_core::error::KordiError::Provider(format!(
                        "provider stream panicked: {message}"
                    )))
                } else {
                    Ok(())
                }
            }
        }
    });

    let mut events = Vec::new();
    let mut context_overflow_error = None;
    let mut first_stream_event_at_ms = None;
    let mut first_text_delta_at_ms = None;

    let drain_ready_events =
        |stream_rx: &mut mpsc::UnboundedReceiver<StreamEvent>,
         events: &mut Vec<StreamEvent>,
         context_overflow_error: &mut Option<String>,
         first_stream_event_at_ms: &mut Option<i64>,
         first_text_delta_at_ms: &mut Option<i64>| {
            while let Ok(event) = stream_rx.try_recv() {
                forward_stream_event(
                    event_tx,
                    &event,
                    context_overflow_error,
                    first_stream_event_at_ms,
                    first_text_delta_at_ms,
                );
                events.push(event);
            }
        };

    let mut cancelled = false;
    loop {
        tokio::select! {
            _ = wait_for_optional_timeout(local_timeout) => {
                let timeout = local_timeout.expect("local timeout is set for optional wait");
                let message = local_model_overload_message(config, timeout);
                stream_handle.abort();
                let _ = event_tx.send(TurnEvent::Error(message.clone()));
                return Err(anyhow::anyhow!(message));
            }
            _ = config.cancel.cancelled() => {
                cancelled = true;
                drain_ready_events(
                    &mut stream_rx,
                    &mut events,
                    &mut context_overflow_error,
                    &mut first_stream_event_at_ms,
                    &mut first_text_delta_at_ms,
                );
                stream_handle.abort();
                break;
            }
            maybe_event = stream_rx.recv() => {
                let Some(event) = maybe_event else { break; };
                forward_stream_event(
                    event_tx,
                    &event,
                    &mut context_overflow_error,
                    &mut first_stream_event_at_ms,
                    &mut first_text_delta_at_ms,
                );
                events.push(event);

                if config.cancel.is_cancelled() {
                    cancelled = true;
                    drain_ready_events(
                        &mut stream_rx,
                        &mut events,
                        &mut context_overflow_error,
                        &mut first_stream_event_at_ms,
                        &mut first_text_delta_at_ms,
                    );
                    stream_handle.abort();
                    break;
                }
            }
        }
    }

    match stream_handle.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            if !config.cancel.is_cancelled() {
                let message = error.to_string();
                let _ = event_tx.send(TurnEvent::Error(message.clone()));
                return Err(anyhow::anyhow!(message));
            }
        }
        Err(error) => {
            if !config.cancel.is_cancelled() && !error.is_cancelled() {
                let message = format!("stream task failed: {error}");
                let _ = event_tx.send(TurnEvent::Error(message.clone()));
                return Err(anyhow::anyhow!(message));
            }
        }
    }

    Ok(StreamCollection {
        events,
        context_overflow_error,
        first_stream_event_at_ms,
        first_text_delta_at_ms,
        cancelled,
    })
}

fn provider_requires_credentials(provider: &str, base_url: &str) -> bool {
    let normalized = crate::login::normalize_provider_for_model_selection(provider);
    if crate::login::provider_allows_no_auth(&normalized, Some(base_url)) {
        return false;
    }
    matches!(
        normalized.as_str(),
        "anthropic" | "openai" | "google" | "groq" | "xai" | "openrouter" | "github-copilot"
    )
}

fn missing_credentials_message(provider: &str) -> String {
    let normalized = crate::login::normalize_provider_for_model_selection(provider);
    let active_method = crate::login::active_auth_method(&normalized);

    match (normalized.as_str(), active_method) {
        ("anthropic", Some(crate::login::ProviderAuthMethod::OAuth)) =>
            "Claude OAuth credentials are not usable. The saved Claude subscription token is expired or could not be refreshed; sign in to Claude again, or switch this provider to an Anthropic API key.".to_string(),
        ("anthropic", _) =>
            "No Anthropic credentials are available. Add an Anthropic API key or sign in with Claude subscription access.".to_string(),
        ("openai", Some(crate::login::ProviderAuthMethod::OAuth)) =>
            "ChatGPT OAuth credentials are not usable. Sign in to ChatGPT again, or switch this provider to an OpenAI API key.".to_string(),
        ("openai", _) =>
            "No OpenAI credentials are available. Add OPENAI_API_KEY or sign in with ChatGPT account access.".to_string(),
        ("google", _) =>
            "No Google credentials are available. Add GOOGLE_API_KEY or GEMINI_API_KEY.".to_string(),
        (other, _) => format!("No credentials are available for provider '{other}'. Configure credentials before sending a message."),
    }
}

fn first_stream_error(events: &[StreamEvent]) -> Option<ProviderError> {
    events.iter().find_map(|event| match event {
        StreamEvent::Error { error } if !is_context_overflow(&error.to_string()) => {
            Some(error.clone())
        }
        _ => None,
    })
}

fn stream_has_visible_output_before_error(events: &[StreamEvent]) -> bool {
    events
        .iter()
        .take_while(|event| !matches!(event, StreamEvent::Error { .. }))
        .any(|event| {
            matches!(
                event,
                StreamEvent::TextDelta { .. }
                    | StreamEvent::ThinkingDelta { .. }
                    | StreamEvent::ToolCallStart { .. }
                    | StreamEvent::ToolCallDelta { .. }
                    | StreamEvent::ToolCallEnd { .. }
                    | StreamEvent::ServerToolUseStart { .. }
                    | StreamEvent::ServerToolUseDelta { .. }
                    | StreamEvent::ServerToolUseEnd { .. }
                    | StreamEvent::ServerToolResult { .. }
            )
        })
}

fn request_metrics_snapshot(request: &CompletionRequest) -> RequestMetricsSnapshot {
    RequestMetricsSnapshot {
        system_prompt: request.system_prompt.clone(),
        provider_messages: request.messages.clone(),
        tool_definitions: request.tools.clone(),
        extra_tool_definitions: request.extra_tool_schemas.clone(),
        model: request.model.clone(),
        max_tokens: request.max_tokens,
        stream: request.stream,
        thinking: request.thinking.clone(),
    }
}

fn build_request_options(
    config: &TurnConfig,
    event_tx: mpsc::UnboundedSender<TurnEvent>,
) -> RequestOptions {
    let retry_callback: RetryCallback = std::sync::Arc::new(move |event| {
        let turn_event = match event {
            ProviderRetryEvent::Start {
                attempt,
                max_attempts,
                delay_ms,
                error_message,
            } => TurnEvent::AutoRetryStart {
                attempt,
                max_attempts,
                delay_ms,
                error_message,
            },
            ProviderRetryEvent::End { .. } => TurnEvent::AutoRetryEnd,
        };
        let _ = event_tx.send(turn_event);
    });

    let auth_mode = config
        .auth
        .as_ref()
        .map(|auth| match auth.method {
            crate::login::ProviderAuthMethod::OAuth => ProviderAuthMode::OAuth,
            crate::login::ProviderAuthMethod::ApiKey => ProviderAuthMode::ApiKey,
        })
        .unwrap_or(ProviderAuthMode::ApiKey);
    let auth_account_id = config
        .auth
        .as_ref()
        .and_then(|auth| auth.account_id.clone());

    RequestOptions {
        provider: config.model.provider.clone(),
        api_key: config.api_key.clone(),
        auth_mode,
        auth_account_id,
        base_url: config.base_url.clone(),
        headers: config.headers.clone(),
        cancel: config.cancel.clone(),
        retry_callback: Some(retry_callback),
        max_retries: if config.retry_enabled {
            config.retry_max_retries.max(1)
        } else {
            1
        },
        retry_base_delay_ms: config.retry_base_delay_ms,
        max_retry_delay_ms: config.retry_max_delay_ms,
    }
}

fn forward_stream_event(
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    event: &StreamEvent,
    context_overflow_error: &mut Option<String>,
    first_stream_event_at_ms: &mut Option<i64>,
    first_text_delta_at_ms: &mut Option<i64>,
) {
    match event {
        StreamEvent::TextDelta { text } => {
            if first_stream_event_at_ms.is_none() {
                *first_stream_event_at_ms = Some(Utc::now().timestamp_millis());
            }
            if first_text_delta_at_ms.is_none() {
                *first_text_delta_at_ms = Some(Utc::now().timestamp_millis());
            }
            let _ = event_tx.send(TurnEvent::TextDelta(text.clone()));
        }
        StreamEvent::ThinkingDelta { text } => {
            if first_stream_event_at_ms.is_none() {
                *first_stream_event_at_ms = Some(Utc::now().timestamp_millis());
            }
            let _ = event_tx.send(TurnEvent::ThinkingDelta(text.clone()));
        }
        StreamEvent::ToolCallStart { id, name } => {
            if first_stream_event_at_ms.is_none() {
                *first_stream_event_at_ms = Some(Utc::now().timestamp_millis());
            }
            let _ = event_tx.send(TurnEvent::ToolCallStart {
                id: id.clone(),
                name: name.clone(),
            });
        }
        StreamEvent::ToolCallDelta {
            id,
            arguments_delta,
        } => {
            if first_stream_event_at_ms.is_none() {
                *first_stream_event_at_ms = Some(Utc::now().timestamp_millis());
            }
            let _ = event_tx.send(TurnEvent::ToolCallDelta {
                id: id.clone(),
                args: arguments_delta.clone(),
            });
        }
        StreamEvent::Error { error } => {
            let message = error.to_string();
            if is_context_overflow(&message) {
                *context_overflow_error = Some(message);
            }
        }
        _ => {}
    }
}
