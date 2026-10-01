use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Header carrying the run-scoped credential the server issues with a lease.
pub const RUN_TOKEN_HEADER: &str = "X-Kordi-Run-Token";

#[derive(Debug, thiserror::Error)]
pub enum RunnerClientError {
    #[error("cloud runner client request failed: {0}")]
    Request(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudAgentRun {
    #[serde(rename = "turnIdentity", default)]
    pub turn_identity: Option<kordi_core::types::RuntimeIdentity>,
    #[serde(rename = "historyMessages", default)]
    pub history_messages: Vec<serde_json::Value>,
    #[serde(rename = "subsessionId", default)]
    pub subsession_id: Option<String>,
    #[serde(rename = "subsessionWriteScope", default)]
    pub subsession_write_scope: Vec<String>,
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    pub prompt: String,
    #[serde(rename = "systemPrompt", default)]
    pub system_prompt: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "runtimeRoute", default)]
    pub runtime_route: AgentRuntimeRoute,
    #[serde(rename = "providerAuthAvailable")]
    pub provider_auth_available: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRuntimeRoute {
    #[serde(rename = "defaultModel")]
    pub default_model: Option<String>,
    pub thinking: Option<String>,
}

#[derive(Deserialize)]
struct LeaseResponse {
    run: Option<LeasedRun>,
}

#[derive(Deserialize)]
struct LeasedRun {
    #[serde(flatten)]
    run: CloudAgentRun,
    #[serde(rename = "runToken", default)]
    run_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RunEnvelope {
    run: CloudAgentRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderAuthMaterial {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpContext {
    pub prompt: String,
    pub messages: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpState {
    pub schema_version: u32,
    pub provider: String,
    pub model: String,
    pub auth_snapshot_id: String,
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub replayable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ProviderAuthEnvelope {
    #[serde(rename = "providerAuth")]
    provider_auth: ProviderAuthMaterial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactExportInput {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    pub name: String,
    #[serde(rename = "sandboxPath")]
    pub sandbox_path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: String,
    #[serde(rename = "bytesBase64")]
    pub bytes_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactExportResponse {
    #[serde(rename = "artifactId")]
    pub artifact_id: String,
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub name: String,
    #[serde(rename = "sandboxPath")]
    pub sandbox_path: String,
    #[serde(rename = "contentType")]
    pub content_type: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: i64,
    #[serde(rename = "sha256Hex")]
    pub sha256_hex: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct ArtifactExportEnvelope {
    artifact: ArtifactExportResponse,
}

#[async_trait]
pub trait CloudAgentRunClient {
    async fn task_operator(
        &self,
        _run_id: &str,
        _call_id: &str,
        _arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Subsession tools are unavailable".into(),
        ))
    }

    async fn subsession_progress(
        &self,
        _run_id: &str,
        _call_id: &str,
        _tool_name: &str,
    ) -> Result<(), RunnerClientError> {
        Ok(())
    }
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError>;
    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError>;
    async fn complete_run(
        &self,
        run_id: &str,
        response_text: &str,
    ) -> Result<(), RunnerClientError>;
    async fn complete_run_with_omp_state(
        &self,
        _run_id: &str,
        _response_text: &str,
        _state: OmpState,
    ) -> Result<(), RunnerClientError> {
        Err(RunnerClientError::Request(
            "OMP state persistence is unavailable".into(),
        ))
    }
    async fn fail_run(
        &self,
        run_id: &str,
        error_code: &str,
        message: &str,
    ) -> Result<(), RunnerClientError>;

    async fn fetch_provider_auth(
        &self,
        run_id: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError>;
    async fn fetch_omp_context(
        &self,
        _run_id: &str,
        _provider: &str,
        _model: &str,
        _auth_snapshot_id: &str,
    ) -> Result<OmpContext, RunnerClientError> {
        Err(RunnerClientError::Request(
            "OMP context is unavailable".into(),
        ))
    }

    async fn read_context(
        &self,
        _run_id: &str,
        _tool: &str,
        _arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Conversation retrieval is unavailable".to_string(),
        ))
    }

    /// Forwards one `plan_card` tool call to the server, bound to this run.
    async fn plan_card_action(
        &self,
        _run_id: &str,
        _request: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        Err(RunnerClientError::Request(
            "Plan cards are unavailable".to_string(),
        ))
    }

    async fn export_artifact(
        &self,
        run_id: &str,
        input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError>;
}

mod http;
pub use http::HttpCloudAgentRunClient;
