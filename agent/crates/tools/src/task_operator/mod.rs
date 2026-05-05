pub mod cost;
pub mod models;
pub mod validation;

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::support::text_result;
use crate::{Tool, ToolContext, ToolMetadata, ToolResult, ToolRiskLevel};
use cost::estimate_cost_microunits;
use models::{
    TaskEstimate, TaskEstimateRequest, TaskManifestRequest, TaskOperatorRequest,
    TaskOperatorRuntimeRequest, TaskOperatorRuntimeResponse,
};
use validation::validate_manifest_tasks;

pub struct TaskOperatorTool;

#[async_trait]
impl Tool for TaskOperatorTool {
    fn name(&self) -> &str {
        "task_operator"
    }

    fn description(&self) -> &str {
        "Create task manifests and cost estimates for multi-step work."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["manifest", "estimate", "spawn", "message", "wait", "list", "close"],
                    "description": "Task operator action."
                },
                "tasks": {
                    "type": "array",
                    "description": "Tasks for action=manifest.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "taskId": { "type": "string", "description": "Lowercase letters, digits, and underscores." },
                            "title": { "type": "string" },
                            "summary": { "type": "string" },
                            "dependencies": { "type": "array", "items": { "type": "string" } },
                            "writeScope": { "type": "array", "items": { "type": "string" } },
                            "risk": { "type": "string", "enum": ["read_only", "low", "medium", "high"] },
                            "estimatedInputTokens": { "type": "number" },
                            "estimatedOutputTokens": { "type": "number" }
                        },
                        "required": [
                            "taskId",
                            "title",
                            "summary",
                            "dependencies",
                            "writeScope",
                            "risk",
                            "estimatedInputTokens",
                            "estimatedOutputTokens"
                        ],
                        "additionalProperties": false
                    }
                },
                "estimatedInputTokens": {
                    "type": "number",
                    "description": "Input tokens for action=estimate."
                },
                "estimatedOutputTokens": {
                    "type": "number",
                    "description": "Output tokens for action=estimate."
                },
                "taskName": {
                    "type": "string",
                    "description": "Lowercase task name for action=spawn."
                },
                "message": {
                    "type": "string",
                    "description": "Task prompt for spawn or follow-up message."
                },
                "forkTurns": {
                    "type": "string",
                    "description": "Optional context fork mode for action=spawn."
                },
                "writeScope": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Paths the spawned task may write; empty means read-only."
                },
                "target": {
                    "type": "string",
                    "description": "Task path for action=message or action=close."
                },
                "timeoutMs": {
                    "type": "number",
                    "description": "Maximum wait time for action=wait."
                },
                "pathPrefix": {
                    "type": "string",
                    "description": "Optional task path prefix for action=list."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::operator(ToolRiskLevel::Medium)
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let request: TaskOperatorRequest = serde_json::from_value(params)
            .map_err(|err| KordiError::Tool(format!("Invalid task_operator parameters: {err}")))?;

        match request {
            TaskOperatorRequest::Manifest(request) => handle_manifest(request, ctx),
            TaskOperatorRequest::Estimate(request) => handle_estimate(request, ctx),
            TaskOperatorRequest::Spawn(request) => {
                handle_runtime(TaskOperatorRuntimeRequest::Spawn(request), ctx).await
            }
            TaskOperatorRequest::Message(request) => {
                handle_runtime(TaskOperatorRuntimeRequest::Message(request), ctx).await
            }
            TaskOperatorRequest::Wait(request) => {
                handle_runtime(TaskOperatorRuntimeRequest::Wait(request), ctx).await
            }
            TaskOperatorRequest::List(request) => {
                handle_runtime(TaskOperatorRuntimeRequest::List(request), ctx).await
            }
            TaskOperatorRequest::Close(request) => {
                handle_runtime(TaskOperatorRuntimeRequest::Close(request), ctx).await
            }
        }
    }
}

fn handle_manifest(request: TaskManifestRequest, ctx: &ToolContext) -> KordiResult<ToolResult> {
    validate_manifest_tasks(&request.tasks)?;
    let input_tokens = request
        .tasks
        .iter()
        .map(|task| task.estimated_input_tokens)
        .sum::<u64>();
    let output_tokens = request
        .tasks
        .iter()
        .map(|task| task.estimated_output_tokens)
        .sum::<u64>();
    let estimate = build_estimate(ctx, input_tokens, output_tokens);
    let manifest_id = format!("task_manifest_{}", Uuid::new_v4().simple());

    Ok(text_result(
        format!("Task manifest accepted: {manifest_id}"),
        Some(json!({
            "manifestId": manifest_id,
            "status": "accepted",
            "tasks": request.tasks,
            "estimate": estimate,
        })),
    ))
}

