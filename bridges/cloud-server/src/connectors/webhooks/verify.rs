//! Signature and token checks for connector webhooks.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::connectors::ConnectorHooks;

type HmacSha256 = Hmac<Sha256>;

/// Slack requests older or newer than this are replays.
pub const SLACK_MAX_SKEW_SECONDS: i64 = 300;

fn hmac_matches(key: &str, parts: &[&[u8]], hex_signature: &str) -> bool {
    let Ok(expected) = hex::decode(hex_signature.trim()) else {
        return false;
    };
    let Ok(mut mac) = HmacSha256::new_from_slice(key.as_bytes()) else {
        return false;
    };
    for part in parts {
        mac.update(part);
    }
    mac.verify_slice(&expected).is_ok()
}

/// Hex HMAC-SHA256 of `parts` under `key`, for tests and senders.
pub fn sign_hex(key: &str, parts: &[&[u8]]) -> String {
    let mut mac = HmacSha256::new_from_slice(key.as_bytes()).expect("hmac accepts any key");
    for part in parts {
        mac.update(part);
    }
    hex::encode(mac.finalize().into_bytes())
}

/// Checks GitHub's `X-Hub-Signature-256: sha256=<hex>` over the raw body.
pub fn github_signature_valid(secret: &str, body: &[u8], header: Option<&str>) -> bool {
    header
        .and_then(|value| value.strip_prefix("sha256="))
        .is_some_and(|signature| hmac_matches(secret, &[body], signature))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlackSignatureError {
    Missing,
    Stale,
    Invalid,
}

/// Checks Slack's `X-Slack-Signature: v0=<hex>` over `v0:<timestamp>:<body>`
/// and rejects timestamps more than five minutes from `now`.
pub fn slack_signature_check(
    secret: &str,
    timestamp: Option<&str>,
    signature: Option<&str>,
    body: &[u8],
    now: DateTime<Utc>,
) -> Result<(), SlackSignatureError> {
    let (Some(timestamp), Some(signature)) = (timestamp, signature) else {
        return Err(SlackSignatureError::Missing);
    };
    let seconds = timestamp
        .trim()
        .parse::<i64>()
        .map_err(|_| SlackSignatureError::Invalid)?;
    if now.timestamp().abs_diff(seconds) > SLACK_MAX_SKEW_SECONDS.unsigned_abs() {
        return Err(SlackSignatureError::Stale);
    }
    let hex = signature
        .strip_prefix("v0=")
        .ok_or(SlackSignatureError::Invalid)?;
    let base = [b"v0:".as_slice(), timestamp.trim().as_bytes(), b":", body];
    if hmac_matches(secret, &base, hex) {
        Ok(())
    } else {
        Err(SlackSignatureError::Invalid)
    }
}

/// Checks the claims Google's token info endpoint returned for a Pub/Sub
/// push token: issuer, audience, signing service account, and expiry.
pub fn google_claims_valid(
    claims: &Value,
    audience: &str,
    service_account: &str,
    now: DateTime<Utc>,
) -> bool {
    let text = |key: &str| claims.get(key).and_then(Value::as_str);
    let verified = match claims.get("email_verified") {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => value == "true",
        _ => false,
    };
    let expires = match claims.get("exp") {
        Some(Value::String(value)) => value.parse::<i64>().ok(),
        Some(Value::Number(value)) => value.as_i64(),
        _ => None,
    };
    matches!(
        text("iss"),
        Some("accounts.google.com" | "https://accounts.google.com")
    ) && text("aud") == Some(audience)
        && text("email").is_some_and(|email| email.eq_ignore_ascii_case(service_account))
        && verified
        && expires.is_some_and(|exp| exp > now.timestamp())
}

fn tokeninfo_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_default()
    })
}

/// A rejected push token is not looked up again for this long.
const REJECTED_TOKEN_TTL: Duration = Duration::from_secs(60);
/// Rejected tokens remembered at once; past this, expired entries are
/// dropped and, if still full, the cache starts over.
const MAX_REJECTED_TOKENS: usize = 4096;

/// Hashes of push tokens Google's token info rejected recently, so a burst
/// of bad pushes does not become a burst of lookups.
#[derive(Default)]
pub struct RejectedTokens {
    entries: Mutex<HashMap<[u8; 32], Instant>>,
}

impl RejectedTokens {
    fn key(token: &str) -> [u8; 32] {
        Sha256::digest(token.as_bytes()).into()
    }

    pub fn is_rejected(&self, token: &str, now: Instant) -> bool {
        let entries = self.entries.lock().expect("rejected token cache poisoned");
        entries
            .get(&Self::key(token))
            .is_some_and(|until| *until > now)
    }

    pub fn reject(&self, token: &str, now: Instant) {
        let mut entries = self.entries.lock().expect("rejected token cache poisoned");
        if entries.len() >= MAX_REJECTED_TOKENS {
            entries.retain(|_, until| *until > now);
            if entries.len() >= MAX_REJECTED_TOKENS {
                entries.clear();
            }
        }
        entries.insert(Self::key(token), now + REJECTED_TOKEN_TTL);
    }
}

fn rejected_tokens() -> &'static RejectedTokens {
    static REJECTED: std::sync::OnceLock<RejectedTokens> = std::sync::OnceLock::new();
    REJECTED.get_or_init(RejectedTokens::default)
}

/// Verifies the Pub/Sub push OIDC bearer through Google's token info
/// endpoint. Fails closed when the audience or service account is unset.
/// A token that fails is remembered for a minute and refused without a
/// lookup.
pub async fn google_push_authorized(hooks: &ConnectorHooks, authorization: Option<&str>) -> bool {
    let (Some(audience), Some(service_account)) = (
        hooks.google_push_audience.as_deref(),
        hooks.google_push_service_account.as_deref(),
    ) else {
        return false;
    };
    let Some(token) = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| !token.is_empty() && token.len() <= 4096)
    else {
        return false;
    };
    let rejected = rejected_tokens();
    if rejected.is_rejected(token, Instant::now()) {
        return false;
    }
    match token_info_valid(hooks, token, audience, service_account).await {
        Some(true) => true,
        Some(false) => {
            rejected.reject(token, Instant::now());
            false
        }
        // Google could not be reached: refuse, but let a retry look again.
        None => false,
    }
}

/// `None` when the token info endpoint could not be reached.
async fn token_info_valid(
    hooks: &ConnectorHooks,
    token: &str,
    audience: &str,
    service_account: &str,
) -> Option<bool> {
    let response = tokeninfo_client()
        .get(&hooks.google_tokeninfo_url)
        .query(&[("id_token", token)])
        .send()
        .await
        .ok()?;
    if response.status().is_server_error() {
        return None;
    }
    if !response.status().is_success() {
        return Some(false);
    }
    Some(match response.json::<Value>().await {
        Ok(claims) => google_claims_valid(&claims, audience, service_account, Utc::now()),
        Err(_) => false,
    })
}
