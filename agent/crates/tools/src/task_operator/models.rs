use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TaskOperatorRequest {
    Create(TaskCreateRequest),
    Search(TaskSearchRequest),
    Manifest(TaskManifestRequest),
    Estimate(TaskEstimateRequest),
    Spawn(TaskSpawnRequest),
    Message(TaskMessageRequest),
    Wait(TaskWaitRequest),
    List(TaskListRequest),
    Inspect(TaskInspectRequest),
    Close(TaskCloseRequest),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TaskOperatorRuntimeRequest {
    Create(TaskCreateRequest),
    Search(TaskSearchRequest),
    Spawn(TaskSpawnRequest),
    Message(TaskMessageRequest),
    Wait(TaskWaitRequest),
    List(TaskListRequest),
    Inspect(TaskInspectRequest),
    Close(TaskCloseRequest),
}

impl TaskOperatorRequest {
    pub fn into_runtime_request(self) -> Option<TaskOperatorRuntimeRequest> {
        match self {
            Self::Create(request) => Some(TaskOperatorRuntimeRequest::Create(request)),
            Self::Search(request) => Some(TaskOperatorRuntimeRequest::Search(request)),
            Self::Spawn(request) => Some(TaskOperatorRuntimeRequest::Spawn(request)),
            Self::Message(request) => Some(TaskOperatorRuntimeRequest::Message(request)),
            Self::Wait(request) => Some(TaskOperatorRuntimeRequest::Wait(request)),
            Self::List(request) => Some(TaskOperatorRuntimeRequest::List(request)),
            Self::Inspect(request) => Some(TaskOperatorRuntimeRequest::Inspect(request)),
            Self::Close(request) => Some(TaskOperatorRuntimeRequest::Close(request)),
            Self::Manifest(_) | Self::Estimate(_) => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskManifestRequest {
    pub tasks: Vec<TaskManifestTask>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEstimateRequest {
    pub estimated_input_tokens: u64,
    pub estimated_output_tokens: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreateRequest {
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub parent_task_id: Option<String>,
    pub task_title: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub involved_participants: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSearchRequest {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub parent_task_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpawnRequest {
    pub task_name: String,
    #[serde(default)]
    pub task_title: Option<String>,
    pub message: String,
    pub fork_turns: Option<String>,
    #[serde(default)]
    pub write_scope: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskMessageRequest {
    pub target: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskWaitRequest {
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskListRequest {
    pub path_prefix: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskInspectRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskCloseRequest {
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub task_title: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskManifestTask {
    pub task_id: String,
    pub title: String,
    pub summary: String,
    pub dependencies: Vec<String>,
    pub write_scope: Vec<String>,
    pub risk: TaskRisk,
    pub estimated_input_tokens: u64,
    pub estimated_output_tokens: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskRisk {
    ReadOnly,
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEstimate {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_microunits: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskOperatorTaskStatus {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    pub title: String,
    pub status: String,
    pub summary: Option<String>,
    pub write_scope: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskOperatorBackgroundSession {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub title: String,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskOperatorRuntimeResponse {
    pub status: String,
    pub message: Option<String>,
    pub target: Option<String>,
    #[serde(default)]
    pub tasks: Vec<TaskOperatorTaskStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_session: Option<TaskOperatorBackgroundSession>,
}

impl TaskOperatorRuntimeResponse {
    pub fn spawned(target: impl Into<String>) -> Self {
        let target = target.into();
        Self {
            status: "spawned".to_string(),
            message: Some(format!("Task agent spawned: {target}")),
            target: Some(target),
            tasks: Vec::new(),
            background_session: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{TaskManifestRequest, TaskManifestTask, TaskOperatorRequest, TaskRisk};

    #[test]
    fn manifest_request_deserializes_tagged_action() {
        let request: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "manifest",
            "tasks": [
                {
                    "taskId": "inspect_tools",
                    "title": "Inspect tools",
                    "summary": "Map current tool registry",
                    "dependencies": [],
                    "writeScope": [],
                    "risk": "read_only",
                    "estimatedInputTokens": 1000,
                    "estimatedOutputTokens": 250
                }
            ]
        }))
        .expect("manifest request should deserialize");

        assert!(
            matches!(request, TaskOperatorRequest::Manifest(TaskManifestRequest { tasks }) if tasks.len() == 1)
        );
    }

    #[test]
    fn durable_task_actions_deserialize_from_tagged_requests() {
        let create: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "create",
            "taskId": "task_user_2",
            "parentTaskId": "task_parent",
            "taskTitle": "Test Task For Kordi User 2",
            "summary": "Verify task visibility across the group.",
            "status": "waiting",
            "involvedParticipants": ["Kordi User 2"]
        }))
        .expect("create request should deserialize");
        assert!(
            matches!(create, TaskOperatorRequest::Create(request) if request.task_title == "Test Task For Kordi User 2" && request.parent_task_id.as_deref() == Some("task_parent") && request.status.as_deref() == Some("waiting"))
        );

        let search: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "search",
            "query": "Kordi User 2",
            "status": "open",
            "parentTaskId": "task_parent"
        }))
        .expect("search request should deserialize");
        assert!(
            matches!(search, TaskOperatorRequest::Search(request) if request.query.as_deref() == Some("Kordi User 2") && request.parent_task_id.as_deref() == Some("task_parent"))
        );

        let close: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "close",
            "taskId": "task_user_2",
            "taskTitle": "Test Task For Kordi User 2"
        }))
        .expect("task close request should deserialize");
        assert!(
            matches!(close, TaskOperatorRequest::Close(request) if request.task_id.as_deref() == Some("task_user_2"))
        );
    }

    #[test]
    fn orchestration_actions_deserialize_from_tagged_requests() {
        let spawn: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "spawn",
            "taskName": "research_docs",
            "taskTitle": "Research documentation",
            "message": "Inspect the docs and summarize the relevant files.",
            "forkTurns": "active",
            "writeScope": []
        }))
        .expect("spawn request should deserialize");
        assert!(
            matches!(spawn, TaskOperatorRequest::Spawn(request) if request.task_name == "research_docs" && request.task_title.as_deref() == Some("Research documentation"))
        );

        let message: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "message",
            "target": "/root/research_docs",
            "message": "Also check the desktop UI path."
        }))
        .expect("message request should deserialize");
        assert!(
            matches!(message, TaskOperatorRequest::Message(request) if request.target == "/root/research_docs")
        );

        let wait: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "wait",
            "timeoutMs": 1000
        }))
        .expect("wait request should deserialize");
        assert!(
            matches!(wait, TaskOperatorRequest::Wait(request) if request.timeout_ms == Some(1000))
        );

        let list: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "list",
            "pathPrefix": "/root"
        }))
        .expect("list request should deserialize");
        assert!(
            matches!(list, TaskOperatorRequest::List(request) if request.path_prefix.as_deref() == Some("/root"))
        );

        let inspect: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "inspect",
            "sessionId": "session-background"
        }))
        .expect("inspect request should deserialize");
        assert!(
            matches!(inspect, TaskOperatorRequest::Inspect(request) if request.session_id == "session-background")
        );

        let close: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "close",
            "target": "/root/research_docs"
        }))
        .expect("close request should deserialize");
        assert!(
            matches!(close, TaskOperatorRequest::Close(request) if request.target.as_deref() == Some("/root/research_docs"))
        );
    }

    #[test]
    fn task_risk_uses_snake_case_values() {
        let task: TaskManifestTask = serde_json::from_value(serde_json::json!({
            "taskId": "write_plan",
            "title": "Write plan",
            "summary": "Create implementation plan",
            "dependencies": [],
            "writeScope": ["docs/plan.md"],
            "risk": "medium",
            "estimatedInputTokens": 2000,
            "estimatedOutputTokens": 1000
        }))
        .expect("task should deserialize");

        assert_eq!(task.risk, TaskRisk::Medium);
    }
}
