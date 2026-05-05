use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TaskOperatorRequest {
    Manifest(TaskManifestRequest),
    Estimate(TaskEstimateRequest),
    Spawn(TaskSpawnRequest),
    Message(TaskMessageRequest),
    Wait(TaskWaitRequest),
    List(TaskListRequest),
    Close(TaskCloseRequest),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TaskOperatorRuntimeRequest {
    Spawn(TaskSpawnRequest),
    Message(TaskMessageRequest),
    Wait(TaskWaitRequest),
    List(TaskListRequest),
    Close(TaskCloseRequest),
}

impl TaskOperatorRequest {
    pub fn into_runtime_request(self) -> Option<TaskOperatorRuntimeRequest> {
        match self {
            Self::Spawn(request) => Some(TaskOperatorRuntimeRequest::Spawn(request)),
            Self::Message(request) => Some(TaskOperatorRuntimeRequest::Message(request)),
            Self::Wait(request) => Some(TaskOperatorRuntimeRequest::Wait(request)),
            Self::List(request) => Some(TaskOperatorRuntimeRequest::List(request)),
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
pub struct TaskSpawnRequest {
    pub task_name: String,
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
pub struct TaskCloseRequest {
    pub target: String,
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
    pub title: String,
    pub status: String,
    pub summary: Option<String>,
    pub write_scope: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskOperatorRuntimeResponse {
    pub status: String,
    pub message: Option<String>,
    pub target: Option<String>,
    #[serde(default)]
    pub tasks: Vec<TaskOperatorTaskStatus>,
}

impl TaskOperatorRuntimeResponse {
    pub fn spawned(target: impl Into<String>) -> Self {
        let target = target.into();
        Self {
            status: "spawned".to_string(),
            message: Some(format!("Task agent spawned: {target}")),
            target: Some(target),
            tasks: Vec::new(),
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
    fn orchestration_actions_deserialize_from_tagged_requests() {
        let spawn: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "spawn",
            "taskName": "research_docs",
            "message": "Inspect the docs and summarize the relevant files.",
            "forkTurns": "active",
            "writeScope": []
        }))
        .expect("spawn request should deserialize");
        assert!(
            matches!(spawn, TaskOperatorRequest::Spawn(request) if request.task_name == "research_docs")
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

        let close: TaskOperatorRequest = serde_json::from_value(serde_json::json!({
            "action": "close",
            "target": "/root/research_docs"
        }))
        .expect("close request should deserialize");
        assert!(
            matches!(close, TaskOperatorRequest::Close(request) if request.target == "/root/research_docs")
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
