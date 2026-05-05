use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TaskOperatorRequest {
    Manifest(TaskManifestRequest),
    Estimate(TaskEstimateRequest),
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
