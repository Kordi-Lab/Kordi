use anyhow::{Context, Result};
use kordi_provider::{
    ProviderError, ProviderErrorFormat, unexpected_response_with_sensitive_values,
};
use reqwest::header::{ACCEPT, AUTHORIZATION};
use serde::Deserialize;
use serde_json::json;
use tokio::time::{Duration, sleep};

use super::{OAuthCallbacks, OAuthCredentials, OAuthDeviceCode};

const CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const API_VERSION: &str = "2025-04-01";
const DEVICE_FLOW_SCOPES: &str = "repo workflow";

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: i64,
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    refresh_token_expires_in: Option<i64>,
    scope: Option<String>,
    token_type: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserInfoResponse {
    login: Option<String>,
}

#[derive(Deserialize)]
struct CopilotTokenEnvelope {
    token: String,
    expires_at: i64,
    #[serde(default)]
    refresh_in: i64,
    #[serde(default)]
    organization_list: Vec<String>,
    #[serde(default)]
    enterprise_list: Vec<String>,
    #[serde(default)]
    sku: Option<String>,
    #[serde(default)]
    endpoints: Option<CopilotEndpoints>,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub(crate) struct CopilotEndpoints {
    #[serde(default)]
    api: Option<String>,
    #[serde(default)]
    telemetry: Option<String>,
    #[serde(default)]
    proxy: Option<String>,
}

#[derive(Clone)]
pub struct CopilotRuntimeSession {
    pub login: Option<String>,
    pub copilot_token: String,
    pub copilot_expires_at_ms: i64,
    pub api_base_url: String,
    pub models: Vec<String>,
    pub(crate) raw_endpoints: Option<CopilotEndpoints>,
    pub organization_list: Vec<String>,
    pub enterprise_list: Vec<String>,
    pub sku: Option<String>,
}

impl std::fmt::Debug for AccessTokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessTokenResponse")
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("expires_in", &self.expires_in)
            .field("refresh_token_expires_in", &self.refresh_token_expires_in)
            .field("scope", &self.scope)
            .field("token_type", &self.token_type)
            .field("error", &self.error)
            .field("error_description", &self.error_description)
            .finish()
    }
}

impl std::fmt::Debug for CopilotTokenEnvelope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CopilotTokenEnvelope")
            .field("token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .field("refresh_in", &self.refresh_in)
            .field("organization_list", &self.organization_list)
            .field("enterprise_list", &self.enterprise_list)
            .field("sku", &self.sku)
            .field("endpoints", &self.endpoints)
            .finish()
    }
}

impl std::fmt::Debug for CopilotRuntimeSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CopilotRuntimeSession")
            .field("login", &self.login)
            .field("copilot_token", &"[REDACTED]")
            .field("copilot_expires_at_ms", &self.copilot_expires_at_ms)
            .field("api_base_url", &self.api_base_url)
            .field("models", &self.models)
            .field("raw_endpoints", &self.raw_endpoints)
            .field("organization_list", &self.organization_list)
            .field("enterprise_list", &self.enterprise_list)
            .field("sku", &self.sku)
            .finish()
    }
}

