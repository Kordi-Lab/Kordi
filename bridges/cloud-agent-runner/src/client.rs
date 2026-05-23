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
}

#[derive(Clone)]
pub struct HttpCloudAgentRunClient {
    base_url: String,
    runner_token: String,
    runner_id: String,
    http: reqwest::Client,
}

impl HttpCloudAgentRunClient {
    pub fn new(base_url: String, runner_token: String, runner_id: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            runner_token,
            runner_id,
            http: reqwest::Client::new(),
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
            .post_json(
                "/v1/cloud/agent-runs/lease",
                serde_json::json!({ "runnerId": self.runner_id }),
            )
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
}
