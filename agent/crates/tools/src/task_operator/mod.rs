pub mod cost;
pub mod models;
mod response_text;
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
    TaskOperatorRequest, TaskOperatorRuntimeRequest, TaskSearchRequest,
};
use response_text::runtime_response_text;
use validation::validate_manifest_tasks;

pub struct TaskOperatorTool;

#[async_trait]
impl Tool for TaskOperatorTool {
    fn allows_shared_requests(&self) -> bool {
        true
    }

    fn name(&self) -> &str {
        "task_operator"
    }

    fn description(&self) -> &str {
        "Operator tool for verifiable Kordi task events and bounded child-agent work. Durable tasks are scoped to the current session and use generated opaque IDs returned by this tool. Actions: create a task with {action:'create', taskTitle:'...'}; create a subtask with parentTaskId; list/search current session tasks with {action:'search', status:'open'} or add query; close with {action:'close', taskId:'task_...'}. Use spawn only for a concrete, independent task that can continue in a separate agent session; provide a concise user-facing taskTitle, a self-contained message, forkTurns:'none', and disjoint writeScope paths. After a successful background spawn, continue the parent turn with a short normal response instead of waiting. For a later status or result request, use inspect with the exact sessionId returned by spawn. list/wait cover only the current live child registry and must not be used to infer durable linked-session status; search returns user-visible task records, not agent execution state. Side effects: create/close affect task state; spawn/message/close with a child-agent target affect child-agent state. Write scopes must be disjoint; retry spawn can fail on duplicate task paths."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "search", "manifest", "estimate", "spawn", "message", "wait", "list", "inspect", "close"],
                    "description": "Task operator action."
                },
                "taskTitle": {
                    "type": "string",
                    "description": "Concise 5-10 words for the user-facing overall task title used by action=create, task close events, or the linked agent session created by action=spawn."
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
                    "description": "Context fork mode for action=spawn. Use 'none' for background work so the spawn message is the child's self-contained context."
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
                },
                "sessionId": {
                    "type": "string",
                    "description": "Exact linked background session ID returned by action=spawn; required for action=inspect."
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

        if ctx.execution_policy == crate::ExecutionPolicy::Shared {
            if ctx.task_operator.is_none() {
                return Err(KordiError::Tool("Shared task scope is unavailable".into()));
            }
            if let TaskOperatorRequest::Spawn(request) = &request
                && (!request.write_scope.is_empty()
                    || request
                        .fork_turns
                        .as_deref()
                        .is_some_and(|mode| mode != "none"))
            {
                return Err(KordiError::Tool("Shared background work cannot grant local write access or copy private session history".into()));
            }
        }

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
            TaskOperatorRequest::Inspect(request) => {
                handle_runtime(TaskOperatorRuntimeRequest::Inspect(request), ctx).await
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
mod tests;
