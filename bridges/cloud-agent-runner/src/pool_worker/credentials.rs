//! The model credential, read inside the sponsor's own cloud project. The
//! control plane never sees it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::json;

use super::config::{ModelCredentialSource, PoolWorkerConfig};
use super::identity::{checked_text, AccessTokenSource};
use super::PoolWorkerError;
use crate::client::ProviderAuthMaterial;

/// API keys are re-read this often so a rotated secret is picked up.
const API_KEY_TTL: Duration = Duration::from_secs(3600);

pub(crate) struct ModelCredentials {
    http: reqwest::Client,
    source: ModelCredentialSource,
    provider: &'static str,
    base_url: String,
    model: String,
    snapshot_id: String,
    secret_manager_url: String,
    access: AccessTokenSource,
    api_key: Mutex<Option<(String, Instant)>>,
}

impl ModelCredentials {
    pub(crate) fn new(http: reqwest::Client, config: &PoolWorkerConfig) -> Self {
        Self {
            access: AccessTokenSource::new(http.clone(), &config.metadata_url),
            http,
            source: config.credential.clone(),
            provider: config.provider.id(),
            base_url: config.base_url.clone(),
            model: config.model.clone(),
            snapshot_id: format!("pool-worker:{}", config.pool_id),
            secret_manager_url: config.secret_manager_url.trim_end_matches('/').to_string(),
            api_key: Mutex::new(None),
        }
    }

    /// Provider auth for one run, built locally in the shape the model loop reads.
    pub(crate) async fn material(&self) -> Result<ProviderAuthMaterial, PoolWorkerError> {
        let (auth_choice, key) = match &self.source {
            ModelCredentialSource::Vertex { .. } => {
                ("pool-worker-google-cloud", self.access.token().await?)
            }
            _ => ("pool-worker-api-key", self.api_key().await?),
        };
        Ok(ProviderAuthMaterial {
            snapshot_id: self.snapshot_id.clone(),
            provider: self.provider.to_string(),
            auth_choice: auth_choice.to_string(),
            payload: json!({"apiKey": key, "baseUrl": self.base_url, "model": self.model}),
        })
    }

    async fn api_key(&self) -> Result<String, PoolWorkerError> {
        {
            let guard = self.api_key.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((key, until)) = guard.as_ref() {
                if Instant::now() < *until {
                    return Ok(key.clone());
                }
            }
        }
        let key = match &self.source {
            ModelCredentialSource::ApiKeyFile(path) => tokio::fs::read_to_string(path)
                .await
                .map_err(|_| PoolWorkerError::Credential("API key file is unreadable".into()))?,
            ModelCredentialSource::SecretManager(name) => self.secret_manager_key(name).await?,
            ModelCredentialSource::Vertex { .. } => {
                return Err(PoolWorkerError::Credential(
                    "vertex-ai has no API key".into(),
                ))
            }
        };
        let key = key.trim().to_string();
        if key.is_empty() {
            return Err(PoolWorkerError::Credential("model API key is empty".into()));
        }
        *self.api_key.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((key.clone(), Instant::now() + API_KEY_TTL));
        Ok(key)
    }

    async fn secret_manager_key(&self, name: &str) -> Result<String, PoolWorkerError> {
        let token = self.access.token().await?;
        let url = format!("{}/v1/{name}:access", self.secret_manager_url);
        let text = checked_text(
            self.http.get(url).bearer_auth(token).send().await,
            "Secret Manager",
        )
        .await?;
        decode_secret_payload(&text)
    }
}

/// The secret text from a Secret Manager `access` response.
pub(crate) fn decode_secret_payload(body: &str) -> Result<String, PoolWorkerError> {
    let invalid = || PoolWorkerError::Credential("Secret Manager response is invalid".into());
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| invalid())?;
    let data = value
        .pointer("/payload/data")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(invalid)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| invalid())?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    Ok(text.trim().to_string())
}
