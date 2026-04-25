use async_trait::async_trait;
use kordi_core::error::KordiResult;
use kordi_provider::{Provider, registry::Model};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, future::Future, path::PathBuf, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolScheduling {
    ReadOnly,
    MutatingPaths(Vec<PathBuf>),
    MutatingUnknown,
}

impl ToolScheduling {
    pub fn single_mutating_path(path: PathBuf) -> Self {
        Self::MutatingPaths(vec![path])
    }
}

/// Result from a tool execution.
#[derive(Clone, Debug)]
pub struct ToolResult {
    pub content: Vec<kordi_core::types::ContentBlock>,
    pub details: Option<Value>,
    pub is_error: bool,
    pub artifact_path: Option<PathBuf>,
}

pub type OnOutputFn = Box<dyn Fn(&str) + Send + Sync>;
pub type ToolApprovalFuture = Pin<Box<dyn Future<Output = ToolApprovalOutcome> + Send>>;
pub type RequestToolApprovalFn =
    Arc<dyn Fn(ToolApprovalRequest) -> ToolApprovalFuture + Send + Sync>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolExecutionMode {
    #[default]
    Interactive,
    NonInteractive,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolApprovalRequest {
    pub tool_name: String,
    pub title: String,
    pub command: String,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolApprovalDecision {
    ApprovedOnce,
    ApprovedForSession,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ToolApprovalOutcome {
    pub decision: ToolApprovalDecision,
}

impl ToolApprovalOutcome {
    pub const fn approved(&self) -> bool {
        matches!(
            self.decision,
            ToolApprovalDecision::ApprovedOnce | ToolApprovalDecision::ApprovedForSession
        )
    }

    pub const fn approved_for_session(&self) -> bool {
        matches!(self.decision, ToolApprovalDecision::ApprovedForSession)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ExecutionPolicy {
    #[default]
    Safety,
    Yolo,
}

impl ExecutionPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Safety => "safety",
            Self::Yolo => "yolo",
        }
    }

    pub fn restricts_workspace_writes(self) -> bool {
        matches!(self, Self::Safety)
    }

    pub fn write_scope_label(self) -> &'static str {
        match self {
            Self::Safety => "current project only",
            Self::Yolo => "full access",
        }
    }
}

impl From<kordi_core::settings::ExecutionMode> for ExecutionPolicy {
    fn from(value: kordi_core::settings::ExecutionMode) -> Self {
        match value {
            kordi_core::settings::ExecutionMode::Safety => Self::Safety,
            kordi_core::settings::ExecutionMode::Yolo => Self::Yolo,
        }
    }
}

#[derive(Clone)]
pub struct WebSearchRuntime {
    pub provider: Arc<dyn Provider>,
    pub model: Model,
    pub api_key: String,
    pub base_url: String,
    pub headers: HashMap<String, String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReachOutRequest {
    pub target: String,
    pub target_kind: Option<String>,
    pub message: String,
    pub context: Option<String>,
    pub include_project_context: bool,
    pub wait_for_response: bool,
    pub timeout_seconds: Option<u64>,
    pub parent_session_id: Option<String>,
    pub parent_turn_id: Option<String>,
    pub parent_message_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReachOutResponse {
    pub conversation_id: String,
    pub target_kind: String,
    pub target_display_name: String,
    pub target_owner_name: Option<String>,
    pub response_text: Option<String>,
    pub status: String,
    pub timed_out: bool,
}

pub type ReachOutFuture = Pin<Box<dyn Future<Output = KordiResult<ReachOutResponse>> + Send>>;
pub type ReachOutFn = Arc<dyn Fn(ReachOutRequest) -> ReachOutFuture + Send + Sync>;

#[derive(Clone)]
pub struct ReachOutRuntime {
    pub reach_out: ReachOutFn,
}

/// Context available to tools during execution.
pub struct ToolContext {
    pub cwd: PathBuf,
    pub artifacts_dir: PathBuf,
    pub execution_policy: ExecutionPolicy,
    pub on_output: Option<OnOutputFn>,
    pub web_search: Option<WebSearchRuntime>,
    pub reach_out: Option<ReachOutRuntime>,
    pub execution_mode: ToolExecutionMode,
    pub request_approval: Option<RequestToolApprovalFn>,
}

/// Trait for built-in and custom tools.
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> Value;

    /// Classify whether this call is read-only or may mutate files.
    ///
    /// Mutating tools should override this to return either concrete file paths
    /// for per-file serialization or `MutatingUnknown` when the touched files
    /// cannot be determined up front.
    fn scheduling(&self, _params: &Value, _ctx: &ToolContext) -> ToolScheduling {
        ToolScheduling::ReadOnly
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        cancel: CancellationToken,
    ) -> KordiResult<ToolResult>;
}
