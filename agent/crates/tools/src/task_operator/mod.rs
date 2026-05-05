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
use models::{TaskEstimate, TaskEstimateRequest, TaskManifestRequest, TaskOperatorRequest};
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
                    "enum": ["manifest", "estimate"],
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
    use crate::{Tool, ToolLayer, ToolRiskLevel};

    #[test]
    fn task_operator_uses_operator_metadata() {
        let tool = super::TaskOperatorTool;
        assert_eq!(tool.name(), "task_operator");
        let metadata = tool.metadata();
        assert_eq!(metadata.layer, ToolLayer::Operator);
        assert_eq!(metadata.risk, ToolRiskLevel::Medium);
        assert!(!metadata.supports_parallel);
    }
}
