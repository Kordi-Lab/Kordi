use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum RunnerClientError {
    #[error("cloud runner client request failed: {0}")]
    Request(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudAgentRun {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub status: String,
    pub prompt: String,
    #[serde(rename = "ownerAccountId")]
    pub owner_account_id: String,
    #[serde(rename = "requesterAccountId")]
    pub requester_account_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sandboxId")]
    pub sandbox_id: Option<String>,
    #[serde(rename = "providerAuthAvailable")]
    pub provider_auth_available: bool,
}

#[derive(Debug, Deserialize)]
struct LeaseResponse {
    run: Option<CloudAgentRun>,
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
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError>;
    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError>;
    async fn complete_run(
        &self,
        run_id: &str,
        response_text: &str,
    ) -> Result<(), RunnerClientError>;
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

    async fn export_artifact(
        &self,
        run_id: &str,
        input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError>;
}

#[derive(Clone)]
pub struct HttpCloudAgentRunClient {
    base_url: String,
    runner_token: String,
    runner_id: String,
    canary_run_id: Option<String>,
    http: reqwest::Client,
}

impl HttpCloudAgentRunClient {
    pub fn new(base_url: String, runner_token: String, runner_id: String) -> Self {
        Self::with_canary_run_id(base_url, runner_token, runner_id, None)
    }

    pub fn with_canary_run_id(
        base_url: String,
        runner_token: String,
        runner_id: String,
        canary_run_id: Option<String>,
    ) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            runner_token,
            runner_id,
            canary_run_id: canary_run_id.and_then(|value| {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }),
            http: reqwest::Client::new(),
        }
    }

    fn lease_request_body(&self) -> serde_json::Value {
        match &self.canary_run_id {
            Some(canary_run_id) => serde_json::json!({
                "runnerId": self.runner_id,
                "canaryRunId": canary_run_id,
            }),
            None => serde_json::json!({ "runnerId": self.runner_id }),
        }
    }

    async fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T, RunnerClientError> {
        let response = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.runner_token)
            .json(&body)
            .send()
            .await
            .map_err(|err| RunnerClientError::Request(err.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| RunnerClientError::Request(err.to_string()))?;
        if !status.is_success() {
            return Err(RunnerClientError::Request(format!(
                "{path} returned {status}: {text}"
            )));
        }
        serde_json::from_str(&text).map_err(|err| RunnerClientError::Request(err.to_string()))
    }
}

#[async_trait]
impl CloudAgentRunClient for HttpCloudAgentRunClient {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        let response: LeaseResponse = self
            .post_json("/v1/cloud/agent-runs/lease", self.lease_request_body())
            .await?;
        Ok(response.run)
    }

    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/running"),
                serde_json::json!({ "runnerId": self.runner_id }),
            )
            .await?;
        let _ = envelope.run;
        Ok(())
    }

    async fn complete_run(
        &self,
        run_id: &str,
        response_text: &str,
    ) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/complete"),
                serde_json::json!({ "runnerId": self.runner_id, "responseText": response_text }),
            )
            .await?;
        let _ = envelope.run;
        Ok(())
    }

    async fn fail_run(
        &self,
        run_id: &str,
        error_code: &str,
        message: &str,
    ) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/fail"),
                serde_json::json!({
                    "runnerId": self.runner_id,
                    "errorCode": error_code,
                    "message": message,
                }),
            )
            .await?;
        let _ = envelope.run;
        Ok(())
    }

    async fn fetch_provider_auth(
        &self,
        run_id: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        let envelope: ProviderAuthEnvelope = self
            .post_json(
                &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
                serde_json::json!({ "runnerId": self.runner_id }),
            )
            .await?;
        Ok(envelope.provider_auth)
    }

    async fn export_artifact(
        &self,
        run_id: &str,
        mut input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        input.runner_id = self.runner_id.clone();
        let body = serde_json::to_value(input)
            .map_err(|err| RunnerClientError::Request(err.to_string()))?;
        let envelope: ArtifactExportEnvelope = self
            .post_json(&format!("/v1/cloud/agent-runs/{run_id}/artifacts"), body)
            .await?;
        Ok(envelope.artifact)
    }
}
