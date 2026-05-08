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
    TaskCloseRequest, TaskCreateRequest, TaskEstimate, TaskEstimateRequest, TaskManifestRequest,
    TaskOperatorRequest, TaskOperatorRuntimeRequest, TaskOperatorRuntimeResponse,
    TaskSearchRequest,
};
use validation::validate_manifest_tasks;

pub struct TaskOperatorTool;

#[async_trait]
impl Tool for TaskOperatorTool {
    fn name(&self) -> &str {
        "task_operator"
    }

    fn description(&self) -> &str {
        "Operator tool for verifiable Kordi task events and local child task agents. Durable tasks are scoped to the current session and use generated opaque IDs returned by this tool. Actions: create a task with {action:'create', taskTitle:'...'}; create a subtask with parentTaskId; list/search current session tasks with {action:'search', status:'open'} or add query; close with {action:'close', taskId:'task_...'}. Use manifest/estimate/spawn/message/wait/list for local child-agent work. Side effects: create/close affect task state; spawn/message/close with a child-agent target affect child-agent state. Write scopes must be disjoint; retry spawn can fail on duplicate task paths."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "search", "manifest", "estimate", "spawn", "message", "wait", "list", "close"],
                    "description": "Task operator action."
                },
                "taskTitle": {
                    "type": "string",
                    "description": "Concise 5-10 words user-facing title for action=create or task close events; optional overall task title when manifesting or spawning subtasks."
                },
                "parentTaskId": {
                    "type": "string",
                    "description": "Optional parent durable task ID when creating/searching subtasks."
                },
                "involvedParticipants": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Display names of the people or agents who need to be involved in this task. Include this for shared or multi-user tasks."
                },
                "taskId": {
                    "type": "string",
                    "description": "Opaque durable task ID returned by task_operator. For action=close, copy an ID from create/search results. New create actions generate an ID when omitted."
                },
                "summary": {
                    "type": "string",
                    "description": "Short user-facing summary for action=create."
                },
                "query": {
                    "type": "string",
                    "description": "Optional search text for action=search, or fallback match text for action=close when taskId/taskTitle is unavailable. Omit query on action=search to list the current session tasks."
                },
                "status": {
                    "type": "string",
                    "description": "Optional durable task status for action=create or status filter for action=search. Common values: open, waiting, active, completed, closed."
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
                    "description": "Machine-safe lowercase snake_case subagent name for action=spawn, derived from the subtask title; do not use the overall taskTitle here."
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
                    "description": "Child-agent task path for action=message or legacy child-agent action=close. Do not use this for user-visible task assignment."
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
            TaskOperatorRequest::Create(request) => {
                if ctx.task_operator.is_some() {
                    handle_runtime(TaskOperatorRuntimeRequest::Create(request), ctx).await
                } else {
                    handle_create(request)
                }
            }
            TaskOperatorRequest::Search(request) => {
                if ctx.task_operator.is_some() {
                    handle_runtime(TaskOperatorRuntimeRequest::Search(request), ctx).await
                } else {
                    handle_search(request)
                }
            }
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
            TaskOperatorRequest::Close(request) => handle_close(request, ctx).await,
        }
    }
}

fn handle_create(request: TaskCreateRequest) -> KordiResult<ToolResult> {
    let title = request.task_title.trim();
    if title.is_empty() {
        return Err(KordiError::Tool(
            "taskTitle cannot be empty for task create".to_string(),
        ));
    }
    let task_id = request
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("task_{}", Uuid::new_v4().simple()));
    let summary = request
        .summary
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    Ok(text_result(
        format!("Task created: {title}"),
        Some(json!({
            "action": "create",
            "status": "created",
            "taskId": task_id,
            "taskTitle": title,
            "summary": summary,
            "involvedParticipants": request.involved_participants,
        })),
    ))
}

fn handle_search(request: TaskSearchRequest) -> KordiResult<ToolResult> {
    let query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    Ok(text_result(
        query
            .map(|query| format!("Task search: {query}"))
            .unwrap_or_else(|| "Task list requested".to_string()),
        Some(json!({
            "action": "search",
            "status": "searched",
            "query": query,
            "statusFilter": request.status,
            "parentTaskId": request.parent_task_id,
            "tasks": [],
        })),
    ))
}

