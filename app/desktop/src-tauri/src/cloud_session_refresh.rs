//! Refreshes a browser sign-in session (RFC 6749 refresh token grant).
//!
//! Refresh tokens rotate on every use, and presenting a rotated token again
//! revokes the whole sign-in. Every window and background task of this app
//! shares one stored session, so refreshes run here under one process-wide
//! lock: a caller that still holds an older access token gets the session
//! another caller already refreshed instead of spending the refresh token
//! twice.
//!
//! The lock spans the network call, so the write at the end is a
//! compare-and-swap under the session write lock that sign-in and sign-out
//! also take: a session that was cleared or replaced while the request was in
//! flight is never overwritten with the refreshed one.
//!
//! Browser sign-in access tokens expire after an hour and do not slide, so
//! native callers resolve the token through [`load_fresh_session`] rather
//! than keeping a copy, and refresh one that has expired or is about to (for
//! example after the Mac wakes from sleep).

use serde::Deserialize;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::cloud_session::{cloud_session_load, store_session_entry, CloudSessionEntry};

static REFRESH_LOCK: Mutex<()> = Mutex::const_new(());
const REFRESH_TIMEOUT: Duration = Duration::from_secs(20);
/// Native callers refresh an access token this close to its expiry, so a
/// token they read stays valid for the request or turn that uses it.
const NATIVE_REFRESH_MARGIN_SECS: i64 = 5 * 60;

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
    let entry = load_stored_session()
        .await?
        .ok_or_else(|| "not_signed_in".to_string())?;
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
    let stored = next.clone();
    tokio::task::spawn_blocking(move || store_session_if_unchanged(&entry, &stored))
        .await
        .map_err(|_| "refresh_failed".to_string())??
        .ok_or_else(|| "not_signed_in".to_string())
}

