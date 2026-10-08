//! Signature and token checks for connector webhooks.

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

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
    if (now.timestamp() - seconds).abs() > SLACK_MAX_SKEW_SECONDS {
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

/// Verifies the Pub/Sub push OIDC bearer through Google's token info
/// endpoint. Fails closed when the audience or service account is unset.
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
    let response = tokeninfo_client()
        .get(&hooks.google_tokeninfo_url)
        .query(&[("id_token", token)])
        .send()
        .await;
    let Ok(response) = response else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    match response.json::<Value>().await {
        Ok(claims) => google_claims_valid(&claims, audience, service_account, Utc::now()),
        Err(_) => false,
    }
}