pub(crate) async fn login_github_copilot(
    authority: &str,
    callbacks: OAuthCallbacks,
) -> Result<OAuthCredentials> {
    let authority = normalize_authority(authority)?;
    let server_url = server_url_for_authority(&authority);

    let device = request_device_code(&server_url).await?;
    (callbacks.on_auth)(device.verification_uri.clone());
    if let Some(ref on_device_code) = callbacks.on_device_code {
        on_device_code(OAuthDeviceCode {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
        });
    }
    if let Some(ref on_progress) = callbacks.on_progress {
        on_progress(format!(
            "Open {} and enter code {}",
            device.verification_uri, device.user_code
        ));
    }

    let access = poll_device_flow(&server_url, &device, callbacks.on_manual_input).await?;
    let github_access_token = access
        .access_token
        .clone()
        .context("GitHub device flow returned no access token")?;

    if let Some(ref on_progress) = callbacks.on_progress {
        on_progress("Fetching Copilot account and runtime token…".to_string());
    }

    let runtime =
        exchange_github_token_for_copilot_session(&authority, &github_access_token).await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let github_access_expires_ms = access
        .expires_in
        .map(|seconds| now_ms + seconds * 1000)
        .unwrap_or(now_ms + 365 * 24 * 60 * 60 * 1000);
    let github_refresh_expires_ms = access
        .refresh_token_expires_in
        .map(|seconds| now_ms + seconds * 1000);

    Ok(OAuthCredentials {
        access: github_access_token,
        refresh: access.refresh_token.unwrap_or_default(),
        expires: github_access_expires_ms,
        extra: json!({
            "domain": authority,
            "github_app_id": CLIENT_ID,
            "github_scopes": access.scope,
            "github_token_type": access.token_type,
            "github_access_expires_at": github_access_expires_ms,
            "github_refresh_expires_at": github_refresh_expires_ms,
            "login": runtime.login,
            "copilot_token": runtime.copilot_token,
            "copilot_expires_at": runtime.copilot_expires_at_ms,
            "copilot_api_base_url": runtime.api_base_url,
            "copilot_endpoints": runtime.raw_endpoints,
            "copilot_models": runtime.models,
            "organization_list": runtime.organization_list,
            "enterprise_list": runtime.enterprise_list,
            "sku": runtime.sku,
        }),
    })
}

pub(crate) async fn refresh_github_copilot_token(
    refresh_token: &str,
    authority: &str,
) -> Result<OAuthCredentials> {
    if refresh_token.trim().is_empty() {
        anyhow::bail!("No GitHub refresh token available for GitHub Copilot");
    }

    let authority = normalize_authority(authority)?;
    let server_url = server_url_for_authority(&authority);
    let refreshed = refresh_github_access_token(&server_url, refresh_token).await?;
    let github_access_token = refreshed
        .access_token
        .clone()
        .context("GitHub refresh response returned no access token")?;
    let runtime =
        exchange_github_token_for_copilot_session(&authority, &github_access_token).await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let github_access_expires_ms = refreshed
        .expires_in
        .map(|seconds| now_ms + seconds * 1000)
        .unwrap_or(now_ms + 365 * 24 * 60 * 60 * 1000);
    let github_refresh_expires_ms = refreshed
        .refresh_token_expires_in
        .map(|seconds| now_ms + seconds * 1000);

    Ok(OAuthCredentials {
        access: github_access_token,
        refresh: refreshed
            .refresh_token
            .unwrap_or_else(|| refresh_token.to_string()),
        expires: github_access_expires_ms,
        extra: json!({
            "domain": authority,
            "github_app_id": CLIENT_ID,
            "github_scopes": refreshed.scope,
            "github_token_type": refreshed.token_type,
            "github_access_expires_at": github_access_expires_ms,
            "github_refresh_expires_at": github_refresh_expires_ms,
            "login": runtime.login,
            "copilot_token": runtime.copilot_token,
            "copilot_expires_at": runtime.copilot_expires_at_ms,
            "copilot_api_base_url": runtime.api_base_url,
            "copilot_endpoints": runtime.raw_endpoints,
            "copilot_models": runtime.models,
            "organization_list": runtime.organization_list,
            "enterprise_list": runtime.enterprise_list,
            "sku": runtime.sku,
        }),
    })
}

