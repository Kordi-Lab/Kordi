use std::sync::{Arc, Mutex};

use crate::task_operator::models::{
    TaskOperatorBackgroundSession, TaskOperatorRuntimeRequest, TaskOperatorRuntimeResponse,
};
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
        session_observation: None,
        task_operator: runtime,
        schedule_task: None,
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
    assert!(tool.description().contains("inspect"));
    assert!(tool.description().contains("must not be used to infer"));
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
                background_session: None,
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
                background_session: None,
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
            Ok(TaskOperatorRuntimeResponse {
                status: "running".to_string(),
                message: Some("Task agent running: /root/research_docs".to_string()),
                target: Some("/root/research_docs".to_string()),
                tasks: Vec::new(),
                background_session: Some(TaskOperatorBackgroundSession {
                    session_id: "session-research".to_string(),
                    turn_id: Some("turn-research".to_string()),
                    title: "Research documentation".to_string(),
                    status: "running".to_string(),
                }),
            })
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
    assert!(text_content(&result).contains(
        "Background session: {\"sessionId\":\"session-research\",\"turnId\":\"turn-research\",\"title\":\"Research documentation\",\"status\":\"running\"}",
    ));
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
