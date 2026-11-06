//! Signing keys of worker identity issuers.
//!
//! Keys come from the identity's inline `jwks`, its `jwksUri`, or the
//! `jwks_uri` of the issuer's OpenID configuration. Fetched key sets are
//! cached for an hour; a token signed by a key the cache does not know
//! refetches at most once a minute, so rotated keys are picked up quickly and
//! forged key ids cannot make the server fetch on every request. A failed
//! fetch is remembered for half a minute, and only one fetch per key set runs
//! at a time, so an issuer outage does not turn every request into a fetch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::token::KeySet;
use crate::resource_pools::WorkerIdentity;

const CACHE_FOR: Duration = Duration::from_secs(60 * 60);
const REFETCH_AFTER: Duration = Duration::from_secs(60);
const FAILURE_CACHE_FOR: Duration = Duration::from_secs(30);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    /// The issuer's configuration or key set could not be fetched or read.
    Unavailable,
}

struct Entry {
    /// `None` after a failed fetch.
    keys: Option<Arc<KeySet>>,
    fetched_at: Instant,
}

/// How long fetched keys and failures are kept.
#[derive(Debug, Clone, Copy)]
pub struct Timing {
    pub cache_for: Duration,
    pub refetch_after: Duration,
    pub failure_cache_for: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            cache_for: CACHE_FOR,
            refetch_after: REFETCH_AFTER,
            failure_cache_for: FAILURE_CACHE_FOR,
        }
    }
}

/// Fetched key sets by URL.
pub struct KeyCache {
    client: reqwest::Client,
    timing: Timing,
    entries: Mutex<HashMap<String, Entry>>,
    /// Held while fetching, so concurrent misses wait for one fetch.
    fetching: tokio::sync::Mutex<()>,
}

impl KeyCache {
    pub fn new(timing: Timing) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(FETCH_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            timing,
            entries: Mutex::new(HashMap::new()),
            fetching: tokio::sync::Mutex::new(()),
        }
    }

    /// The process-wide cache.
    pub fn shared() -> &'static Self {
        static CACHE: OnceLock<KeyCache> = OnceLock::new();
        CACHE.get_or_init(|| Self::new(Timing::default()))
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
        self.cached_or_fetch(cache_key, refresh, || async {
            let uri = match &identity.jwks_uri {
                Some(uri) => uri.clone(),
                None => self.discover(&identity.issuer).await?,
            };
            self.fetch_key_set(&uri).await
        })
        .await
    }

    /// The key set published at the fixed `https` URL `uri`, cached like
    /// [`Self::keys`].
    pub async fn keys_at(&self, uri: &str, refresh: bool) -> Result<Arc<KeySet>, KeyError> {
        self.cached_or_fetch(uri.to_string(), refresh, || self.fetch_key_set(uri))
            .await
    }

    async fn cached_or_fetch<F, Fut>(
        &self,
        cache_key: String,
        refresh: bool,
        fetch: F,
    ) -> Result<Arc<KeySet>, KeyError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Arc<KeySet>, KeyError>>,
    {
        if let Some(cached) = self.cached(&cache_key, refresh) {
            return cached;
        }
        let _fetching = self.fetching.lock().await;
        // Another request may have fetched while this one waited.
        if let Some(cached) = self.cached(&cache_key, refresh) {
            return cached;
        }
        let fetched = fetch().await;
        self.lock().insert(
            cache_key,
            Entry {
                keys: fetched.as_ref().ok().cloned(),
                fetched_at: Instant::now(),
            },
        );
        fetched
    }

    async fn fetch_key_set(&self, uri: &str) -> Result<Arc<KeySet>, KeyError> {
        let keys = Arc::new(KeySet::from_jwks(&self.fetch_json(uri).await?));
        if keys.is_empty() {
            return Err(KeyError::Unavailable);
        }
        Ok(keys)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A cached answer still in date: keys, or a recent failure.
    fn cached(&self, key: &str, refresh: bool) -> Option<Result<Arc<KeySet>, KeyError>> {
        let entries = self.lock();
        let entry = entries.get(key)?;
        let age = entry.fetched_at.elapsed();
        let timing = self.timing;
        match &entry.keys {
            Some(keys) => {
                let fresh = age < timing.cache_for && !(refresh && age >= timing.refetch_after);
                fresh.then(|| Ok(keys.clone()))
            }
            None => (age < timing.failure_cache_for).then_some(Err(KeyError::Unavailable)),
        }
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

#[cfg(test)]
#[path = "keys_tests.rs"]
mod tests;
