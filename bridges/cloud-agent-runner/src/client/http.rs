//! HTTP implementation of the runner client.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::Deserialize;

use super::*;

#[derive(Clone)]
pub struct HttpCloudAgentRunClient {
    base_url: String,
    runner_token: String,
    runner_id: String,
    canary_run_id: Option<String>,
    http: reqwest::Client,
    /// Run-scoped credentials issued with this client's leases, by run id.
    run_tokens: Arc<Mutex<HashMap<String, String>>>,
}

impl HttpCloudAgentRunClient {
    /// A client for one execution, with its own runner id and its own
    /// run-scoped credentials.
    pub fn for_execution(&self) -> Self {
        Self {
            runner_id: format!("{}:{}", self.runner_id, uuid::Uuid::new_v4().simple()),
            run_tokens: Arc::default(),
            ..self.clone()
        }
    }
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
            run_tokens: Arc::default(),
        }
    }

    fn run_token(&self, run_id: &str) -> Option<String> {
        self.run_tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(run_id)
            .cloned()
    }

    fn remember_run_token(&self, run_id: &str, run_token: Option<String>) {
        let mut tokens = self
            .run_tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match run_token.filter(|token| !token.trim().is_empty()) {
            Some(token) => {
                tokens.insert(run_id.to_string(), token);
            }
            None => {
                tokens.remove(run_id);
            }
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

    /// Posts to a run-specific endpoint with the run-scoped credential issued
    /// when this client leased the run.
    async fn post_run_json<T: for<'de> Deserialize<'de>>(
        &self,
        run_id: &str,
        path: &str,
        body: serde_json::Value,
    ) -> Result<T, RunnerClientError> {
        let run_token = self.run_token(run_id);
        self.send_json(path, run_token.as_deref(), body).await
    }

    async fn send_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        run_token: Option<&str>,
        body: serde_json::Value,
    ) -> Result<T, RunnerClientError> {
        let mut request = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .bearer_auth(&self.runner_token);
        if let Some(run_token) = run_token {
            request = request.header(RUN_TOKEN_HEADER, run_token);
        }
        let response = request
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
    async fn task_operator(
        &self,
        run_id: &str,
        call_id: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        self.post_run_json(run_id, &format!("/v1/cloud/agent-runs/{run_id}/task-operator"), serde_json::json!({"runnerId":self.runner_id,"toolCallId":call_id,"arguments":arguments})).await
    }

    async fn subsession_progress(
        &self,
        run_id: &str,
        call_id: &str,
        tool_name: &str,
    ) -> Result<(), RunnerClientError> {
        let _: serde_json::Value = self.post_run_json(run_id, &format!("/v1/cloud/agent-runs/{run_id}/subsession-progress"), serde_json::json!({"runnerId":self.runner_id,"toolCallId":call_id,"toolName":tool_name})).await?;
        Ok(())
    }
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        let response: LeaseResponse = self
            // Leasing is the only runner request sent without a run
            // credential; every run-specific request uses `post_run_json`.
            .send_json(
                "/v1/cloud/agent-runs/lease",
                None,
                self.lease_request_body(),
            )
            .await?;
        Ok(response.run.map(|leased| {
            self.remember_run_token(&leased.run.run_id, leased.run_token);
            leased.run
        }))
    }

    async fn mark_running(&self, run_id: &str) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self
            .post_run_json(
                run_id,
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
            .post_run_json(
                run_id,
                &format!("/v1/cloud/agent-runs/{run_id}/complete"),
                serde_json::json!({ "runnerId": self.runner_id, "responseText": response_text }),
            )
            .await?;
        let _ = envelope.run;
        Ok(())
    }

    async fn complete_run_with_omp_state(
        &self,
        run_id: &str,
        response_text: &str,
        state: OmpState,
    ) -> Result<(), RunnerClientError> {
        let envelope: RunEnvelope = self.post_run_json(
            run_id,
            &format!("/v1/cloud/agent-runs/{run_id}/complete"),
            serde_json::json!({ "runnerId": self.runner_id, "responseText": response_text, "ompState": state }),
        ).await?;
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
            .post_run_json(
                run_id,
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
            .post_run_json(
                run_id,
                &format!("/v1/cloud/agent-runs/{run_id}/provider-auth"),
                serde_json::json!({ "runnerId": self.runner_id }),
            )
            .await?;
        Ok(envelope.provider_auth)
    }

    async fn fetch_omp_context(
        &self,
        run_id: &str,
        provider: &str,
        model: &str,
        auth_snapshot_id: &str,
    ) -> Result<OmpContext, RunnerClientError> {
        self.post_run_json(
            run_id,
            &format!("/v1/cloud/agent-runs/{run_id}/omp-context"),
            serde_json::json!({ "runnerId": self.runner_id, "provider": provider, "model": model, "authSnapshotId": auth_snapshot_id }),
        ).await
    }

    async fn read_context(
        &self,
        run_id: &str,
        tool: &str,
        arguments: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        self.post_run_json(
            run_id,
            &format!("/v1/cloud/agent-runs/{run_id}/context"),
            serde_json::json!({ "runnerId": self.runner_id, "tool": tool, "arguments": arguments }),
        )
        .await
    }

    async fn plan_card_action(
        &self,
        run_id: &str,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, RunnerClientError> {
        self.post_run_json(
            run_id,
            &format!("/v1/cloud/agent-runs/{run_id}/plan-card"),
            serde_json::json!({ "runnerId": self.runner_id, "request": request }),
        )
        .await
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
            .post_run_json(
                run_id,
                &format!("/v1/cloud/agent-runs/{run_id}/artifacts"),
                body,
            )
            .await?;
        Ok(envelope.artifact)
    }
}
