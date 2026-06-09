use std::{future::Future, pin::Pin, sync::Arc};

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::support::text_result;
use crate::{Tool, ToolContext, ToolMetadata, ToolResult, ToolRiskLevel};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScheduleTaskSchedule {
    Once {
        at: String,
    },
    Daily {
        time: String,
        timezone: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleTaskTargetRuntime {
    Cloud,
    LocalRequired,
}

impl ScheduleTaskTargetRuntime {
    pub fn response_value(&self) -> &'static str {
        match self {
            Self::Cloud => "cloud",
            Self::LocalRequired => "local_required",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTaskRequest {
    pub title: String,
    pub prompt: String,
    pub schedule: ScheduleTaskSchedule,
    pub target_runtime: ScheduleTaskTargetRuntime,
    #[serde(default)]
    pub tool_payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTaskResponse {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub target_runtime: String,
    pub next_run_at: Option<String>,
}

pub type ScheduleTaskFuture =
    Pin<Box<dyn Future<Output = KordiResult<ScheduleTaskResponse>> + Send>>;
pub type ScheduleTaskFn = Arc<dyn Fn(ScheduleTaskRequest) -> ScheduleTaskFuture + Send + Sync>;

#[derive(Clone)]
pub struct ScheduleTaskRuntime {
    pub schedule: ScheduleTaskFn,
}

pub struct ScheduleTaskTool;

#[async_trait]
impl Tool for ScheduleTaskTool {
    fn name(&self) -> &str {
        "schedule_task"
    }

    fn description(&self) -> &str {
        "Cloud-backed scheduled task tool for user-visible one-shot or daily agent work. Use this whenever the user asks to schedule, remind, check later, run every day, or do work at a future time. Interpret unqualified times like '13:30' or 'today at 12:00' in the user's local Desktop timezone; only use UTC when the user explicitly says UTC/GMT. Choose targetRuntime='localRequired' when the task needs this Mac or local files, disk usage, Downloads, screenshots, local apps, local credentials, or local filesystem access. Choose targetRuntime='cloud' for work that can run without the Desktop app, including web search, communication, reminders, cloud-only reasoning, and remote API work. Do not use bash, at, cron, launchd, or local shell scheduling for user-visible scheduled work; create the Cloud-backed task here so it appears in the Tasks panel."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Short user-facing job title, e.g. 'Check disk usage'."
                },
                "prompt": {
                    "type": "string",
                    "description": "Full instruction to run when the schedule fires. Include what result should be saved or reported."
                },
                "schedule": {
                    "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "const": "once" },
                                "at": { "type": "string", "description": "RFC3339 timestamp for one-shot schedules." }
                            },
                            "required": ["kind", "at"],
                            "additionalProperties": false
                        },
                        {
                            "type": "object",
                            "properties": {
                                "kind": { "type": "string", "const": "daily" },
                                "time": { "type": "string", "description": "HH:MM 24-hour time." },
                                "timezone": { "type": "string", "description": "Timezone for the daily wall-clock time. Omit or use local for normal user requests; use UTC only when the user explicitly says UTC/GMT." }
                            },
                            "required": ["kind", "time"],
                            "additionalProperties": false
                        }
                    ]
                },
                "targetRuntime": {
                    "type": "string",
                    "enum": ["cloud", "localRequired"],
                    "description": "Use localRequired for Mac/local filesystem/app work; use cloud for web, communication, reminders, or cloud-only work."
                },
                "toolPayload": {
                    "description": "Optional structured payload for the eventual runner. Include requiresLocalMac=true when targetRuntime is localRequired."
                }
            },
            "required": ["title", "prompt", "schedule", "targetRuntime"],
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
        let request: ScheduleTaskRequest = serde_json::from_value(params)
            .map_err(|err| KordiError::Tool(format!("Invalid schedule_task parameters: {err}")))?;
        if request.title.trim().is_empty() || request.prompt.trim().is_empty() {
            return Err(KordiError::Tool(
                "schedule_task requires non-empty title and prompt".to_string(),
            ));
        }
        let Some(runtime) = ctx.schedule_task.clone() else {
            return Err(KordiError::Tool(
                "schedule_task is unavailable because Cloud scheduled tasks are not connected in this session".to_string(),
            ));
        };
        let response = (runtime.schedule)(request).await?;
        Ok(text_result(
            format!(
                "Scheduled Cloud task: {} ({})",
                response.title,
                response
                    .next_run_at
                    .as_deref()
                    .unwrap_or("next run pending")
            ),
            Some(json!({
                "action": "schedule_task",
                "status": response.status,
                "taskId": response.task_id,
                "title": response.title,
                "targetRuntime": response.target_runtime,
                "nextRunAt": response.next_run_at,
            })),
        ))
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    use kordi_core::types::ContentBlock;
    use serde_json::json;

    use super::*;
    use crate::{ExecutionPolicy, ToolExecutionMode};

    fn make_ctx(runtime: Option<ScheduleTaskRuntime>) -> ToolContext {
        ToolContext {
            cwd: PathBuf::from("/tmp"),
            artifacts_dir: PathBuf::from("/tmp"),
            model: None,
            execution_policy: ExecutionPolicy::Safety,
            on_output: None,
            web_search: None,
            reach_out: None,
            reflection: None,
            task_operator: None,
            schedule_task: runtime,
            execution_mode: ToolExecutionMode::Interactive,
            request_approval: None,
        }
    }

    #[test]
    fn schedule_task_request_deserializes_cloud_api_shape() {
        let request: ScheduleTaskRequest = serde_json::from_value(json!({
            "title": "Check disk usage",
            "prompt": "Check local disk usage and report the result.",
            "schedule": { "kind": "once", "at": "2026-06-09T12:00:00Z" },
            "targetRuntime": "localRequired",
            "toolPayload": { "requiresLocalMac": true }
        }))
        .expect("request should deserialize");

        assert_eq!(request.title, "Check disk usage");
        assert!(matches!(
            request.schedule,
            ScheduleTaskSchedule::Once { .. }
        ));
        assert_eq!(
            request.target_runtime,
            ScheduleTaskTargetRuntime::LocalRequired
        );
        assert_eq!(request.tool_payload["requiresLocalMac"], true);
    }

    #[tokio::test]
    async fn schedule_task_delegates_to_runtime_and_reports_task_id() {
        let captured = Arc::new(Mutex::new(Vec::<ScheduleTaskRequest>::new()));
        let captured_for_runtime = captured.clone();
        let runtime = ScheduleTaskRuntime {
            schedule: Arc::new(move |request| {
                captured_for_runtime.lock().unwrap().push(request);
                Box::pin(async {
                    Ok(ScheduleTaskResponse {
                        task_id: "scheduled_task_123".to_string(),
                        title: "Check disk usage".to_string(),
                        status: "active".to_string(),
                        target_runtime: "local_required".to_string(),
                        next_run_at: Some("2026-06-09T12:00:00Z".to_string()),
                    })
                })
            }),
        };

        let result = ScheduleTaskTool
            .execute(
                json!({
                    "title": "Check disk usage",
                    "prompt": "Check local disk usage and report the result.",
                    "schedule": { "kind": "once", "at": "2026-06-09T12:00:00Z" },
                    "targetRuntime": "localRequired"
                }),
                &make_ctx(Some(runtime)),
                CancellationToken::new(),
            )
            .await
            .expect("tool should run");

        assert_eq!(captured.lock().unwrap()[0].title, "Check disk usage");
        assert_eq!(
            result.details.as_ref().unwrap()["taskId"],
            "scheduled_task_123"
        );
        assert!(
            matches!(&result.content[0], ContentBlock::Text { text } if text.contains("Scheduled Cloud task"))
        );
    }
}