/// Held for every read-modify-write of the stored session: sign-in,
/// sign-out and the end of a token refresh. Never held across a network call.
static SESSION_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn lock_session_writes() -> std::sync::MutexGuard<'static, ()> {
    SESSION_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Stores `next` only while the stored session is still `previous` (same
/// access token and account). Returns the session that is stored afterwards:
/// `next`, a newer session that replaced `previous`, or `None` after sign-out.
pub(crate) fn store_session_if_unchanged(
    previous: &CloudSessionEntry,
    next: &CloudSessionEntry,
) -> Result<Option<CloudSessionEntry>, String> {
    let _writes = lock_session_writes();
    match cloud_session_load()? {
        Some(current)
            if current.token == previous.token && current.account_id == previous.account_id =>
        {
            store_session_entry(next)?;
            Ok(Some(next.clone()))
        }
        other => Ok(other),
    }
}

async fn load_stored_session() -> Result<Option<CloudSessionEntry>, String> {
    tokio::task::spawn_blocking(cloud_session_load)
        .await
        .map_err(|error| error.to_string())?
}

/// Whether a native caller should refresh `entry` before using its token:
/// only browser sign-in sessions refresh, once they are within the margin of
/// their expiry. Legacy sliding sessions and unreadable expiries never do.
pub(crate) fn needs_refresh(entry: &CloudSessionEntry, now: chrono::DateTime<chrono::Utc>) -> bool {
    if entry.refresh_token.is_none() || entry.client_id.is_none() || entry.token_endpoint.is_none()
    {
        return false;
    }
    chrono::DateTime::parse_from_rfc3339(&entry.expires_at).is_ok_and(|expires_at| {
        expires_at.with_timezone(&chrono::Utc) - now
            <= chrono::Duration::seconds(NATIVE_REFRESH_MARGIN_SECS)
    })
}

/// The stored session for a native caller, refreshed first when its access
/// token has expired or is about to. A failed refresh returns the stored
/// session, so the request fails the way it did before and the web view's
/// session handling decides whether to sign out.
pub(crate) async fn load_fresh_session() -> Result<Option<CloudSessionEntry>, String> {
    let Some(entry) = load_stored_session().await? else {
        return Ok(None);
    };
    if !needs_refresh(&entry, chrono::Utc::now()) {
        return Ok(Some(entry));
    }
    match cloud_session_refresh(entry.token.clone()).await {
        Ok(next) => Ok(Some(next)),
        Err(code) => {
            eprintln!("[kordi] Cloud session refresh failed: {code}");
            Ok(Some(entry))
        }
    }
}

/// A current access token for `account_id`, or `None` when signed out or
/// signed in to another account.
pub(crate) async fn fresh_token_for(account_id: &str) -> Option<String> {
    load_fresh_session()
        .await
        .ok()
        .flatten()
        .filter(|session| session.account_id == account_id && !session.token.trim().is_empty())
        .map(|session| session.token)
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
    fn native_callers_refresh_only_browser_sessions_near_expiry() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let at = |expires_at: &str| CloudSessionEntry {
            expires_at: expires_at.into(),
            ..entry()
        };
        assert!(!needs_refresh(&at("2026-01-01T00:30:00Z"), now));
        assert!(needs_refresh(&at("2026-01-01T00:04:00Z"), now));
        // Expired while the Mac slept.
        assert!(needs_refresh(&at("2025-12-31T20:00:00Z"), now));
        assert!(!needs_refresh(&at("not a date"), now));
        let legacy = CloudSessionEntry {
            refresh_token: None,
            ..at("2025-12-31T20:00:00Z")
        };
        assert!(!needs_refresh(&legacy, now));
    }

    fn with_isolated_store(test: impl FnOnce()) {
        let _guard = crate::test_support::lock_process_environment();
        let previous = std::env::var_os("APP_DATA_DIR");
        let dir = std::env::temp_dir().join(format!("kordi-refresh-test-{}", uuid::Uuid::new_v4()));
        std::env::set_var("APP_DATA_DIR", &dir);
        test();
        let _ = std::fs::remove_dir_all(&dir);
        match previous {
            Some(value) => std::env::set_var("APP_DATA_DIR", value),
            None => std::env::remove_var("APP_DATA_DIR"),
        }
    }

    #[test]
    fn a_refresh_never_overwrites_a_sign_out_or_another_account() {
        with_isolated_store(|| {
            let previous = entry();
            let next = CloudSessionEntry {
                token: "kordi_cs_new".into(),
                ..entry()
            };
            store_session_entry(&previous).unwrap();
            let stored = store_session_if_unchanged(&previous, &next).unwrap();
            assert_eq!(stored.unwrap().token, "kordi_cs_new");

            // Another account signed in while the request was in flight.
            let other = CloudSessionEntry {
                token: "kordi_cs_other".into(),
                account_id: "acct_other".into(),
                ..entry()
            };
            store_session_entry(&other).unwrap();
            let stored = store_session_if_unchanged(&next, &previous).unwrap();
            assert_eq!(stored.unwrap().account_id, "acct_other");
            let loaded = cloud_session_load().unwrap().unwrap();
            assert_eq!(loaded.token, "kordi_cs_other");

            // Signed out while the request was in flight.
            crate::cloud_session::cloud_session_clear().unwrap();
            assert!(store_session_if_unchanged(&other, &next).unwrap().is_none());
            assert!(cloud_session_load().unwrap().is_none());
        });
    }

    #[test]
    fn an_unrefreshable_session_is_returned_as_stored() {
        with_isolated_store(|| {
            let legacy = CloudSessionEntry {
                refresh_token: None,
                expires_at: "2000-01-01T00:00:00Z".into(),
                ..entry()
            };
            store_session_entry(&legacy).unwrap();
            let token = tauri::async_runtime::block_on(fresh_token_for("acct_synthetic"));
            assert_eq!(token.as_deref(), Some("kordi_cs_old"));
            let other = tauri::async_runtime::block_on(fresh_token_for("acct_other"));
            assert!(other.is_none());
            crate::cloud_session::cloud_session_clear().unwrap();
        });
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
