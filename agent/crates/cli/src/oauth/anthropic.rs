use anyhow::{Context, Result};
use kordi_provider::{
    ProviderError, ProviderErrorFormat, unexpected_response_with_sensitive_values,
};
use serde::Deserialize;

use super::callback_server::{CallbackParams, CallbackServerParts, start_callback_server};
use super::pkce::generate_pkce;
use super::{OAuthCallbacks, OAuthCredentials};

// ── Constants ────────────────────────────────────────────────────────

const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI: &str = "http://localhost:53692/callback";
const CALLBACK_PORT: u16 = 53692;
const CALLBACK_PATH: &str = "/callback";
const SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_CODE_USER_AGENT: &str = "claude-cli/2.1.75";
const TOKEN_EXPIRY_SAFETY_MS: i64 = 5 * 60 * 1000;

// ── Token response ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_in: i64,
}

// ── Public API ──────────────────────────────────────────────────────

/// Run the full Anthropic OAuth authorization-code + PKCE flow.
///
/// The caller provides `OAuthCallbacks` so this function stays UI-agnostic.
pub async fn login_anthropic(callbacks: OAuthCallbacks) -> Result<OAuthCredentials> {
    let (verifier, challenge) = generate_pkce();

    // Reuse the PKCE verifier as the state parameter for Anthropic.
    let state = verifier.clone();

    // Build the OAuth authorization URL.
    let auth_url = format!(
        "{AUTHORIZE_URL}?\
         code=true\
         &client_id={CLIENT_ID}\
         &response_type=code\
         &redirect_uri={redirect}\
         &scope={scopes}\
         &code_challenge={challenge}\
         &code_challenge_method=S256\
         &state={state}",
        redirect = url_encode(REDIRECT_URI),
        scopes = url_encode(SCOPES),
    );

    let OAuthCallbacks {
        on_auth,
        on_manual_input,
        on_progress,
        ..
    } = callbacks;

    // Bind the callback listener before publishing a URL that can redirect to it.
    let server = start_then_notify(
        || start_callback_server(CALLBACK_PORT, CALLBACK_PATH),
        move || on_auth(auth_url),
    )
    .await?;

    if let Some(ref on_progress) = on_progress {
        on_progress("Waiting for browser authentication…".into());
    }

    // Race: browser callback vs manual paste.
    let CallbackServerParts {
        mut result_rx,
        cancel_tx,
    } = server.into_parts();
    let mut cancel_tx = Some(cancel_tx);
    let params = match on_manual_input {
        Some(mut manual_rx) => loop {
            tokio::select! {
                result = &mut result_rx => {
                    break result.map_err(|_| anyhow::anyhow!("Callback channel closed"))??;
                }
                manual = manual_rx.recv() => {
                    let raw = manual.ok_or_else(|| anyhow::anyhow!("Manual input cancelled"))?;
                    if raw.trim().is_empty() {
                        anyhow::bail!("Manual input cancelled");
                    }

                    if let Some(params) = validate_manual_authorization_input(&raw, &state)? {
                        if let Some(cancel_tx) = cancel_tx.take() {
                            let _ = cancel_tx.send(());
                        }
                        break params;
                    }

                    if let Some(ref on_progress) = on_progress {
                        on_progress(
                            "Could not parse the pasted callback yet. Paste the full redirect URL or the authorization code.".into(),
                        );
                    }
                }
            }
        },
        None => result_rx
            .await
            .map_err(|_| anyhow::anyhow!("Callback channel closed"))??,
    };
    let params = validate_callback_state(params, &state)?;

    if let Some(ref on_progress) = on_progress {
        on_progress("Exchanging authorization code for tokens…".into());
    }

    exchange_code(&params.code, &params.state, &verifier).await
}

