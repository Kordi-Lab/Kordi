//! Signing keys of worker identity issuers.
//!
//! Keys come from the identity's inline `jwks`, its `jwksUri`, or the
//! `jwks_uri` of the issuer's OpenID configuration. Fetched key sets are
//! cached for an hour; a token signed by a key the cache does not know
//! refetches at most once a minute, so rotated keys are picked up quickly and
//! forged key ids cannot make the server fetch on every request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::token::KeySet;
use crate::resource_pools::WorkerIdentity;

const CACHE_FOR: Duration = Duration::from_secs(60 * 60);
const REFETCH_AFTER: Duration = Duration::from_secs(60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    /// The issuer's configuration or key set could not be fetched or read.
    Unavailable,
}

struct Entry {
    keys: Arc<KeySet>,
    fetched_at: Instant,
}

/// Fetched key sets by URL.
pub struct KeyCache {
    client: reqwest::Client,
    entries: Mutex<HashMap<String, Entry>>,
}

impl KeyCache {
    fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(FETCH_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// The process-wide cache.
    pub fn shared() -> &'static Self {
        static CACHE: OnceLock<KeyCache> = OnceLock::new();
        CACHE.get_or_init(Self::new)
    }

    /// The keys for `identity`. With `refresh`, a cached key set older than
    /// a minute is fetched again.
    pub async fn keys(
        &self,
        identity: &WorkerIdentity,
        refresh: bool,
    ) -> Result<Arc<KeySet>, KeyError> {
        if let Some(inline) = &identity.jwks {
            return Ok(Arc::new(KeySet::from_jwks(inline)));
        }
        let cache_key = identity
            .jwks_uri
            .clone()
            .unwrap_or_else(|| format!("issuer:{}", identity.issuer));
        if let Some(keys) = self.cached(&cache_key, refresh) {
            return Ok(keys);
        }
        let uri = match &identity.jwks_uri {
            Some(uri) => uri.clone(),
            None => self.discover(&identity.issuer).await?,
        };
        let keys = Arc::new(KeySet::from_jwks(&self.fetch_json(&uri).await?));
        if keys.is_empty() {
            return Err(KeyError::Unavailable);
        }
        self.lock().insert(
            cache_key,
            Entry {
                keys: keys.clone(),
                fetched_at: Instant::now(),
            },
        );
        Ok(keys)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn cached(&self, key: &str, refresh: bool) -> Option<Arc<KeySet>> {
        let entries = self.lock();
        let entry = entries.get(key)?;
        let age = entry.fetched_at.elapsed();
        let fresh = age < CACHE_FOR && !(refresh && age >= REFETCH_AFTER);
        fresh.then(|| entry.keys.clone())
    }

    async fn discover(&self, issuer: &str) -> Result<String, KeyError> {
        let url = format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        );
        let configuration = self.fetch_json(&url).await?;
        let uri = configuration["jwks_uri"]
            .as_str()
            .ok_or(KeyError::Unavailable)?;
        let https = url::Url::parse(uri).is_ok_and(|url| url.scheme() == "https");
        if !https {
            return Err(KeyError::Unavailable);
        }
        Ok(uri.to_string())
    }

    async fn fetch_json(&self, url: &str) -> Result<Value, KeyError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| KeyError::Unavailable)?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(KeyError::Unavailable);
        }
        let body = response.bytes().await.map_err(|_| KeyError::Unavailable)?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err(KeyError::Unavailable);
        }
        serde_json::from_slice(&body).map_err(|_| KeyError::Unavailable)
    }
}