async fn handle_close(request: TaskCloseRequest, ctx: &ToolContext) -> KordiResult<ToolResult> {
    let child_agent_target = request
        .target
        .as_deref()
        .map(str::trim)
        .filter(|target| target.starts_with('/'));
    if child_agent_target.is_some() || ctx.task_operator.is_some() {
        return handle_runtime(TaskOperatorRuntimeRequest::Close(request), ctx).await;
    }

    let title = request
        .task_title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let task_id = request
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let query = request
        .query
        .as_deref()
        .or(request.target.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let label = title.or(task_id).or(query).ok_or_else(|| {
        KordiError::Tool(
            "task close requires taskId, taskTitle, query, or child-agent target".to_string(),
        )
    })?;

    Ok(text_result(
        format!("Task closed: {label}"),
        Some(json!({
            "action": "close",
            "status": "closed",
            "taskId": task_id,
            "taskTitle": title,
            "query": query,
        })),
    ))
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
    let mut text = response
        .message
        .clone()
        .or_else(|| {
            response
                .target
                .as_ref()
                .map(|target| format!("Task {target}: {}", response.status))
        })
        .unwrap_or_else(|| format!("Task operator status: {}", response.status));

    if !response.tasks.is_empty() {
        text.push_str("\n\nTasks:");
        for task in response.tasks.iter().take(50) {
            text.push_str(&format!(
                "\n- ID: `{}`; title: {}; status: {}",
                task.path, task.title, task.status,
            ));
            if let Some(parent_task_id) = task
                .parent_task_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                text.push_str(&format!("; parent: `{parent_task_id}`"));
            }
            if let Some(summary) = task
                .summary
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                text.push_str(&format!("; summary: {summary}"));
            }
        }
        if response.tasks.len() > 50 {
            text.push_str(&format!("\n- … {} more task(s)", response.tasks.len() - 50));
        }
    }

    text
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

    fn text_content(result: &crate::ToolResult) -> &str {
        match result.content.as_slice() {
            [kordi_core::types::ContentBlock::Text { text }] => text,
            _ => panic!("expected single text result"),
        }
    }

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
        assert!(tool.description().contains("Actions:"));
        assert!(tool.description().contains("Side effects:"));
        assert!(tool.description().contains("retry spawn"));
        assert!(tool.description().contains("taskTitle"));
        let metadata = tool.metadata();
        assert_eq!(metadata.layer, ToolLayer::Operator);
        assert_eq!(metadata.risk, ToolRiskLevel::Medium);
        assert!(!metadata.supports_parallel);
    }

    #[test]
    fn task_operator_schema_prompts_for_parent_task_title() {
        let tool = super::TaskOperatorTool;
        let schema = tool.parameters_schema();
        let description = schema["properties"]["taskTitle"]["description"]
            .as_str()
            .expect("taskTitle should have a description");

        assert!(description.contains("overall task"));
        assert!(description.contains("5-10 words"));
    }

    #[tokio::test]
    async fn task_operator_create_search_and_close_emit_verifiable_events_without_runtime() {
        let tool = super::TaskOperatorTool;
        let create = tool
            .execute(
                serde_json::json!({
                    "action": "create",
                    "taskId": "task_user_2",
                    "taskTitle": "Test Task For Kordi User 2",
                    "summary": "Verify task visibility across the group.",
                    "involvedParticipants": ["Kordi User 2"]
                }),
                &make_ctx(None),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("create should not require child-agent runtime");
        assert_eq!(
            text_content(&create),
            "Task created: Test Task For Kordi User 2"
        );
        assert_eq!(
            create
                .details
                .as_ref()
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str()),
            Some("created")
        );
        assert_eq!(
            create
                .details
                .as_ref()
                .and_then(|value| value.get("taskId"))
                .and_then(|value| value.as_str()),
            Some("task_user_2")
        );

        let search = tool
            .execute(
                serde_json::json!({ "action": "search", "query": "Kordi User 2", "status": "open" }),
                &make_ctx(None),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("search should emit a verifiable query event");
        assert_eq!(
            search
                .details
                .as_ref()
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str()),
            Some("searched")
        );

        let close = tool
            .execute(
                serde_json::json!({
                    "action": "close",
                    "taskId": "task_user_2",
                    "taskTitle": "Test Task For Kordi User 2"
                }),
                &make_ctx(None),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("close should emit a verifiable task event");
        assert_eq!(
            text_content(&close),
            "Task closed: Test Task For Kordi User 2"
        );
        assert_eq!(
            close
                .details
                .as_ref()
                .and_then(|value| value.get("status"))
                .and_then(|value| value.as_str()),
            Some("closed")
        );
    }

    #[tokio::test]
    async fn task_operator_delegates_create_and_search_to_configured_runtime() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_for_runtime = seen.clone();
        let run: TaskOperatorFn = Arc::new(move |request| {
            let seen_for_runtime = seen_for_runtime.clone();
            Box::pin(async move {
                seen_for_runtime.lock().unwrap().push(request.clone());
                Ok(TaskOperatorRuntimeResponse {
                    status: "created".to_string(),
                    message: Some("Task created: Durable Task".to_string()),
                    target: Some("durable-task".to_string()),
                    tasks: Vec::new(),
                })
            })
        });
        let tool = super::TaskOperatorTool;

        let result = tool
            .execute(
                serde_json::json!({
                    "action": "create",
                    "taskId": "durable-task",
                    "taskTitle": "Durable Task"
                }),
                &make_ctx(Some(TaskOperatorRuntime { run })),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("create should be delegated");

        assert_eq!(text_content(&result), "Task created: Durable Task");
        assert!(matches!(
            seen.lock().unwrap().as_slice(),
            [TaskOperatorRuntimeRequest::Create(request)] if request.task_id.as_deref() == Some("durable-task")
        ));
    }

    #[tokio::test]
    async fn task_operator_runtime_search_result_text_exposes_task_ids_to_model() {
        let run: TaskOperatorFn = Arc::new(move |_request| {
            Box::pin(async move {
                Ok(TaskOperatorRuntimeResponse {
                    status: "searched".to_string(),
                    message: Some("Task search matched 1 task(s)".to_string()),
                    target: None,
                    tasks: vec![crate::task_operator::models::TaskOperatorTaskStatus {
                        path: "task_123".to_string(),
                        parent_task_id: Some("task_parent".to_string()),
                        title: "Finish Kordi Issue 317 Review".to_string(),
                        status: "open".to_string(),
                        summary: Some("Review issue 317".to_string()),
                        write_scope: Vec::new(),
                    }],
                })
            })
        });
        let tool = super::TaskOperatorTool;

        let result = tool
            .execute(
                serde_json::json!({
                    "action": "search",
                    "query": "Finish Kordi Issue 317 Review",
                    "status": "open"
                }),
                &make_ctx(Some(TaskOperatorRuntime { run })),
                tokio_util::sync::CancellationToken::new(),
            )
            .await
            .expect("search should be delegated");

        let text = text_content(&result);
        assert!(text.contains("Task search matched 1 task(s)"));
        assert!(text.contains("ID: `task_123`"));
        assert!(text.contains("title: Finish Kordi Issue 317 Review"));
        assert!(text.contains("parent: `task_parent`"));
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
