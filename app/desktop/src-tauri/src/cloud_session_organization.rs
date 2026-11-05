//! Switches the stored session's access token to another organization
//! (`POST /v1/cloud/auth/organization-token`) and tags native requests with
//! the organization of the token they carry.
//!
//! A switch never changes the account, the sign-in or the refresh token. It
//! runs under the refresh lock, so it never races a refresh in this process,
//! and its write is a compare-and-swap under the session write lock: the new
//! token is stored only while the stored session is still the one the switch
//! started from (same account and refresh token, or for an older token-only
//! session the same token). A sign-in, sign-out or refresh that landed in
//! between is kept, and the switch reports `session_changed` or
//! `not_signed_in` so the caller can retry with the current token.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

use crate::cloud_session::{cloud_session_load, store_session_entry, CloudSessionEntry};
use crate::cloud_session_refresh::{
    is_allowed_token_endpoint, is_https_or_loopback, load_stored_session, lock_session_writes,
    REFRESH_LOCK,
};

pub(crate) const ORGANIZATION_HEADER: &str = "Kordi-Organization";
const ORGANIZATION_TOKEN_PATH: &str = "/v1/cloud/auth/organization-token";
const TOKEN_ENDPOINT_PATH: &str = "/v1/cloud/auth/app/token";
const SWITCH_TIMEOUT: Duration = Duration::from_secs(20);
/// Earlier tokens keep their own organization until they expire.
const REMEMBERED_TOKENS: usize = 4;

static TOKEN_ORGANIZATIONS: std::sync::Mutex<Vec<(String, String)>> =
    std::sync::Mutex::new(Vec::new());

#[derive(Deserialize)]
struct OrganizationTokenResponse {
    access_token: Option<String>,
    expires_in: Option<i64>,
    account_id: Option<String>,
    device_id: Option<String>,
    organization_id: Option<String>,
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(rename = "errorCode")]
    error_code: Option<String>,
}

/// Returns the switched session. Errors are stable codes: `not_signed_in`,
/// `session_changed` (retry with the current token), `organization_not_found`,
/// `account_mismatch`, `unsupported` (the server has no switch endpoint),
/// `unauthorized`, `rate_limited`, `network_error`, `switch_failed`.
#[tauri::command]
pub async fn cloud_session_switch_organization(
    previous_token: String,
    organization_id: String,
) -> Result<CloudSessionEntry, String> {
    let organization_id = organization_id.trim().to_string();
    if organization_id.is_empty() {
        return Err("organization_not_found".to_string());
    }
    let _guard = REFRESH_LOCK.lock().await;
    let entry = load_stored_session()
        .await?
        .ok_or_else(|| "not_signed_in".to_string())?;
    if entry.token != previous_token {
        // Another window or task switched or refreshed while this caller waited.
        return if entry.organization_id.as_deref() == Some(organization_id.as_str()) {
            Ok(entry)
        } else {
            Err("session_changed".to_string())
        };
    }
    let endpoint =
        organization_token_endpoint(&entry).ok_or_else(|| "switch_failed".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(SWITCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "network_error".to_string())?;
    let response = client
        .post(&endpoint)
        .bearer_auth(&entry.token)
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "organization_id": organization_id }))
        .send()
        .await
        .map_err(|_| "network_error".to_string())?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|_| "network_error".to_string())?;
    let next = switched_entry(&entry, &organization_id, status, &body, chrono::Utc::now())?;
    tokio::task::spawn_blocking(move || store_switched_session(&entry, &next))
        .await
        .map_err(|_| "switch_failed".to_string())?
}

/// The switch endpoint on the server that issued the session.
fn organization_token_endpoint(entry: &CloudSessionEntry) -> Option<String> {
    let base = match entry.token_endpoint.as_deref() {
        Some(endpoint) if is_allowed_token_endpoint(endpoint) => {
            endpoint.strip_suffix(TOKEN_ENDPOINT_PATH)?.to_string()
        }
        Some(_) => return None,
        None => crate::cloud_api_base_url_from_env().ok()?,
    };
    let endpoint = format!(
        "{}{ORGANIZATION_TOKEN_PATH}",
        base.trim().trim_end_matches('/')
    );
    is_https_or_loopback(&endpoint).then_some(endpoint)
}

