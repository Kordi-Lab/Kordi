use kordi_core::tool_names::normalize_requested_tool_name;
use kordi_core::types::ContentBlock;
use kordi_hooks::events::{ToolExecutionEndEvent, ToolExecutionStartEvent, ToolResultEvent};
use kordi_hooks::{Event, ToolCallEvent};
use kordi_omp_runtime::{ToolCall as OmpToolCall, ToolResult as OmpToolResult};
use kordi_tools::{FileQueue, ToolScheduling, cap_tool_result_content, execute_reserved_tool_call};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::hooks::send_extension_event_safe;
use super::panic::catch_contained_panics;
use super::tool_policy::evaluate_reflection_advisory;
use super::tools::{
    ToolExecutionEnv, scheduler_partial_result, send_tool_execution_update,
    tool_context_with_output_forwarding, tool_metadata_for_call,
};
use super::{TurnConfig, TurnEvent};

/// OMP calls use the same Kordi extension lifecycle and host policy as the
/// Rust loop. OMP persists its structured result transcript after the run, so
/// this callback emits the live result without appending a duplicate entry.
#[allow(
    dead_code,
    reason = "the CLI binary shares this module with the desktop runtime library"
)]
pub(crate) async fn execute_omp_tool_call(
    config: &TurnConfig,
    event_tx: &mpsc::UnboundedSender<TurnEvent>,
    file_queue: &FileQueue,
    call: OmpToolCall,
    cancel: CancellationToken,
) -> OmpToolResult {
    let env = ToolExecutionEnv {
        conn: &config.conn,
        session_id: &config.session_id,
        tools: config.tool_registry.active_tools(),
        tool_ctx: &config.tool_ctx,
        cancel: &cancel,
        extensions: &config.extensions,
        event_tx,
    };
    let mut args = call.input;
    let _ = send_extension_event_safe(
        env.extensions,
        Event::ToolExecutionStart(ToolExecutionStartEvent::new(
            call.call_id.clone(),
            call.name.clone(),
            args.clone(),
        )),
        event_tx,
        "ToolExecutionStart",
    )
    .await;
    let hook = send_extension_event_safe(
        env.extensions,
        Event::ToolCall(ToolCallEvent::new(
            call.call_id.clone(),
            call.name.clone(),
            args.clone(),
        )),
        event_tx,
        "ToolCall",
    )
    .await;
    if let Some(input) = hook.as_ref().and_then(|result| result.input.clone()) {
        args = input;
    }
    let metadata = tool_metadata_for_call(&call.name, &env);
    let started = std::time::Instant::now();
    let result = if hook.as_ref().and_then(|result| result.block) == Some(true) {
        Err(kordi_core::error::KordiError::Tool(
            hook.and_then(|result| result.reason)
                .unwrap_or_else(|| format!("Tool {} blocked by extension", call.name)),
        ))
    } else {
        let normalized = normalize_requested_tool_name(&call.name);
        match env
            .tools
            .iter()
            .find(|tool| tool.name() == normalized.as_ref())
        {
            Some(tool) => {
                let ctx = tool_context_with_output_forwarding(&env, call.call_id.clone());
                if let Err(error) = kordi_tools::ensure_tool_allowed(tool.as_ref(), &ctx) {
                    Err(error)
                } else {
                    let scheduling = tool.scheduling(&args, &ctx);
                    if !matches!(scheduling, ToolScheduling::ReadOnly) {
                        send_tool_execution_update(
                            &env,
                            &call.call_id,
                            &call.name,
                            &args,
                            scheduler_partial_result(
                                &scheduling,
                                "queued",
                                "waiting for mutation scheduler",
                            ),
                        )
                        .await;
                    }
                    let reservation = file_queue.reserve_scheduling(&scheduling).await;
                    send_tool_execution_update(
                        &env,
                        &call.call_id,
                        &call.name,
                        &args,
                        scheduler_partial_result(&scheduling, "running", "running"),
                    )
                    .await;
                    let _ = event_tx.send(TurnEvent::ToolExecuting {
                        id: call.call_id.clone(),
                    });
                    match catch_contained_panics(execute_reserved_tool_call(
                        tool.as_ref(),
                        args.clone(),
                        &ctx,
                        cancel.clone(),
                        reservation,
                    ))
                    .await
                    {
                        Ok(value) => value,
                        Err(message) => Err(kordi_core::error::KordiError::Tool(format!(
                            "Tool {} panicked: {message}",
                            call.name
                        ))),
                    }
                }
            }
            None => Err(kordi_core::error::KordiError::Tool(format!(
                "Unknown tool: {}",
                call.name
            ))),
        }
    };
    let (mut content, mut details, artifact_path, mut is_error) = match result {
        Ok(value) => (
            value.content,
            value.details,
            value.artifact_path.map(|path| path.display().to_string()),
            value.is_error,
        ),
        Err(error) => (
            vec![ContentBlock::Text {
                text: format!("Error: {error}"),
            }],
            None,
            None,
            true,
        ),
    };
    let mut detail_map = details.take().unwrap_or_else(|| serde_json::json!({}));
    if !detail_map.is_object() {
        detail_map = serde_json::json!({ "value": detail_map });
    }
    if let Some(map) = detail_map.as_object_mut() {
        map.insert(
            "durationMs".into(),
            serde_json::json!(started.elapsed().as_millis() as u64),
        );
        if let Some(metadata) = metadata.as_ref() {
            map.insert(
                "toolLayer".into(),
                serde_json::to_value(metadata.layer).unwrap_or_default(),
            );
            map.insert(
                "toolRisk".into(),
                serde_json::to_value(metadata.risk).unwrap_or_default(),
            );
            map.insert(
                "supportsParallel".into(),
                serde_json::json!(metadata.supports_parallel),
            );
        }
    }
    details = Some(detail_map);
    if let Some(detail) = details.as_mut()
        && let Some(advisory) =
            evaluate_reflection_advisory(metadata.as_ref(), &call.name, is_error, detail)
        && let Some(map) = detail.as_object_mut()
    {
        map.insert("reflectionAdvisory".into(), serde_json::json!(advisory));
    }
    if let Some(hook) = send_extension_event_safe(
        env.extensions,
        Event::ToolResult(ToolResultEvent::new(
            call.call_id.clone(),
            call.name.clone(),
            args.clone(),
            content.clone(),
            details.clone(),
            is_error,
        )),
        event_tx,
        "ToolResult",
    )
    .await
    {
        if let Some(updated) = hook.content {
            content = updated
                .into_iter()
                .filter_map(|block| serde_json::from_value::<ContentBlock>(block).ok())
                .collect();
        }
        if let Some(updated) = hook.details {
            details = Some(updated);
        }
        if let Some(updated) = hook.is_error {
            is_error = updated;
        }
    }
    let _ = send_extension_event_safe(
        env.extensions,
        Event::ToolExecutionEnd(ToolExecutionEndEvent::new(
            call.call_id.clone(),
            call.name.clone(),
            args,
            content.clone(),
            details.clone(),
            is_error,
        )),
        event_tx,
        "ToolExecutionEnd",
    )
    .await;
    let (content, details) = cap_tool_result_content(content, details);
    let _ = event_tx.send(TurnEvent::ToolResult {
        id: call.call_id,
        name: call.name,
        content: content.clone(),
        details: details.clone(),
        artifact_path,
        is_error,
    });
    OmpToolResult {
        ok: !is_error,
        content: content
            .iter()
            .filter_map(|block| serde_json::to_value(block).ok())
            .collect(),
        details,
    }
}