pub async fn exchange_github_token_for_copilot_session(
    authority: &str,
    github_access_token: &str,
) -> Result<CopilotRuntimeSession> {
    let authority = normalize_authority(authority)?;
    let api_url = dotcom_api_url_for_authority(&authority);
    let login = fetch_user_login(&api_url, github_access_token).await.ok();
    let envelope = fetch_copilot_token_envelope(&api_url, github_access_token).await?;
    let api_base_url = envelope
        .endpoints
        .as_ref()
        .and_then(|endpoints| endpoints.api.clone())
        .unwrap_or_else(|| "https://api.githubcopilot.com".to_string());
    let models = fetch_copilot_models(&api_base_url, &envelope.token)
        .await
        .unwrap_or_default();

    let now_ms = chrono::Utc::now().timestamp_millis();
    let copilot_expires_at_ms = if envelope.refresh_in > 0 {
        now_ms + (envelope.refresh_in + 60) * 1000
    } else {
        envelope.expires_at * 1000
    };

    Ok(CopilotRuntimeSession {
        login,
        copilot_token: envelope.token,
        copilot_expires_at_ms,
        api_base_url,
        models,
        raw_endpoints: envelope.endpoints,
        organization_list: envelope.organization_list,
        enterprise_list: envelope.enterprise_list,
        sku: envelope.sku,
    })
}

pub(crate) fn normalize_authority(input: &str) -> Result<String> {
    let value = input.trim().trim_end_matches('/');
    if value.is_empty() {
        anyhow::bail!("GitHub authority cannot be empty");
    }

    let host = if value.contains("://") {
        url::Url::parse(value)
            .ok()
            .and_then(|url| url.host_str().map(ToString::to_string))
            .unwrap_or_else(|| value.to_string())
    } else {
        value.split('/').next().unwrap_or(value).to_string()
    };

    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() || host.contains(' ') {
        anyhow::bail!("Invalid GitHub authority");
    }
    Ok(host)
}

pub(crate) fn server_url_for_authority(authority: &str) -> String {
    if authority.eq_ignore_ascii_case("github.com") {
        "https://github.com".to_string()
    } else {
        format!("https://{authority}")
    }
}

pub(crate) fn dotcom_api_url_for_authority(authority: &str) -> String {
    if authority.eq_ignore_ascii_case("github.com") {
        "https://api.github.com".to_string()
    } else {
        format!("https://api.{authority}")
    }
}

fn github_request_error(
    operation: &'static str,
    url: &str,
    error: &reqwest::Error,
) -> anyhow::Error {
    anyhow::Error::new(ProviderError::from_reqwest(
        "github-copilot",
        operation,
        url,
        error,
    ))
}

async fn require_github_success(
    response: reqwest::Response,
    operation: &'static str,
    format: ProviderErrorFormat,
    sensitive_values: &[String],
) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    Err(anyhow::Error::new(
        unexpected_response_with_sensitive_values(
            "github-copilot",
            operation,
            format,
            response,
            sensitive_values,
        )
        .await,
    ))
}

async fn request_device_code(server_url: &str) -> Result<DeviceCodeResponse> {
    let client = reqwest::Client::new();
    let url = format!("{}/login/device/code", server_url.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header(ACCEPT, "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", DEVICE_FLOW_SCOPES)])
        .send()
        .await
        .map_err(|error| github_request_error("device authorization", &url, &error))?;
    require_github_success(
        response,
        "device authorization",
        ProviderErrorFormat::OAuth,
        &[],
    )
    .await?
    .json::<DeviceCodeResponse>()
    .await
    .context("Failed to parse GitHub device flow response")
}