/// The session after a switch response, or a stable error code. The response
/// must name the account (and device) the switch started from.
pub(crate) fn switched_entry(
    start: &CloudSessionEntry,
    organization_id: &str,
    status: u16,
    body: &[u8],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<CloudSessionEntry, String> {
    if !(200..300).contains(&status) {
        let error_code = serde_json::from_slice::<ErrorBody>(body)
            .ok()
            .and_then(|parsed| parsed.error_code);
        return Err(match (status, error_code.as_deref()) {
            (404, Some("organization_not_found")) => "organization_not_found",
            (404 | 405, _) => "unsupported",
            (401, _) => "unauthorized",
            (429, _) => "rate_limited",
            _ => "switch_failed",
        }
        .to_string());
    }
    let parsed: OrganizationTokenResponse =
        serde_json::from_slice(body).map_err(|_| "switch_failed".to_string())?;
    if parsed.account_id.as_deref() != Some(start.account_id.as_str()) {
        return Err("account_mismatch".to_string());
    }
    if let (Some(started), Some(returned)) =
        (start.device_id.as_deref(), parsed.device_id.as_deref())
    {
        if started != returned {
            return Err("account_mismatch".to_string());
        }
    }
    if parsed.organization_id.as_deref() != Some(organization_id) {
        return Err("switch_failed".to_string());
    }
    let token = parsed
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| "switch_failed".to_string())?;
    let expires_at = match parsed.expires_in {
        Some(seconds) if seconds > 0 => (now + chrono::Duration::seconds(seconds))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        _ => start.expires_at.clone(),
    };
    Ok(CloudSessionEntry {
        token,
        expires_at,
        organization_id: Some(organization_id.to_string()),
        ..start.clone()
    })
}

/// Whether `current` is still the session a switch started from.
fn is_same_session(current: &CloudSessionEntry, start: &CloudSessionEntry) -> bool {
    current.account_id == start.account_id
        && match start.refresh_token.as_deref() {
            Some(refresh_token) => current.refresh_token.as_deref() == Some(refresh_token),
            None => current.refresh_token.is_none() && current.token == start.token,
        }
}

/// Stores `next` only while the stored session is still `start`.
pub(crate) fn store_switched_session(
    start: &CloudSessionEntry,
    next: &CloudSessionEntry,
) -> Result<CloudSessionEntry, String> {
    let _writes = lock_session_writes();
    match cloud_session_load()? {
        None => Err("not_signed_in".to_string()),
        Some(current) if is_same_session(&current, start) => {
            store_session_entry(next)?;
            Ok(next.clone())
        }
        Some(_) => Err("session_changed".to_string()),
    }
}

fn token_digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Records the organization of a stored or loaded session's access token.
pub(crate) fn remember_token_organization(entry: &CloudSessionEntry) {
    let Some(organization_id) = entry
        .organization_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let digest = token_digest(&entry.token);
    let mut remembered = TOKEN_ORGANIZATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    remembered.retain(|(token, _)| token != &digest);
    remembered.push((digest, organization_id.to_string()));
    let excess = remembered.len().saturating_sub(REMEMBERED_TOKENS);
    remembered.drain(..excess);
}

/// The organization a token acts in, when a stored session recorded it.
pub(crate) fn token_organization(token: &str) -> Option<String> {
    let digest = token_digest(token);
    TOKEN_ORGANIZATIONS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .rev()
        .find(|(token, _)| token == &digest)
        .map(|(_, organization_id)| organization_id.clone())
}

/// Bearer authentication for Kordi Cloud requests: also names the token's
/// organization when it is known, as the server expects on every request.
pub(crate) trait CloudBearerAuth {
    fn cloud_bearer_auth<T: AsRef<str>>(self, token: T) -> Self;
}

impl CloudBearerAuth for reqwest::RequestBuilder {
    fn cloud_bearer_auth<T: AsRef<str>>(self, token: T) -> Self {
        let token = token.as_ref();
        let request = self.bearer_auth(token);
        match token_organization(token) {
            Some(organization_id) => request.header(ORGANIZATION_HEADER, organization_id),
            None => request,
        }
    }
}

impl CloudBearerAuth for reqwest::blocking::RequestBuilder {
    fn cloud_bearer_auth<T: AsRef<str>>(self, token: T) -> Self {
        let token = token.as_ref();
        let request = self.bearer_auth(token);
        match token_organization(token) {
            Some(organization_id) => request.header(ORGANIZATION_HEADER, organization_id),
            None => request,
        }
    }
}

#[cfg(test)]
mod tests;