async fn handle_runtime(
    request: TaskOperatorRuntimeRequest,
    ctx: &ToolContext,
) -> KordiResult<ToolResult> {
    let Some(runtime) = ctx.task_operator.clone() else {
        return Err(KordiError::Tool(
            "task_operator orchestration is unavailable in this session".to_string(),
        ));
    };

    let response = (runtime.run)(request).await?;
    Ok(text_result(
        runtime_response_text(&response),
        Some(serde_json::to_value(response).map_err(|err| {
            KordiError::Tool(format!("Could not serialize task_operator response: {err}"))
        })?),
    ))
}

fn runtime_response_text(response: &TaskOperatorRuntimeResponse) -> String {
    response
        .message
        .clone()
        .or_else(|| {
            response
                .target
                .as_ref()
                .map(|target| format!("Task {target}: {}", response.status))
        })
        .unwrap_or_else(|| format!("Task operator status: {}", response.status))
}

fn handle_estimate(request: TaskEstimateRequest, ctx: &ToolContext) -> KordiResult<ToolResult> {
    let estimate = build_estimate(
        ctx,
        request.estimated_input_tokens,
        request.estimated_output_tokens,
    );
    Ok(text_result(
        "Task estimate ready".to_string(),
        Some(json!({
            "status": "estimated",
            "estimate": estimate,
        })),
    ))
}

fn build_estimate(ctx: &ToolContext, input_tokens: u64, output_tokens: u64) -> TaskEstimate {
    let cost_microunits = ctx
        .model
        .as_ref()
        .map(|model| estimate_cost_microunits(model, input_tokens, output_tokens))
        .unwrap_or(0);
    TaskEstimate {
        input_tokens,
        output_tokens,
        cost_microunits,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use crate::task_operator::models::{TaskOperatorRuntimeRequest, TaskOperatorRuntimeResponse};
    use crate::{TaskOperatorFn, TaskOperatorRuntime, Tool, ToolContext, ToolLayer, ToolRiskLevel};

    fn make_ctx(runtime: Option<TaskOperatorRuntime>) -> ToolContext {
        ToolContext {
            cwd: "/tmp".into(),
            artifacts_dir: "/tmp".into(),
            model: None,
            execution_policy: crate::ExecutionPolicy::Safety,
            on_output: None,
            web_search: None,
            reach_out: None,
            reflection: None,
            task_operator: runtime,
            execution_mode: crate::ToolExecutionMode::Interactive,
            request_approval: None,
        }
    }

    #[test]
    fn task_operator_uses_operator_metadata() {
        let tool = super::TaskOperatorTool;
        assert_eq!(tool.name(), "task_operator");
        let metadata = tool.metadata();
        assert_eq!(metadata.layer, ToolLayer::Operator);
        assert_eq!(metadata.risk, ToolRiskLevel::Medium);
        assert!(!metadata.supports_parallel);
    }

    #[tokio::test]
    async fn task_operator_delegates_spawn_to_configured_runtime() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_for_runtime = seen.clone();
        let run: TaskOperatorFn = Arc::new(move |request| {
            let seen_for_runtime = seen_for_runtime.clone();
            Box::pin(async move {
                seen_for_runtime.lock().unwrap().push(request.clone());
                Ok(TaskOperatorRuntimeResponse::spawned("/root/research_docs"))
            })
        });
        let tool = super::TaskOperatorTool;
        let result = tool
            .execute(
                serde_json::json!({
                    "action": "spawn",
                    "taskName": "research_docs",
                    "message": "Inspect docs",
                    "writeScope": []
                }),
                &make_ctx(Some(TaskOperatorRuntime { run })),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("spawn should be delegated");

        assert!(!result.is_error);
        assert_eq!(
            result
                .details
                .as_ref()
                .and_then(|value| value.get("target"))
                .and_then(|value| value.as_str()),
            Some("/root/research_docs")
        );
        assert!(matches!(
            seen.lock().unwrap().as_slice(),
            [TaskOperatorRuntimeRequest::Spawn(request)] if request.task_name == "research_docs"
        ));
    }

    #[tokio::test]
    async fn task_operator_errors_when_orchestration_runtime_is_missing() {
        let tool = super::TaskOperatorTool;
        let error = tool
            .execute(
                serde_json::json!({
                    "action": "list"
                }),
                &make_ctx(None),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .unwrap_err()
            .to_string();

        assert!(error.contains("task_operator orchestration is unavailable"));
    }
}
