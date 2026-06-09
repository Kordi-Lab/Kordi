use serde::{Deserialize, Serialize};

use crate::scheduled_tasks::schedule::ScheduledTaskSchedule;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScheduledTaskTargetRuntime {
    Cloud,
    LocalRequired,
}

impl ScheduledTaskTargetRuntime {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cloud => "cloud",
            Self::LocalRequired => "local_required",
        }
    }
}

impl TryFrom<&str> for ScheduledTaskTargetRuntime {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "cloud" => Ok(Self::Cloud),
            "local_required" => Ok(Self::LocalRequired),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScheduledTaskRequest {
    pub title: String,
    pub prompt: String,
    pub schedule: ScheduledTaskSchedule,
    pub target_runtime: ScheduledTaskTargetRuntime,
    #[serde(default)]
    pub tool_payload: serde_json::Value,
}

impl CreateScheduledTaskRequest {
    pub fn is_well_formed(&self) -> bool {
        !self.title.trim().is_empty() && !self.prompt.trim().is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskResponse {
    pub task_id: String,
    pub title: String,
    pub prompt: String,
    pub session_id: Option<String>,
    pub schedule: ScheduledTaskSchedule,
    pub target_runtime: String,
    pub enabled: bool,
    pub status: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_run_status: Option<String>,
    pub last_run_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTaskRunResponse {
    pub run_id: String,
    pub task_id: String,
    pub status: String,
    pub target_runtime: String,
    pub due_at: String,
    pub result_message: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}