async fn poll_device_flow(
    server_url: &str,
    device: &DeviceCodeResponse,
    cancel_rx: Option<tokio::sync::mpsc::UnboundedReceiver<String>>,
) -> Result<AccessTokenResponse> {
    let started = std::time::Instant::now();
    let expires = Duration::from_secs(device.expires_in.max(1) as u64);
    let mut interval_secs = device.interval.unwrap_or(5).max(1);
    let client = reqwest::Client::new();
    let mut cancel_rx = cancel_rx;
    let url = format!(
        "{}/login/oauth/access_token",
        server_url.trim_end_matches('/')
    );
    let sensitive_values = vec![device.device_code.clone()];

    loop {
        if started.elapsed() >= expires {
            anyhow::bail!("GitHub device code expired before authorization completed");
        }

        let wait = sleep(Duration::from_secs(interval_secs));
        tokio::pin!(wait);
        tokio::select! {
            _ = &mut wait => {}
            manual = async {
                match cancel_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => None,
                }
            }, if cancel_rx.is_some() => {
                let value = manual.unwrap_or_default();
                if value.trim().is_empty() {
                    anyhow::bail!("Manual input cancelled");
                }
                continue;
            }
        }

        let response = client
            .post(&url)
            .header(ACCEPT, "application/json")
            .form(&[
                ("client_id", CLIENT_ID),
                ("device_code", device.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await
            .map_err(|error| github_request_error("device token polling", &url, &error))?;
        let response = require_github_success(
            response,
            "device token polling",
            ProviderErrorFormat::OAuth,
            &sensitive_values,
        )
        .await?
        .json::<AccessTokenResponse>()
        .await
        .context("Failed to parse GitHub device token response")?;

        if let Some(token) = response.access_token.as_ref()
            && !token.trim().is_empty()
        {
            return Ok(response);
        }

        match response.error.as_deref() {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                interval_secs += 5;
                continue;
            }
            Some(error) => {
                let message = response.error_description.as_deref().unwrap_or(error);
                return Err(anyhow::Error::new(
                    ProviderError::stream_with_sensitive_values(
                        "github-copilot",
                        "device token polling",
                        Some(message),
                        Some(error),
                        &sensitive_values,
                    ),
                ));
            }
            None => anyhow::bail!("GitHub device flow returned no access token"),
        }
    }
}

fn github_client_secret() -> Option<String> {
    for key in ["GITHUB_COPILOT_CLIENT_SECRET", "GH_COPILOT_CLIENT_SECRET"] {
        if let Ok(value) = std::env::var(key)
            && !value.trim().is_empty()
        {
            return Some(value);
        }
    }
    None
}

async fn refresh_github_access_token(
    server_url: &str,
    refresh_token: &str,
) -> Result<AccessTokenResponse> {
    let client_secret = github_client_secret().context(
        "GitHub Copilot refresh requires GITHUB_COPILOT_CLIENT_SECRET (or GH_COPILOT_CLIENT_SECRET). Re-run `kordi login github-copilot` instead, or set the client secret explicitly for refresh support.",
    )?;

    let client = reqwest::Client::new();
    let url = format!(
        "{}/login/oauth/access_token",
        server_url.trim_end_matches('/')
    );
    let sensitive_values = vec![refresh_token.to_string(), client_secret.clone()];
    let response = client
        .post(&url)
        .header(ACCEPT, "application/json")
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", client_secret.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|error| github_request_error("token refresh", &url, &error))?;
    let response = require_github_success(
        response,
        "token refresh",
        ProviderErrorFormat::OAuth,
        &sensitive_values,
    )
    .await?
    .json::<AccessTokenResponse>()
    .await
    .context("Failed to parse GitHub refresh response")?;

    if let Some(token) = response.access_token.as_ref()
        && !token.trim().is_empty()
    {
        Ok(response)
    } else {
        let message = response
            .error_description
            .as_deref()
            .or(response.error.as_deref());
        Err(anyhow::Error::new(
            ProviderError::stream_with_sensitive_values(
                "github-copilot",
                "token refresh",
                message,
                response.error.as_deref(),
                &sensitive_values,
            ),
        ))
    }
}

async fn fetch_user_login(api_url: &str, github_access_token: &str) -> Result<String> {
    let client = reqwest::Client::new();
    let url = format!("{}/user", api_url.trim_end_matches('/'));
    let sensitive_values = vec![github_access_token.to_string()];
    let response = client
        .get(&url)
        .header(ACCEPT, "application/json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header(AUTHORIZATION, format!("token {github_access_token}"))
        .send()
        .await
        .map_err(|error| github_request_error("user info request", &url, &error))?;
    let response = require_github_success(
        response,
        "user info request",
        ProviderErrorFormat::OAuth,
        &sensitive_values,
    )
    .await?
    .json::<UserInfoResponse>()
    .await
    .context("Failed to parse GitHub user info response")?;

    response
        .login
        .filter(|login| !login.trim().is_empty())
        .context("GitHub user info response did not include login")
}

async fn fetch_copilot_token_envelope(
    api_url: &str,
    github_access_token: &str,
) -> Result<CopilotTokenEnvelope> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/copilot_internal/v2/token",
        api_url.trim_end_matches('/')
    );
    let sensitive_values = vec![github_access_token.to_string()];
    let response = client
        .get(&url)
        .header(ACCEPT, "application/json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header(AUTHORIZATION, format!("token {github_access_token}"))
        .send()
        .await
        .map_err(|error| github_request_error("Copilot token exchange", &url, &error))?;

    let status = response.status();
    if !status.is_success() {
        let hint = if status == reqwest::StatusCode::UNAUTHORIZED {
            "GitHub accepted the device login, but the Copilot token exchange was unauthorized. Try logging in again."
        } else if status == reqwest::StatusCode::FORBIDDEN {
            "This GitHub account may not have Copilot enabled, or org/enterprise policy may block Copilot access."
        } else {
            "GitHub rejected the Copilot token exchange."
        };
        let error = unexpected_response_with_sensitive_values(
            "github-copilot",
            "Copilot token exchange",
            ProviderErrorFormat::OAuth,
            response,
            &sensitive_values,
        )
        .await;
        let error = match error {
            ProviderError::Http(error) => ProviderError::Http(error.with_hint(hint)),
            error => error,
        };
        return Err(anyhow::Error::new(error));
    }

    response
        .json::<CopilotTokenEnvelope>()
        .await
        .context("Failed to parse GitHub Copilot token envelope")
}

async fn fetch_copilot_models(api_base_url: &str, copilot_token: &str) -> Result<Vec<String>> {
    #[derive(Debug, Deserialize)]
    struct ModelsResponse {
        #[serde(default)]
        data: Vec<ModelEntry>,
    }

    #[derive(Debug, Deserialize)]
    struct ModelEntry {
        id: String,
    }

    let client = reqwest::Client::new();
    let url = format!("{}/models", api_base_url.trim_end_matches('/'));
    let sensitive_values = vec![copilot_token.to_string()];
    let response = client
        .get(&url)
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, format!("Bearer {copilot_token}"))
        .header("OpenAI-Organization", "github-copilot")
        .send()
        .await
        .map_err(|error| github_request_error("models request", &url, &error))?;
    let response = require_github_success(
        response,
        "models request",
        ProviderErrorFormat::OpenAi,
        &sensitive_values,
    )
    .await?;

    let value = response
        .json::<serde_json::Value>()
        .await
        .context("Failed to parse GitHub Copilot /models response")?;

    if let Ok(parsed) = serde_json::from_value::<ModelsResponse>(value.clone()) {
        return Ok(parsed.data.into_iter().map(|model| model.id).collect());
    }
    if let Ok(parsed) = serde_json::from_value::<Vec<ModelEntry>>(value) {
        return Ok(parsed.into_iter().map(|model| model.id).collect());
    }

    anyhow::bail!("GitHub Copilot returned an unsupported models response")
}