/// Refresh an existing Anthropic OAuth token.
pub async fn refresh_anthropic_token(refresh_token: &str) -> Result<OAuthCredentials> {
    // Anthropic expects a JSON body for token refresh requests.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let resp = client
        .post(TOKEN_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", CLAUDE_CODE_USER_AGENT)
        .header("x-app", "cli")
        .json(&refresh_token_body(refresh_token))
        .send()
        .await
        .map_err(|error| {
            anyhow::Error::new(ProviderError::from_reqwest(
                "anthropic",
                "token refresh",
                TOKEN_URL,
                &error,
            ))
        })?;

    if !resp.status().is_success() {
        let sensitive_values = vec![refresh_token.to_string()];
        return Err(anyhow::Error::new(
            unexpected_response_with_sensitive_values(
                "anthropic",
                "token refresh",
                ProviderErrorFormat::OAuth,
                resp,
                &sensitive_values,
            )
            .await,
        ));
    }

    let token: TokenResponse = resp
        .json()
        .await
        .context("Failed to parse token response")?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    Ok(OAuthCredentials {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: buffered_expiry_ms(now_ms, token.expires_in),
        extra: serde_json::Value::Null,
    })
}

// ── Internals ───────────────────────────────────────────────────────

async fn start_then_notify<Start, StartFuture, Notify, Server>(
    start: Start,
    notify: Notify,
) -> Result<Server>
where
    Start: FnOnce() -> StartFuture,
    StartFuture: std::future::Future<Output = Result<Server>>,
    Notify: FnOnce(),
{
    let server = start().await?;
    notify();
    Ok(server)
}

fn validate_callback_state(params: CallbackParams, expected_state: &str) -> Result<CallbackParams> {
    if params.state != expected_state {
        anyhow::bail!("Anthropic OAuth state mismatch");
    }
    Ok(params)
}

fn validate_manual_authorization_input(
    input: &str,
    expected_state: &str,
) -> Result<Option<CallbackParams>> {
    let parsed = parse_authorization_input(input);
    let Some(code) = parsed.code else {
        return Ok(None);
    };
    let state = if parsed.is_bare_code {
        expected_state.to_string()
    } else {
        parsed.state.unwrap_or_default()
    };
    validate_callback_state(CallbackParams { code, state }, expected_state).map(Some)
}

fn buffered_expiry_ms(now_ms: i64, expires_in_seconds: i64) -> i64 {
    let lifetime_ms = expires_in_seconds.saturating_mul(1000);
    now_ms.saturating_add(lifetime_ms.saturating_sub(TOKEN_EXPIRY_SAFETY_MS).max(0))
}

fn authorization_code_body(code: &str, state: &str, verifier: &str) -> serde_json::Value {
    serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": code,
        "state": state,
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    })
}

fn refresh_token_body(refresh_token: &str) -> serde_json::Value {
    serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": CLIENT_ID,
        "refresh_token": refresh_token,
    })
}

async fn exchange_code(code: &str, state: &str, verifier: &str) -> Result<OAuthCredentials> {
    // Anthropic expects a JSON body (not form-encoded) for code exchange.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let resp = client
        .post(TOKEN_URL)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", CLAUDE_CODE_USER_AGENT)
        .header("x-app", "cli")
        .json(&authorization_code_body(code, state, verifier))
        .send()
        .await
        .map_err(|error| {
            anyhow::Error::new(ProviderError::from_reqwest(
                "anthropic",
                "token exchange",
                TOKEN_URL,
                &error,
            ))
        })?;

    if !resp.status().is_success() {
        let sensitive_values = vec![code.to_string(), state.to_string(), verifier.to_string()];
        return Err(anyhow::Error::new(
            unexpected_response_with_sensitive_values(
                "anthropic",
                "token exchange",
                ProviderErrorFormat::OAuth,
                resp,
                &sensitive_values,
            )
            .await,
        ));
    }

    let token: TokenResponse = resp
        .json()
        .await
        .context("Failed to parse token response")?;
    let now_ms = chrono::Utc::now().timestamp_millis();

    Ok(OAuthCredentials {
        access: token.access_token,
        refresh: token.refresh_token,
        expires: buffered_expiry_ms(now_ms, token.expires_in),
        extra: serde_json::Value::Null,
    })
}

// ── Input parsing ────────────────────────────────────────────────────

struct ParsedInput {
    code: Option<String>,
    state: Option<String>,
    is_bare_code: bool,
}

fn parse_authorization_input(input: &str) -> ParsedInput {
    let value = input.trim();
    if value.is_empty() {
        return ParsedInput {
            code: None,
            state: None,
            is_bare_code: false,
        };
    }
    if let Ok(url) = url::Url::parse(value) {
        let code = url
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.to_string());
        let state = url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.to_string());
        if code.is_some() {
            return ParsedInput {
                code,
                state,
                is_bare_code: false,
            };
        }
    }
    if value.contains('#') {
        let parts: Vec<&str> = value.splitn(2, '#').collect();
        return ParsedInput {
            code: parts.first().map(|s| s.to_string()),
            state: parts.get(1).map(|s| s.to_string()),
            is_bare_code: false,
        };
    }
    if value.contains("code=") {
        let pairs: std::collections::HashMap<String, String> = value
            .split('&')
            .filter_map(|p| p.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        return ParsedInput {
            code: pairs.get("code").cloned(),
            state: pairs.get("state").cloned(),
            is_bare_code: false,
        };
    }
    ParsedInput {
        code: Some(value.to_string()),
        state: None,
        is_bare_code: true,
    }
}

