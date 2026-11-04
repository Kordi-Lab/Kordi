//! Refreshes a browser sign-in session (RFC 6749 refresh token grant).
//!
//! Refresh tokens rotate on every use, and presenting a rotated token again
//! revokes the whole sign-in. Every window and background task of this app
//! shares one stored session, so refreshes run here under one process-wide
//! lock: a caller that still holds an older access token gets the session
//! another caller already refreshed instead of spending the refresh token
//! twice.

use serde::Deserialize;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::cloud_session::{cloud_session_load, store_session_entry, CloudSessionEntry};

static REFRESH_LOCK: Mutex<()> = Mutex::const_new(());
const REFRESH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: String,
}

#[derive(Deserialize)]
struct TokenError {
    error: Option<String>,
}

/// Returns the refreshed session. Errors are stable codes:
/// `not_signed_in`, `not_refreshable`, `invalid_grant` (sign in again),
/// `rate_limited`, `network_error`, `refresh_failed`.
#[tauri::command]
pub async fn cloud_session_refresh(previous_token: String) -> Result<CloudSessionEntry, String> {
    let _guard = REFRESH_LOCK.lock().await;
    let entry = cloud_session_load()?.ok_or_else(|| "not_signed_in".to_string())?;
    if entry.token != previous_token {
        // Another window or task refreshed while this caller waited.
        return Ok(entry);
    }
    let (Some(refresh_token), Some(client_id), Some(endpoint)) = (
        entry.refresh_token.clone(),
        entry.client_id.clone(),
        entry.token_endpoint.clone(),
    ) else {
        return Err("not_refreshable".to_string());
    };
    if !is_allowed_token_endpoint(&endpoint) {
        return Err("not_refreshable".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(REFRESH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "network_error".to_string())?;
    let response = client
        .post(&endpoint)
        .header("Accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "network_error".to_string())?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|_| "network_error".to_string())?;
    let next = refreshed_entry(&entry, status, &body, chrono::Utc::now())?;
    store_session_entry(&next)?;
    Ok(next)
}

pub(crate) fn refreshed_entry(
    entry: &CloudSessionEntry,
    status: u16,
    body: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<CloudSessionEntry, String> {
    if !(200..300).contains(&status) {
        let error = serde_json::from_slice::<TokenError>(body)
            .ok()
            .and_then(|parsed| parsed.error);
        return Err(match (status, error.as_deref()) {
            (400 | 401, Some("invalid_grant" | "invalid_client")) => "invalid_grant",
            (429, _) => "rate_limited",
            _ => "refresh_failed",
        }
        .to_string());
    }
    let parsed: TokenResponse =
        serde_json::from_slice(body).map_err(|_| "refresh_failed".to_string())?;
    if parsed.access_token.is_empty() || parsed.refresh_token.is_empty() || parsed.expires_in <= 0 {
        return Err("refresh_failed".to_string());
    }
    let expires_at = now + chrono::Duration::seconds(parsed.expires_in);
    Ok(CloudSessionEntry {
        token: parsed.access_token,
        expires_at: expires_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        refresh_token: Some(parsed.refresh_token),
        ..entry.clone()
    })
}

/// Refresh tokens go only to HTTPS, or to plain HTTP on loopback for local
/// development backends.
pub(crate) fn is_allowed_token_endpoint(endpoint: &str) -> bool {
    if !endpoint.ends_with("/v1/cloud/auth/app/token") {
        return false;
    }
    if let Some(rest) = endpoint.strip_prefix("https://") {
        return !rest.starts_with('/') && !rest.contains('@');
    }
    let Some(rest) = endpoint.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or_default();
    let host = match authority.find(']') {
        Some(end) if authority.starts_with('[') => &authority[..=end],
        _ => authority.split(':').next().unwrap_or_default(),
    };
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> CloudSessionEntry {
        CloudSessionEntry {
            token: "kordi_cs_old".into(),
            account_id: "acct_synthetic".into(),
            expires_at: "2026-01-01T00:00:00Z".into(),
            device_id: Some("dev_synthetic".into()),
            refresh_token: Some("kordi_rt_old".into()),
            client_id: Some("kordi-desktop".into()),
            token_endpoint: Some("https://app.example.test/v1/cloud/auth/app/token".into()),
        }
    }

    #[test]
    fn success_rotates_both_tokens_and_keeps_the_account() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let body = br#"{"access_token":"kordi_cs_new","token_type":"Bearer","expires_in":3600,"refresh_token":"kordi_rt_new"}"#;
        let next = refreshed_entry(&entry(), 200, body, now).unwrap();
        assert_eq!(next.token, "kordi_cs_new");
        assert_eq!(next.refresh_token.as_deref(), Some("kordi_rt_new"));
        assert_eq!(next.expires_at, "2026-01-01T01:00:00Z");
        assert_eq!(next.account_id, "acct_synthetic");
        assert_eq!(next.device_id.as_deref(), Some("dev_synthetic"));
        assert_eq!(next.client_id.as_deref(), Some("kordi-desktop"));
    }

    #[test]
    fn errors_map_to_stable_codes() {
        let now = chrono::Utc::now();
        let grant = br#"{"error":"invalid_grant","errorCode":"invalid_grant"}"#;
        assert_eq!(
            refreshed_entry(&entry(), 400, grant, now).unwrap_err(),
            "invalid_grant"
        );
        assert_eq!(
            refreshed_entry(&entry(), 429, b"{}", now).unwrap_err(),
            "rate_limited"
        );
        assert_eq!(
            refreshed_entry(&entry(), 502, b"", now).unwrap_err(),
            "refresh_failed"
        );
        let partial = br#"{"access_token":"kordi_cs_new","expires_in":3600}"#;
        assert_eq!(
            refreshed_entry(&entry(), 200, partial, now).unwrap_err(),
            "refresh_failed"
        );
    }

    #[test]
    fn refresh_tokens_go_only_to_https_or_loopback() {
        for allowed in [
            "https://app.example.test/v1/cloud/auth/app/token",
            "http://127.0.0.1:17301/v1/cloud/auth/app/token",
            "http://localhost:8080/v1/cloud/auth/app/token",
            "http://[::1]:8080/v1/cloud/auth/app/token",
        ] {
            assert!(is_allowed_token_endpoint(allowed), "{allowed}");
        }
        for refused in [
            "http://app.example.test/v1/cloud/auth/app/token",
            "http://127.0.0.1.example.test/v1/cloud/auth/app/token",
            "https://user@app.example.test/v1/cloud/auth/app/token",
            "https://app.example.test/v1/cloud/auth/login",
            "ftp://127.0.0.1/v1/cloud/auth/app/token",
        ] {
            assert!(!is_allowed_token_endpoint(refused), "{refused}");
        }
    }
}