pub(crate) fn github_copilot_runtime_headers() -> std::collections::HashMap<String, String> {
    let mut headers = std::collections::HashMap::new();
    headers.insert(
        "OpenAI-Organization".to_string(),
        "github-copilot".to_string(),
    );
    headers.insert(
        "Editor-Version".to_string(),
        format!("kordi/{}", env!("CARGO_PKG_VERSION")),
    );
    headers.insert(
        "Editor-Plugin-Version".to_string(),
        format!("kordi/{}", env!("CARGO_PKG_VERSION")),
    );
    headers.insert(
        "Copilot-Language-Server-Version".to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    );
    headers.insert("X-GitHub-Api-Version".to_string(), API_VERSION.to_string());
    headers
}

#[cfg(test)]
mod tests {
    use super::{
        API_VERSION, AccessTokenResponse, CopilotRuntimeSession, CopilotTokenEnvelope,
        dotcom_api_url_for_authority, github_copilot_runtime_headers, normalize_authority,
        server_url_for_authority,
    };

    #[test]
    fn normalize_authority_accepts_plain_hosts_urls_and_paths() {
        assert_eq!(normalize_authority("github.com").unwrap(), "github.com");
        assert_eq!(
            normalize_authority("  https://GitHub.com/login/device  ").unwrap(),
            "github.com"
        );
        assert_eq!(
            normalize_authority("ghe.example.com/some/path").unwrap(),
            "ghe.example.com"
        );
        assert_eq!(
            normalize_authority("HTTPS://Copilot.EXAMPLE.COM/").unwrap(),
            "copilot.example.com"
        );
    }