/// Minimal percent-encoding for URL query values.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn callback_state_must_match_the_generated_state() {
        let matching = CallbackParams {
            code: "auth-code".to_string(),
            state: "expected-state".to_string(),
        };
        assert!(validate_callback_state(matching, "expected-state").is_ok());

        let mismatched = CallbackParams {
            code: "auth-code".to_string(),
            state: "wrong-state".to_string(),
        };
        let error = validate_callback_state(mismatched, "expected-state").unwrap_err();
        assert_eq!(error.to_string(), "Anthropic OAuth state mismatch");
    }

    #[test]
    fn token_expiry_reserves_five_minutes_without_going_backwards() {
        assert_eq!(buffered_expiry_ms(1_000_000, 3_600), 4_300_000);
        assert_eq!(buffered_expiry_ms(1_000_000, 120), 1_000_000);
        assert_eq!(buffered_expiry_ms(1_000_000, -1), 1_000_000);
    }

    #[test]
    fn refresh_body_does_not_send_scope() {
        let body = refresh_token_body("refresh-token");
        assert_eq!(body["grant_type"], "refresh_token");
        assert_eq!(body["client_id"], CLIENT_ID);
        assert_eq!(body["refresh_token"], "refresh-token");
        assert_eq!(body.as_object().map(serde_json::Map::len), Some(3));
        assert!(body.get("scope").is_none());
    }

    #[test]
    fn authorization_code_body_keeps_state_and_pkce_verifier() {
        let body = authorization_code_body("auth-code", "expected-state", "pkce-verifier");
        assert_eq!(body["grant_type"], "authorization_code");
        assert_eq!(body["code"], "auth-code");
        assert_eq!(body["state"], "expected-state");
        assert_eq!(body["code_verifier"], "pkce-verifier");
    }

    #[tokio::test]
    async fn callback_listener_starts_before_authorization_is_notified() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let start_events = Arc::clone(&events);
        let notify_events = Arc::clone(&events);

        let server = start_then_notify(
            move || async move {
                start_events.lock().unwrap().push("listener-bound");
                Ok::<_, anyhow::Error>("server")
            },
            move || {
                notify_events.lock().unwrap().push("authorization-notified");
            },
        )
        .await
        .expect("start and notify");

        assert_eq!(server, "server");
        assert_eq!(
            *events.lock().unwrap(),
            vec!["listener-bound", "authorization-notified"]
        );
    }

    #[test]
    fn manual_authorization_input_preserves_only_supplied_state() {
        let bare = parse_authorization_input("bare-code");
        assert_eq!(bare.code.as_deref(), Some("bare-code"));
        assert_eq!(bare.state, None);

        let url = parse_authorization_input(
            "http://localhost:53692/callback?code=url-code&state=url-state",
        );
        assert_eq!(url.code.as_deref(), Some("url-code"));
        assert_eq!(url.state.as_deref(), Some("url-state"));

        let pair = parse_authorization_input("pair-code#pair-state");
        assert_eq!(pair.code.as_deref(), Some("pair-code"));
        assert_eq!(pair.state.as_deref(), Some("pair-state"));
    }

    #[test]
    fn manual_callback_validation_pairs_only_bare_codes_with_local_state() {
        let bare = validate_manual_authorization_input("bare-code", "expected-state")
            .expect("bare code is valid")
            .expect("callback params");
        assert_eq!(bare.code, "bare-code");
        assert_eq!(bare.state, "expected-state");

        for input in [
            "http://localhost:53692/callback?code=url-code&state=wrong-state",
            "pair-code#wrong-state",
            "http://localhost:53692/callback?code=missing-state",
        ] {
            let error = validate_manual_authorization_input(input, "expected-state").unwrap_err();
            assert_eq!(error.to_string(), "Anthropic OAuth state mismatch");
        }
    }
}
