use std::time::Duration;

use reqwest::{Client, Method};
use serde_json::Value;

use crate::sandbox_client::SandboxClientError;

pub(super) fn error(message: &str) -> SandboxClientError {
    SandboxClientError::Process(message.into())
}

#[derive(Clone)]
pub(super) struct Api {
    client: Client,
    base: String,
    token: String,
}

impl Api {
    pub fn new(app: &str, token: String) -> Result<Self, SandboxClientError> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(75))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| error("Could not initialize Fly API client"))?,
            base: format!("https://api.machines.dev/v1/apps/{app}"),
            token,
        })
    }

    pub async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        nonce: Option<&str>,
    ) -> Result<Value, SandboxClientError> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if let Some(nonce) = nonce {
            request = request.header("fly-machine-lease-nonce", nonce);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| error("Fly API transport failed; reconcile resources before retrying"))?;
        if !response.status().is_success() {
            return Err(error(&format!(
                "Fly API returned HTTP {} for {}",
                response.status().as_u16(),
                path.rsplit('/')
                    .next()
                    .filter(|part| matches!(
                        *part,
                        "machines" | "volumes" | "lease" | "exec" | "start" | "stop"
                    ) || part.starts_with("wait?"))
                    .unwrap_or("resource")
            )));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| error("Fly response interrupted"))?
        {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err(error("Fly response exceeds limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| error("Fly returned invalid JSON"))
    }
}
