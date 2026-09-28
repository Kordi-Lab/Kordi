//! Client for the OMP route worker's interactive login-session API.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Map, Value};

const WORKER_URL_ENV: &str = "KORDI_OMP_ROUTE_WORKER_URL";
const WORKER_TOKEN_ENV: &str = "KORDI_OMP_ROUTE_WORKER_TOKEN";
pub(super) const MAX_WAIT_SECS: u64 = 25;

pub(super) struct LoginWorker {
    base_url: String,
    token: String,
    client: reqwest::Client,
}

pub(super) enum WorkerError {
    Unreachable,
    /// A non-success status with the worker's fixed error code, if it sent one.
    Status(u16, String),
    InvalidResponse,
}

#[derive(Deserialize)]
pub(super) struct WorkerLoginState {
    pub status: String,
    #[serde(default)]
    pub step: Value,
    /// The latest sign-in link; it stays set after later steps.
    #[serde(default)]
    pub auth: Value,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub version: Option<u64>,
}

/// Credential material claimed from the worker. It is deliberately not
/// `Debug`, so it cannot be formatted into a log line or an error.
pub(super) struct ClaimedLogin {
    pub provider: String,
    pub material: Value,
}

#[derive(Deserialize)]
struct ClaimBody {
    provider: String,
    material: Value,
}

impl LoginWorker {
    pub(super) fn from_env() -> Option<Self> {
        let value = |name| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Some(Self {
            base_url: value(WORKER_URL_ENV)?.trim_end_matches('/').to_string(),
            token: value(WORKER_TOKEN_ENV)?,
            client: reqwest::Client::new(),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/login/{path}", self.base_url)
    }

    pub(super) async fn start(
        &self,
        provider: &str,
        session_id: &str,
        method: &str,
    ) -> Result<WorkerLoginState, WorkerError> {
        let request = self.client.post(self.url("start")).json(&json!({
            "provider": provider,
            "sessionId": session_id,
            "method": method,
        }));
        read_state(self.send(request, Duration::from_secs(30)).await?).await
    }

    /// Long-polls for up to `wait_secs` (capped at 25) unless the state
    /// version already differs from `after`.
    pub(super) async fn state(
        &self,
        session_id: &str,
        wait_secs: u64,
        after: Option<u64>,
    ) -> Result<WorkerLoginState, WorkerError> {
        let wait_secs = wait_secs.min(MAX_WAIT_SECS);
        let mut request = self
            .client
            .get(self.url(session_id))
            .query(&[("wait", wait_secs)]);
        if let Some(after) = after {
            request = request.query(&[("after", after)]);
        }
        read_state(
            self.send(request, Duration::from_secs(wait_secs + 10))
                .await?,
        )
        .await
    }

    pub(super) async fn input(
        &self,
        session_id: &str,
        value: &str,
    ) -> Result<WorkerLoginState, WorkerError> {
        let request = self
            .client
            .post(self.url(&format!("{session_id}/input")))
            .json(&json!({ "value": value }));
        read_state(self.send(request, Duration::from_secs(45)).await?).await
    }

    pub(super) async fn cancel(&self, session_id: &str) -> Result<(), WorkerError> {
        let request = self.client.post(self.url(&format!("{session_id}/cancel")));
        self.send(request, Duration::from_secs(15)).await.map(drop)
    }

    pub(super) async fn claim(&self, session_id: &str) -> Result<ClaimedLogin, WorkerError> {
        let request = self.client.post(self.url(&format!("{session_id}/claim")));
        let body: ClaimBody = self
            .send(request, Duration::from_secs(30))
            .await?
            .json()
            .await
            .map_err(|_| WorkerError::InvalidResponse)?;
        Ok(ClaimedLogin {
            provider: body.provider,
            material: body.material,
        })
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        timeout: Duration,
    ) -> Result<reqwest::Response, WorkerError> {
        let response = request
            .bearer_auth(&self.token)
            .timeout(timeout)
            .send()
            .await
            .map_err(|_| WorkerError::Unreachable)?;
        let status = response.status().as_u16();
        if response.status().is_success() {
            return Ok(response);
        }
        let code = response.json::<Value>().await.ok().and_then(|body| {
            body.get("error")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        Err(WorkerError::Status(status, classification(code.as_deref())))
    }
}

async fn read_state(response: reqwest::Response) -> Result<WorkerLoginState, WorkerError> {
    response
        .json::<WorkerLoginState>()
        .await
        .map_err(|_| WorkerError::InvalidResponse)
}

/// Forwards only the documented fields of a login step to clients.
pub(super) fn client_step(step: &Value) -> Value {
    let Some(kind) = step.get("type").and_then(Value::as_str) else {
        return Value::Null;
    };
    let (text_fields, flag_fields): (&[&str], &[&str]) = match kind {
        "open-url" => (&["url", "launchUrl", "instructions"], &[]),
        "prompt" => (&["message", "placeholder"], &["secret", "allowEmpty"]),
        "paste-code" => (&["instructions"], &[]),
        "progress" => (&["message"], &[]),
        "api-key" => (&["instructions", "prompt", "placeholder", "authUrl"], &[]),
        _ => return Value::Null,
    };
    let text = |value: &Value| value.is_string() || value.is_null();
    let mut forwarded = Map::new();
    forwarded.insert("type".into(), Value::String(kind.into()));
    for (fields, accepts) in [
        (text_fields, &text as &dyn Fn(&Value) -> bool),
        (flag_fields, &Value::is_boolean),
    ] {
        for field in fields {
            if let Some(value) = step.get(*field).filter(|value| accepts(value)) {
                forwarded.insert((*field).into(), value.clone());
            }
        }
    }
    Value::Object(forwarded)
}

/// Forwards the latest sign-in link unchanged; URLs are never rewritten.
pub(super) fn client_auth(auth: &Value) -> Value {
    if auth.get("type").and_then(Value::as_str) == Some("open-url") {
        client_step(auth)
    } else {
        Value::Null
    }
}

/// Passes on the worker's fixed error classification, or `unknown` when the
/// worker sent anything other than a short identifier.
pub(super) fn classification(error: Option<&str>) -> String {
    error
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"_-.".contains(&byte)
                })
        })
        .unwrap_or("unknown")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_steps_keep_only_documented_fields() {
        assert_eq!(
            client_step(&json!({
                "type": "prompt",
                "message": "Enter the code",
                "secret": true,
                "placeholder": null,
                "allowEmpty": "yes",
                "material": { "accessToken": "synthetic-leak" }
            })),
            json!({ "type": "prompt", "message": "Enter the code", "placeholder": null, "secret": true })
        );
        let auth = json!({
            "type": "open-url",
            "url": "https://auth.example.test/device?code=ABCD",
            "launchUrl": null,
            "instructions": "Enter the code."
        });
        assert_eq!(client_auth(&auth), auth);
        assert_eq!(
            client_auth(&json!({ "type": "progress", "message": "x" })),
            Value::Null
        );
        assert_eq!(
            client_step(&json!({ "type": "credential", "value": "x" })),
            Value::Null
        );
        assert_eq!(client_step(&Value::Null), Value::Null);
    }

    #[test]
    fn classifications_are_short_identifiers() {
        assert_eq!(classification(Some("invalid_api_key")), "invalid_api_key");
        assert_eq!(
            classification(Some("Provider said: synthetic-secret")),
            "unknown"
        );
        assert_eq!(classification(None), "unknown");
    }
}
