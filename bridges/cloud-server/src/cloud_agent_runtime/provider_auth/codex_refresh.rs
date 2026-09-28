//! The Codex OAuth token refresh the server performs for saved ChatGPT
//! accounts. It never logs or returns the tokens it handles.

use chrono::Utc;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;

const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// Overrides the Codex token endpoint for operators and tests.
const CODEX_TOKEN_URL_ENV: &str = "KORDI_CODEX_OAUTH_TOKEN_URL";

pub(super) enum CodexRefreshError {
    /// The token endpoint refused the refresh token itself (for example
    /// `invalid_grant`), so only reconnecting the account can help.
    Rejected,
    /// Any other failure; the saved account stays as it was.
    Failed(sqlx_core::Error),
}

fn failed(message: &str) -> CodexRefreshError {
    CodexRefreshError::Failed(sqlx_core::Error::Protocol(message.to_string()))
}

pub(super) fn codex_payload_needs_refresh(payload: &Value) -> bool {
    if payload.get("apiMode").and_then(Value::as_str) != Some("openai-codex-oauth")
        || payload
            .get("refreshToken")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return false;
    }
    let expires_at = payload.get("expiresAtMs").and_then(|value| {
        value
            .as_str()
            .and_then(|text| text.parse::<i64>().ok())
            .or_else(|| value.as_i64())
    });
    expires_at.is_some_and(|expires_at| expires_at <= Utc::now().timestamp_millis() + 300_000)
}

#[derive(Deserialize)]
struct CodexRefreshResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    expires_in: i64,
}

/// Whether a token endpoint status means the refresh token itself was
/// refused. Rate limits, timeouts, and server errors are transient.
fn refresh_token_rejected(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    )
}

pub(super) async fn refresh_codex_payload(payload: &mut Value) -> Result<(), CodexRefreshError> {
    let refresh_token = payload
        .get("refreshToken")
        .and_then(Value::as_str)
        .ok_or_else(|| failed("Codex refresh token is unavailable"))?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| failed("Could not initialize Codex refresh"))?;
    let response = client
        .post(codex_token_url().map_err(CodexRefreshError::Failed)?)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", CODEX_OAUTH_CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|_| failed("Codex token refresh failed"))?;
    if refresh_token_rejected(response.status()) {
        return Err(CodexRefreshError::Rejected);
    }
    if !response.status().is_success() {
        return Err(CodexRefreshError::Failed(sqlx_core::Error::Protocol(
            format!(
                "Codex token refresh failed with status {}",
                response.status()
            ),
        )));
    }
    let token: CodexRefreshResponse = response
        .json()
        .await
        .map_err(|_| failed("Invalid Codex token refresh response"))?;
    if token.access_token.is_empty() {
        return Err(failed("Codex token refresh returned no access token"));
    }
    let object = payload
        .as_object_mut()
        .ok_or_else(|| failed("Invalid Codex credential payload"))?;
    object.insert("accessToken".to_string(), Value::String(token.access_token));
    if !token.refresh_token.is_empty() {
        object.insert(
            "refreshToken".to_string(),
            Value::String(token.refresh_token),
        );
    }
    object.insert(
        "expiresAtMs".to_string(),
        Value::String(
            (Utc::now().timestamp_millis() + token.expires_in.max(0) * 1_000).to_string(),
        ),
    );
    Ok(())
}

/// The Codex token endpoint. An override must use HTTPS, or plain HTTP on a
/// loopback host, because the request carries the refresh token.
fn codex_token_url() -> Result<String, sqlx_core::Error> {
    let Some(value) = std::env::var(CODEX_TOKEN_URL_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(CODEX_TOKEN_URL.to_string());
    };
    let allowed = reqwest::Url::parse(&value).is_ok_and(|url| {
        url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
    });
    if allowed {
        Ok(value)
    } else {
        Err(sqlx_core::Error::Protocol(
            "The Codex token endpoint override is not allowed".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_refresh_is_scoped_to_expiring_oauth_material() {
        let soon = Utc::now().timestamp_millis() + 60_000;
        assert!(codex_payload_needs_refresh(&serde_json::json!({
            "apiMode": "openai-codex-oauth",
            "accessToken": "synthetic-access",
            "refreshToken": "synthetic-refresh",
            "expiresAtMs": soon.to_string(),
        })));
        assert!(!codex_payload_needs_refresh(&serde_json::json!({
            "apiMode": "openai-codex-oauth",
            "refreshToken": "synthetic-refresh",
            "expiresAtMs": soon + 3_600_000,
        })));
        assert!(!codex_payload_needs_refresh(&serde_json::json!({
            "apiMode": "openai-codex-oauth",
            "expiresAtMs": soon,
        })));
        assert!(!codex_payload_needs_refresh(&serde_json::json!({
            "apiMode": "anthropic-oauth",
            "refreshToken": "synthetic-refresh",
            "expiresAtMs": soon,
        })));
    }

    #[test]
    fn only_a_refused_refresh_token_needs_reconnecting() {
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
        ] {
            assert!(refresh_token_rejected(status), "{status}");
        }
        for status in [
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            assert!(!refresh_token_rejected(status), "{status}");
        }
    }
}
