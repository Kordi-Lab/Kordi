//! The workload identity token sent to the control plane, and the metadata
//! server access token used for Google APIs. Tokens are cached in memory and
//! never logged.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;

use super::PoolWorkerError;

/// Identity tokens are refreshed this long before they expire.
const IDENTITY_REFRESH_MARGIN: Duration = Duration::from_secs(300);
/// How long an identity token without a readable `exp` is reused.
const IDENTITY_FALLBACK_TTL: Duration = Duration::from_secs(300);
/// Access tokens are refreshed this long before they expire.
const ACCESS_REFRESH_MARGIN: Duration = Duration::from_secs(60);

type Cached = Mutex<Option<(String, Instant)>>;

fn cached(cache: &Cached) -> Option<String> {
    let guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .as_ref()
        .filter(|(_, until)| Instant::now() < *until)
        .map(|(value, _)| value.clone())
}

fn store(cache: &Cached, value: &str, ttl: Duration) {
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    *guard = (!ttl.is_zero()).then(|| (value.to_string(), Instant::now() + ttl));
}

fn metadata_get(http: &reqwest::Client, url: reqwest::Url) -> reqwest::RequestBuilder {
    http.get(url).header("Metadata-Flavor", "Google")
}

fn metadata_url(base: &str, path: &str) -> Result<reqwest::Url, PoolWorkerError> {
    reqwest::Url::parse(&format!("{}{path}", base.trim_end_matches('/')))
        .map_err(|_| PoolWorkerError::Credential("invalid metadata server URL".into()))
}

pub(super) async fn checked_text(
    response: Result<reqwest::Response, reqwest::Error>,
    what: &str,
) -> Result<String, PoolWorkerError> {
    let response =
        response.map_err(|_| PoolWorkerError::Credential(format!("{what} request failed")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(PoolWorkerError::Credential(format!(
            "{what} returned {status}"
        )));
    }
    response
        .text()
        .await
        .map_err(|_| PoolWorkerError::Credential(format!("{what} response was unreadable")))
}

/// Seconds until the JWT's `exp`, read without verifying the signature.
pub(crate) fn jwt_seconds_left(token: &str, now_unix: i64) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    Some(claims.get("exp")?.as_i64()? - now_unix)
}

/// How long to reuse an identity token.
pub(crate) fn identity_ttl(token: &str, now_unix: i64) -> Duration {
    match jwt_seconds_left(token, now_unix) {
        Some(left) => {
            Duration::from_secs(left.max(0) as u64).saturating_sub(IDENTITY_REFRESH_MARGIN)
        }
        None => IDENTITY_FALLBACK_TTL,
    }
}

pub(crate) enum IdentityTokenSource {
    /// A projected token file, re-read on every request.
    File(PathBuf),
    Metadata {
        http: reqwest::Client,
        base: String,
        audience: String,
        cache: Cached,
    },
}

impl IdentityTokenSource {
    pub(crate) fn metadata(http: reqwest::Client, base: &str, audience: &str) -> Self {
        Self::Metadata {
            http,
            base: base.to_string(),
            audience: audience.to_string(),
            cache: Mutex::new(None),
        }
    }

    pub(crate) async fn token(&self) -> Result<String, PoolWorkerError> {
        match self {
            Self::File(path) => {
                let token = tokio::fs::read_to_string(path).await.map_err(|_| {
                    PoolWorkerError::Credential("identity token file is unreadable".into())
                })?;
                non_empty(token.trim(), "identity token file")
            }
            Self::Metadata {
                http,
                base,
                audience,
                cache,
            } => {
                if let Some(token) = cached(cache) {
                    return Ok(token);
                }
                let mut url = metadata_url(
                    base,
                    "/computeMetadata/v1/instance/service-accounts/default/identity",
                )?;
                url.query_pairs_mut()
                    .append_pair("audience", audience)
                    .append_pair("format", "full");
                let text =
                    checked_text(metadata_get(http, url).send().await, "identity token").await?;
                let token = non_empty(text.trim(), "identity token")?;
                store(
                    cache,
                    &token,
                    identity_ttl(&token, chrono::Utc::now().timestamp()),
                );
                Ok(token)
            }
        }
    }
}

fn non_empty(value: &str, what: &str) -> Result<String, PoolWorkerError> {
    if value.is_empty() {
        return Err(PoolWorkerError::Credential(format!("{what} is empty")));
    }
    Ok(value.to_string())
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: u64,
}

/// The worker service account's OAuth access token from the metadata server.
pub(crate) struct AccessTokenSource {
    http: reqwest::Client,
    base: String,
    cache: Cached,
}

impl AccessTokenSource {
    pub(crate) fn new(http: reqwest::Client, base: &str) -> Self {
        Self {
            http,
            base: base.to_string(),
            cache: Mutex::new(None),
        }
    }

    pub(crate) async fn token(&self) -> Result<String, PoolWorkerError> {
        if let Some(token) = cached(&self.cache) {
            return Ok(token);
        }
        let url = metadata_url(
            &self.base,
            "/computeMetadata/v1/instance/service-accounts/default/token",
        )?;
        let text = checked_text(metadata_get(&self.http, url).send().await, "access token").await?;
        let parsed: AccessTokenResponse = serde_json::from_str(&text)
            .map_err(|_| PoolWorkerError::Credential("access token response is invalid".into()))?;
        let token = non_empty(parsed.access_token.trim(), "access token")?;
        let ttl = Duration::from_secs(parsed.expires_in).saturating_sub(ACCESS_REFRESH_MARGIN);
        store(&self.cache, &token, ttl);
        Ok(token)
    }
}
