//! OAuth access tokens for Google Cloud Storage from the instance identity.
//!
//! The token comes from the metadata server of the machine the Cloud server
//! runs on, so no service account key ever exists. Tokens are cached until
//! shortly before they expire and are never logged or formatted.

use std::fmt;
use std::time::{Duration, Instant};

use reqwest::header::HeaderValue;
use serde::Deserialize;
use tokio::sync::Mutex;
use url::Url;

use super::ObjectStoreError;

/// Metadata server endpoint for the default service account of the instance.
pub const DEFAULT_GCS_TOKEN_URL: &str =
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const TOKEN_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Refresh this long before the reported expiry.
const REFRESH_MARGIN: Duration = Duration::from_secs(120);

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

struct CachedToken {
    header: HeaderValue,
    refresh_at: Instant,
}

/// Fetches and caches bearer tokens. Cloning the header keeps it marked
/// sensitive, so HTTP client debug output never shows it.
pub struct GcsTokenSource {
    http: reqwest::Client,
    url: Url,
    cached: Mutex<Option<CachedToken>>,
}

impl fmt::Debug for GcsTokenSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GcsTokenSource")
            .field("token", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl GcsTokenSource {
    pub fn new(url: Url) -> Result<Self, ObjectStoreError> {
        let http = reqwest::Client::builder()
            .timeout(TOKEN_REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ObjectStoreError::Unavailable)?;
        Ok(Self {
            http,
            url,
            cached: Mutex::new(None),
        })
    }

    /// Returns a `Bearer` authorization header value.
    pub async fn authorization(&self) -> Result<HeaderValue, ObjectStoreError> {
        let mut cached = self.cached.lock().await;
        if let Some(token) = cached.as_ref() {
            if Instant::now() < token.refresh_at {
                return Ok(token.header.clone());
            }
        }
        let token = self.fetch().await?;
        let header = token.header.clone();
        *cached = Some(token);
        Ok(header)
    }

    /// Drops the cached token after storage rejects it.
    pub async fn invalidate(&self) {
        *self.cached.lock().await = None;
    }

    async fn fetch(&self) -> Result<CachedToken, ObjectStoreError> {
        let response = self
            .http
            .get(self.url.clone())
            .header("Metadata-Flavor", "Google")
            .send()
            .await
            .map_err(|_| ObjectStoreError::Unavailable)?;
        if !response.status().is_success() {
            eprintln!(
                "[object-storage] instance token request failed: {}",
                response.status()
            );
            return Err(ObjectStoreError::Unavailable);
        }
        let body: TokenResponse = response
            .json()
            .await
            .map_err(|_| ObjectStoreError::Unavailable)?;
        let token = body.access_token.trim();
        if token.is_empty() || token.bytes().any(|byte| byte.is_ascii_whitespace()) {
            return Err(ObjectStoreError::Unavailable);
        }
        let mut header = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| ObjectStoreError::Unavailable)?;
        header.set_sensitive(true);
        let lifetime = Duration::from_secs(body.expires_in);
        let usable = if lifetime > REFRESH_MARGIN * 2 {
            lifetime - REFRESH_MARGIN
        } else {
            lifetime / 2
        };
        Ok(CachedToken {
            header,
            refresh_at: Instant::now() + usable,
        })
    }
}
