use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::support::text_result;
use crate::{Tool, ToolContext, ToolMetadata, ToolResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct UpdatePlanInput {
    #[serde(default)]
    explanation: Option<String>,
    #[serde(default)]
    task_title: Option<String>,
    #[serde(default)]
    involved_participants: Vec<String>,
    plan: Vec<PlanItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PlanItem {
    step: String,
    status: String,
}

pub struct UpdatePlanTool;

#[async_trait]
impl Tool for UpdatePlanTool {
    fn name(&self) -> &str {
        "update_plan"
    }

    fn description(&self) -> &str {
        "Planning tool for the visible task plan. Use when work has multiple steps or status changes. Include taskTitle as a concise 5-10 word, user-facing name for the overall task when the work is long-running or multi-step. Input is the complete current plan with one optional in_progress step. Side effect: updates the plan event only; safe to retry by resending the full current plan."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "explanation": {
                    "type": "string",
                    "description": "Optional short note explaining the plan update."
                },
                "taskTitle": {
                    "type": "string",
                    "description": "Optional concise 5-10 words user-facing title for the overall task shown in task panels; generate one for long-running or multi-step work."
                },
                "involvedParticipants": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Display names of the people or agents who need to be involved in this task. Include this for shared or multi-user tasks."
                },
                "plan": {
                    "type": "array",
                    "description": "Plan steps with status pending, in_progress, or completed.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "step": { "type": "string", "description": "Concise step description." },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "Current status for this step."
                            }
                        },
                        "required": ["step", "status"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["plan"],
            "additionalProperties": false
        })
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::planning()
    }

    async fn execute(
        &self,
        params: Value,
        _ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        let input: UpdatePlanInput = serde_json::from_value(params)
            .map_err(|err| KordiError::Tool(format!("Invalid update_plan parameters: {err}")))?;
        validate_plan(&input.plan)?;

        Ok(text_result(
            "Plan updated".to_string(),
            Some(json!({
                "explanation": input.explanation,
                "taskTitle": input.task_title,
                "involvedParticipants": input.involved_participants,
                "plan": input.plan,
            })),
        ))
    }
}

fn validate_plan(plan: &[PlanItem]) -> KordiResult<()> {
    if plan.is_empty() {
        return Err(KordiError::Tool(
            "Plan must contain at least one step".to_string(),
        ));
    }

    let mut in_progress_count = 0;
    for item in plan {
        if item.step.trim().is_empty() {
            return Err(KordiError::Tool("Plan step cannot be empty".to_string()));
        }
        match item.status.as_str() {
            "pending" | "completed" => {}
            "in_progress" => in_progress_count += 1,
            other => {
                return Err(KordiError::Tool(format!(
                    "Invalid plan status `{other}`; expected pending, in_progress, or completed"
                )));
            }
        }
    }

    if in_progress_count > 1 {
        return Err(KordiError::Tool(
            "At most one plan step can be in_progress".to_string(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{Tool, ToolLayer, ToolRiskLevel};

    #[test]
    fn update_plan_schema_requires_plan_and_uses_planning_metadata() {
        let tool = super::UpdatePlanTool;
        assert_eq!(tool.name(), "update_plan");
        assert!(tool.description().contains("Side effect"));
        assert!(tool.description().contains("safe to retry"));
        assert!(tool.description().contains("taskTitle"));

        let schema = tool.parameters_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], serde_json::json!(["plan"]));
        assert!(schema["properties"]["plan"].is_object());
        let task_title_description = schema["properties"]["taskTitle"]["description"]
            .as_str()
            .expect("taskTitle description");
        assert!(task_title_description.contains("overall task"));
        assert!(task_title_description.contains("5-10 words"));

        let metadata = tool.metadata();
        assert_eq!(metadata.layer, ToolLayer::Planning);
        assert_eq!(metadata.risk, ToolRiskLevel::Low);
        assert!(!metadata.supports_parallel);
    }
}
