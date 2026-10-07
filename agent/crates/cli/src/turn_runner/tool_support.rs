use super::TurnEvent;
use super::hooks::send_extension_event_safe;
use super::tools::ToolExecutionEnv;
use kordi_core::tool_names::normalize_requested_tool_name;
use kordi_hooks::Event;
use kordi_hooks::events::ToolExecutionUpdateEvent;
use kordi_tools::{ToolContext, ToolMetadata, ToolScheduling};

pub(super) fn tool_context_with_output_forwarding(
    env: &ToolExecutionEnv<'_>,
    tool_call_id: String,
) -> ToolContext {
    let event_tx = env.event_tx.clone();
    let output_call_id = tool_call_id.clone();
    ToolContext {
        cwd: env.tool_ctx.cwd.clone(),
        artifacts_dir: env.tool_ctx.artifacts_dir.clone(),
        model: None,
        invocation_id: Some(tool_call_id),
        execution_policy: env.tool_ctx.execution_policy,
        on_output: Some(Box::new(move |chunk| {
            let _ = event_tx.send(TurnEvent::ToolOutputDelta {
                id: output_call_id.clone(),
                chunk: chunk.to_string(),
            });
        })),
        web_search: env.tool_ctx.web_search.clone(),
        reach_out: env.tool_ctx.reach_out.clone(),
        reflection: env.tool_ctx.reflection.clone(),
        session_observation: env.tool_ctx.session_observation.clone(),
        task_operator: env.tool_ctx.task_operator.clone(),
        schedule_task: env.tool_ctx.schedule_task.clone(),
        execution_mode: env.tool_ctx.execution_mode,
        request_approval: env.tool_ctx.request_approval.clone(),
        connector_tools: env.tool_ctx.connector_tools.clone(),
    }
}

pub(super) fn scheduler_partial_result(
    scheduling: &ToolScheduling,
    state: &str,
    message: &str,
) -> serde_json::Value {
    let mut details = serde_json::Map::new();
    details.insert("schedulerState".to_string(), serde_json::Value::from(state));
    details.insert(
        "schedulerMessage".to_string(),
        serde_json::Value::from(message.to_string()),
    );
    match scheduling {
        ToolScheduling::ReadOnly => {
            details.insert(
                "scheduling".to_string(),
                serde_json::Value::from("read_only"),
            );
        }
        ToolScheduling::MutatingUnknown => {
            details.insert(
                "scheduling".to_string(),
                serde_json::Value::from("mutating_unknown"),
            );
        }
        ToolScheduling::MutatingPaths(paths) => {
            details.insert(
                "scheduling".to_string(),
                serde_json::Value::from("mutating_paths"),
            );
            details.insert(
                "pathCount".to_string(),
                serde_json::Value::from(paths.len() as u64),
            );
            details.insert(
                "paths".to_string(),
                serde_json::Value::from(
                    paths
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>(),
                ),
            );
        }
    }
    serde_json::json!({ "details": details })
}

pub(super) fn tool_metadata_for_call(
    tool_name: &str,
    env: &ToolExecutionEnv<'_>,
) -> Option<ToolMetadata> {
    let normalized_name = normalize_requested_tool_name(tool_name);
    env.tools
        .iter()
        .find(|tool| tool.name() == normalized_name.as_ref())
        .map(|tool| tool.metadata())
}

pub(super) async fn send_tool_execution_update(
    env: &ToolExecutionEnv<'_>,
    tool_call_id: &str,
    tool_name: &str,
    input: &serde_json::Value,
    partial_result: serde_json::Value,
) {
    let _ = send_extension_event_safe(
        env.extensions,
        Event::ToolExecutionUpdate(ToolExecutionUpdateEvent::new(
            tool_call_id.to_string(),
            tool_name.to_string(),
            input.clone(),
            partial_result,
        )),
        env.event_tx,
        "ToolExecutionUpdate",
    )
    .await;
}
