//! Calls to Apple: its signing keys, the token endpoint and the revoke
//! endpoint. A trait so tests can stand in for Apple without a network.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;

use crate::pool_workers::keys::KeyCache;
use crate::pool_workers::token::KeySet;

pub(crate) const APPLE_KEYS_URL: &str = "https://appleid.apple.com/auth/keys";
pub(crate) const APPLE_TOKEN_URL: &str = "https://appleid.apple.com/auth/token";
pub(crate) const APPLE_REVOKE_URL: &str = "https://appleid.apple.com/auth/revoke";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AppleApiError {
    /// Apple could not be reached or answered with something unreadable.
    Unavailable,
    /// Apple refused the request (for example an expired or reused code).
    Rejected,
}

/// Apple's token endpoint response.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct AppleTokenResponse {
    #[serde(default)]
    pub(crate) refresh_token: Option<String>,
    #[serde(default)]
    pub(crate) id_token: Option<String>,
}

#[async_trait::async_trait]
pub(crate) trait AppleApi: Send + Sync {
    /// Apple's signing keys. With `refresh`, a cached set older than a
    /// minute is fetched again.
    async fn keys(&self, refresh: bool) -> Result<Arc<KeySet>, AppleApiError>;

    /// `POST /auth/token` with `form`.
    async fn exchange_code(
        &self,
        form: &[(&str, &str)],
    ) -> Result<AppleTokenResponse, AppleApiError>;

    /// `POST /auth/revoke` with `form`.
    async fn revoke(&self, form: &[(&str, &str)]) -> Result<(), AppleApiError>;
}

/// The real Apple endpoints.
pub(crate) struct AppleHttp {
    client: reqwest::Client,
}

impl AppleHttp {
    pub(crate) fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
        }
    }

    async fn post(&self, url: &str, form: &[(&str, &str)]) -> Result<Vec<u8>, AppleApiError> {
        let response = self
            .client
            .post(url)
            .header("accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|_| AppleApiError::Unavailable)?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|_| AppleApiError::Unavailable)?;
        if status.is_client_error() {
            return Err(AppleApiError::Rejected);
        }
        if !status.is_success() || body.len() > MAX_RESPONSE_BYTES {
            return Err(AppleApiError::Unavailable);
        }
        Ok(body.to_vec())
    }
}

#[async_trait::async_trait]
impl AppleApi for AppleHttp {
    async fn keys(&self, refresh: bool) -> Result<Arc<KeySet>, AppleApiError> {
        KeyCache::shared()
            .keys_at(APPLE_KEYS_URL, refresh)
            .await
            .map_err(|_| AppleApiError::Unavailable)
    }

    async fn exchange_code(
        &self,
        form: &[(&str, &str)],
    ) -> Result<AppleTokenResponse, AppleApiError> {
        let body = self.post(APPLE_TOKEN_URL, form).await?;
        serde_json::from_slice(&body).map_err(|_| AppleApiError::Unavailable)
    }

    async fn revoke(&self, form: &[(&str, &str)]) -> Result<(), AppleApiError> {
        self.post(APPLE_REVOKE_URL, form).await.map(|_| ())
    }
}
