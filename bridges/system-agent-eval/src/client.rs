//! The runner's view of the server, served in-process: provider material for
//! the run, and every plan_card call handed to the server's own runner
//! handler, exactly as the HTTP route would.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kordi_cloud_agent_runner::client::{
    ArtifactExportInput, ArtifactExportResponse, CloudAgentRun, CloudAgentRunClient,
    ProviderAuthMaterial, RunnerClientError,
};
use kordi_cloud_server::ServerState;
use serde::Serialize;
use serde_json::Value;

/// One plan_card call and the server's answer.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub action: String,
    pub accepted: bool,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub arguments: Value,
}

pub struct EvalClient {
    /// Absent for Grounding builds, which call no tools.
    state: Option<Arc<ServerState>>,
    runner_id: String,
    material: ProviderAuthMaterial,
    calls: Mutex<Vec<ToolCall>>,
}

impl EvalClient {
    pub fn new(
        state: Option<Arc<ServerState>>,
        runner_id: &str,
        material: ProviderAuthMaterial,
    ) -> Self {
        Self {
            state,
            runner_id: runner_id.to_string(),
            material,
            calls: Mutex::new(Vec::new()),
        }
    }

    pub fn calls(&self) -> Vec<ToolCall> {
        self.calls.lock().expect("tool call log").clone()
    }

    fn unavailable<T>(what: &str) -> Result<T, RunnerClientError> {
        Err(RunnerClientError::Request(format!(
            "{what} is not part of the quality test"
        )))
    }
}

#[async_trait]
impl CloudAgentRunClient for EvalClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        Ok(None)
    }

    async fn mark_running(&self, _run_id: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }

    async fn complete_run(&self, _run_id: &str, _text: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }

    async fn fail_run(&self, _: &str, _: &str, _: &str) -> Result<(), RunnerClientError> {
        Ok(())
    }

    async fn fetch_provider_auth(
        &self,
        _run_id: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        Ok(self.material.clone())
    }

    async fn export_artifact(
        &self,
        _run_id: &str,
        _input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        Self::unavailable("Artifact export")
    }

    async fn plan_card_action(
        &self,
        run_id: &str,
        request: Value,
    ) -> Result<Value, RunnerClientError> {
        let Some(state) = &self.state else {
            return Self::unavailable("A plan card");
        };
        let response = kordi_cloud_server::plan_cards::runner_action(
            state,
            run_id,
            &self.runner_id,
            request.clone(),
        )
        .await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .map_err(|error| RunnerClientError::Request(error.to_string()))?;
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        self.calls.lock().expect("tool call log").push(ToolCall {
            action: request["action"].as_str().unwrap_or("").to_string(),
            accepted: status.is_success(),
            status: status.as_u16(),
            error_code: body["errorCode"].as_str().map(str::to_string),
            arguments: request,
        });
        if status.is_success() {
            Ok(body)
        } else {
            // The same error text the HTTP runner client returns.
            Err(RunnerClientError::Request(format!(
                "/v1/cloud/agent-runs/{run_id}/plan-card returned {status}: {}",
                String::from_utf8_lossy(&bytes)
            )))
        }
    }
}