    #[test]
    fn normalize_authority_rejects_empty_or_space_separated_values() {
        assert!(normalize_authority("   ").is_err());
        assert!(normalize_authority("github enterprise").is_err());
        assert!(normalize_authority("https://github enterprise.local").is_err());
    }

    #[test]
    fn server_url_uses_github_dot_com_or_enterprise_host() {
        assert_eq!(server_url_for_authority("github.com"), "https://github.com");
        assert_eq!(
            server_url_for_authority("ghe.example.com"),
            "https://ghe.example.com"
        );
    }

    #[test]
    fn api_url_uses_public_or_enterprise_prefix() {
        assert_eq!(
            dotcom_api_url_for_authority("github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            dotcom_api_url_for_authority("ghe.example.com"),
            "https://api.ghe.example.com"
        );
    }

    #[test]
    fn runtime_headers_include_expected_copilot_metadata() {
        let headers = github_copilot_runtime_headers();

        assert_eq!(
            headers.get("OpenAI-Organization").map(String::as_str),
            Some("github-copilot")
        );
        assert_eq!(
            headers.get("Editor-Version").map(String::as_str),
            Some(concat!("kordi/", env!("CARGO_PKG_VERSION")))
        );
        assert_eq!(
            headers.get("Editor-Plugin-Version").map(String::as_str),
            Some(concat!("kordi/", env!("CARGO_PKG_VERSION")))
        );
        assert_eq!(
            headers
                .get("Copilot-Language-Server-Version")
                .map(String::as_str),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            headers.get("X-GitHub-Api-Version").map(String::as_str),
            Some(API_VERSION)
        );
    }

    #[test]
    fn debug_output_redacts_github_and_copilot_tokens() {
        let access = AccessTokenResponse {
            access_token: Some("gh-access-secret".to_string()),
            refresh_token: Some("gh-refresh-secret".to_string()),
            expires_in: Some(60),
            refresh_token_expires_in: Some(120),
            scope: Some("repo".to_string()),
            token_type: Some("bearer".to_string()),
            error: None,
            error_description: None,
        };
        let access_debug = format!("{access:?}");
        assert!(access_debug.contains("[REDACTED]"));
        assert!(!access_debug.contains("gh-access-secret"));
        assert!(!access_debug.contains("gh-refresh-secret"));

        let envelope = CopilotTokenEnvelope {
            token: "copilot-envelope-secret".to_string(),
            expires_at: 456,
            refresh_in: 60,
            organization_list: vec!["org".to_string()],
            enterprise_list: vec!["ent".to_string()],
            sku: Some("business".to_string()),
            endpoints: None,
        };
        let envelope_debug = format!("{envelope:?}");
        assert!(envelope_debug.contains("[REDACTED]"));
        assert!(!envelope_debug.contains("copilot-envelope-secret"));

        let runtime = CopilotRuntimeSession {
            login: Some("octocat".to_string()),
            copilot_token: "copilot-runtime-secret".to_string(),
            copilot_expires_at_ms: 123,
            api_base_url: "https://api.githubcopilot.com".to_string(),
            models: vec!["gpt-4.1".to_string()],
            raw_endpoints: None,
            organization_list: vec!["org".to_string()],
            enterprise_list: vec!["ent".to_string()],
            sku: Some("business".to_string()),
        };
        let runtime_debug = format!("{runtime:?}");
        assert!(runtime_debug.contains("[REDACTED]"));
        assert!(!runtime_debug.contains("copilot-runtime-secret"));
    }
}
