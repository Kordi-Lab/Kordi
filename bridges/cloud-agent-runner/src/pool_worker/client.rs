//! The five control plane routes a pool worker calls, authenticated with
//! its workload identity token.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

use super::identity::IdentityTokenSource;
use super::PoolWorkerError;
use crate::client::{
    ArtifactExportInput, ArtifactExportResponse, CloudAgentRun, CloudAgentRunClient,
    ProviderAuthMaterial, RunnerClientError,
};

/// One leased run. The lease token is required on every later call.
/// `leaseSeconds` is ignored: heartbeats every 40 s fit the server's lease.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolLease {
    pub run_id: String,
    pub feature: String,
    pub lease_token: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub thinking: Option<String>,
}

#[derive(Deserialize)]
struct LeaseResponse {
    run: Option<PoolLease>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    #[serde(default)]
    cancel_requested: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    #[serde(default)]
    error_code: String,
}

pub(crate) struct ControlPlane {
    http: reqwest::Client,
    base_url: String,
    pool_id: String,
    worker_id: String,
    identity: IdentityTokenSource,
}

impl ControlPlane {
    pub(crate) fn new(
        http: reqwest::Client,
        base_url: &str,
        pool_id: &str,
        worker_id: &str,
        identity: IdentityTokenSource,
    ) -> Self {
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            pool_id: pool_id.to_string(),
            worker_id: worker_id.to_string(),
            identity,
        }
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, PoolWorkerError> {
        let token = self.identity.token().await?;
        let response = self
            .http
            .post(format!("{}{path}", self.base_url))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .map_err(|_| PoolWorkerError::Transport(format!("{path} request failed")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|_| PoolWorkerError::Transport(format!("{path} response was unreadable")))?;
        if !status.is_success() {
            // Only a well-formed error code is kept; the message may echo input.
            let code = serde_json::from_str::<ErrorEnvelope>(&text)
                .map(|envelope| envelope.error_code)
                .unwrap_or_default();
            let code = if is_error_code(&code) {
                code
            } else {
                "unknown".into()
            };
            return Err(PoolWorkerError::Status {
                status: status.as_u16(),
                code,
            });
        }
        serde_json::from_str(&text)
            .map_err(|_| PoolWorkerError::Transport(format!("{path} returned invalid JSON")))
    }

    fn run_body(&self, lease_token: &str) -> serde_json::Map<String, Value> {
        let mut body = serde_json::Map::new();
        body.insert("poolId".into(), json!(self.pool_id));
        body.insert("workerId".into(), json!(self.worker_id));
        body.insert("leaseToken".into(), json!(lease_token));
        body
    }

    async fn post_run(
        &self,
        run_id: &str,
        action: &str,
        lease_token: &str,
        extra: Option<(&str, Value)>,
    ) -> Result<Value, PoolWorkerError> {
        let mut body = self.run_body(lease_token);
        if let Some((key, value)) = extra {
            body.insert(key.into(), value);
        }
        self.post(
            &format!("/v1/cloud/pool-workers/runs/{run_id}/{action}"),
            Value::Object(body),
        )
        .await
    }

    pub(crate) async fn lease(&self) -> Result<Option<PoolLease>, PoolWorkerError> {
        let body = json!({"poolId": self.pool_id, "workerId": self.worker_id});
        let value = self.post("/v1/cloud/pool-workers/lease", body).await?;
        let response: LeaseResponse = serde_json::from_value(value)
            .map_err(|_| PoolWorkerError::Transport("lease returned an invalid run".into()))?;
        Ok(response.run)
    }

    /// Renews the lease; `true` when the run should be abandoned.
    pub(crate) async fn heartbeat(
        &self,
        run_id: &str,
        lease_token: &str,
    ) -> Result<bool, PoolWorkerError> {
        let value = self
            .post_run(run_id, "heartbeat", lease_token, None)
            .await?;
        let response: HeartbeatResponse = serde_json::from_value(value)
            .map_err(|_| PoolWorkerError::Transport("heartbeat returned an invalid body".into()))?;
        Ok(response.cancel_requested)
    }

    pub(crate) async fn plan_card(
        &self,
        run_id: &str,
        lease_token: &str,
        request: Value,
    ) -> Result<Value, PoolWorkerError> {
        self.post_run(run_id, "plan-card", lease_token, Some(("request", request)))
            .await
    }

    pub(crate) async fn complete(
        &self,
        run_id: &str,
        lease_token: &str,
        response_text: &str,
    ) -> Result<(), PoolWorkerError> {
        self.post_run(
            run_id,
            "complete",
            lease_token,
            Some(("responseText", json!(response_text))),
        )
        .await
        .map(drop)
    }

    pub(crate) async fn fail(
        &self,
        run_id: &str,
        lease_token: &str,
        error_code: &str,
    ) -> Result<(), PoolWorkerError> {
        self.post_run(
            run_id,
            "fail",
            lease_token,
            Some(("errorCode", json!(error_code))),
        )
        .await
        .map(drop)
    }
}

/// 1-64 characters of `[a-z0-9_]`.
pub(crate) fn is_error_code(code: &str) -> bool {
    (1..=64).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Adapts one leased run to `CloudAgentRunClient` so the System agent loop
/// runs unchanged. Only `plan_card` reaches the control plane.
pub(crate) struct LeasedRunClient<'a> {
    pub plane: &'a ControlPlane,
    pub lease_token: &'a str,
}

fn unavailable<T>(what: &str) -> Result<T, RunnerClientError> {
    Err(RunnerClientError::Request(format!(
        "{what} is unavailable in pool worker mode"
    )))
}

#[async_trait]
impl CloudAgentRunClient for LeasedRunClient<'_> {
    async fn lease_next_run(&self) -> Result<Option<CloudAgentRun>, RunnerClientError> {
        unavailable("Leasing")
    }

    async fn mark_running(&self, _run_id: &str) -> Result<(), RunnerClientError> {
        unavailable("Marking a run running")
    }

    async fn complete_run(&self, _run_id: &str, _text: &str) -> Result<(), RunnerClientError> {
        unavailable("Completing through the run client")
    }

    async fn fail_run(&self, _: &str, _: &str, _: &str) -> Result<(), RunnerClientError> {
        unavailable("Failing through the run client")
    }

    async fn fetch_provider_auth(
        &self,
        _run_id: &str,
    ) -> Result<ProviderAuthMaterial, RunnerClientError> {
        unavailable("Server provider auth")
    }

    async fn plan_card_action(
        &self,
        run_id: &str,
        request: Value,
    ) -> Result<Value, RunnerClientError> {
        self.plane
            .plan_card(run_id, self.lease_token, request)
            .await
            .map_err(|err| RunnerClientError::Request(err.to_string()))
    }

    async fn export_artifact(
        &self,
        _run_id: &str,
        _input: ArtifactExportInput,
    ) -> Result<ArtifactExportResponse, RunnerClientError> {
        unavailable("Artifact export")
    }
}
