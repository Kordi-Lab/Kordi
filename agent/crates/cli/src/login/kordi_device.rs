//! `kordi login --device`: sign this host in to Kordi Cloud with a device
//! code (RFC 8628), for a Mac without a usable browser such as one reached
//! over SSH.
//!
//! The command asks the server for a code pair, prints the approval URL and
//! the short code, and polls until someone signed in on another device
//! approves it. The resulting session is saved where the Kordi app keeps the
//! session from browser sign-in, so the app on this host starts signed in.
//! The server contract is in `docs/development/device-code-sign-in.md`.

use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;

mod secret_store;

pub use secret_store::CloudSessionEntry;

/// Server configuration for the Kordi Cloud origin. Defaults to the product.
pub const CLOUD_API_BASE_ENV: &str = "KORDI_CLOUD_API_BASE";
/// Registered app the session belongs to. Defaults to the release Mac app.
pub const APP_CLIENT_ID_ENV: &str = "KORDI_APP_CLIENT_ID";
const DEFAULT_CLOUD_API_BASE: &str = "https://kordi.ai";
const DEFAULT_CLIENT_ID: &str = "kordi-desktop";
const DEVICE_CODE_PATH: &str = "/v1/cloud/auth/device/code";
const DEVICE_TOKEN_PATH: &str = "/v1/cloud/auth/device/token";
/// Refresh goes through the ordinary app token endpoint, like browser
/// sign-in, so the app can keep the session fresh.
const APP_TOKEN_PATH: &str = "/v1/cloud/auth/app/token";
const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);
const MAX_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceSignInConfig {
    pub base_url: String,
    pub client_id: String,
}

impl DeviceSignInConfig {
    /// `--server`, then `KORDI_CLOUD_API_BASE`, then the product origin.
    pub fn resolve(server: Option<&str>) -> Result<Self> {
        let base = server
            .map(str::to_string)
            .or_else(|| std::env::var(CLOUD_API_BASE_ENV).ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_CLOUD_API_BASE.to_string());
        let client_id = std::env::var(APP_CLIENT_ID_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_CLIENT_ID.to_string());
        Ok(Self {
            base_url: allowed_base_url(&base)?,
            client_id,
        })
    }
}

/// HTTPS, or plain HTTP only to this machine.
fn allowed_base_url(value: &str) -> Result<String> {
    let url = url::Url::parse(value.trim()).context("the server must be a URL")?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1" | "[::1]" | "::1" | "localhost")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        bail!("the server must use https");
    }
    Ok(url.origin().ascii_serialization())
}

/// What the device reports about itself; shown on the approval page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceDescription {
    pub name: Option<String>,
    pub platform: Option<String>,
    pub os_version: Option<String>,
    pub app_version: Option<String>,
    pub public_key: Option<String>,
    pub key_algorithm: Option<String>,
}

/// The code to show the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DevicePrompt {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: Duration,
}

#[derive(Debug, Deserialize)]
struct CodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: String,
    device_id: String,
    #[serde(default)]
    account: Option<Value>,
}

/// Why device sign-in stopped without a session.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum DeviceSignInError {
    #[error(
        "This server does not support sign-in with a code. Sign in from the Kordi app with a browser instead."
    )]
    Unsupported,
    #[error("{0}")]
    Denied(String),
    #[error("The code expired before it was approved. Run `kordi login --device` again.")]
    Expired,
    #[error("{0}")]
    Rejected(String),
}

fn error_text(body: &Value, fallback: &str) -> String {
    body.get("error_description")
        .or_else(|| body.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

async fn post_form(
    client: &reqwest::Client,
    url: &str,
    pairs: &[(&str, &str)],
) -> Result<(reqwest::StatusCode, Value)> {
    let response = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(form(pairs))
        .send()
        .await
        .with_context(|| format!("could not reach {url}"))?;
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, body))
}

/// Run the device code flow and return the session to save. `on_prompt`
/// shows the code; `sleep` waits between polls (tests pass a no-op).
pub async fn device_sign_in<S, F>(
    client: &reqwest::Client,
    config: &DeviceSignInConfig,
    device: &DeviceDescription,
    on_prompt: impl FnOnce(&DevicePrompt),
    sleep: S,
) -> Result<CloudSessionEntry>
where
    S: Fn(Duration) -> F,
    F: std::future::Future<Output = ()>,
{
    let mut pairs = vec![("client_id", config.client_id.as_str())];
    for (key, value) in [
        ("device_name", &device.name),
        ("device_platform", &device.platform),
        ("device_os_version", &device.os_version),
        ("device_app_version", &device.app_version),
        ("device_public_key", &device.public_key),
        ("device_key_algorithm", &device.key_algorithm),
    ] {
        if let Some(value) = value.as_deref() {
            pairs.push((key, value));
        }
    }
    let code_url = format!("{}{DEVICE_CODE_PATH}", config.base_url);
    let (status, body) = post_form(client, &code_url, &pairs).await?;
    if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::METHOD_NOT_ALLOWED
    {
        return Err(DeviceSignInError::Unsupported.into());
    }
    if !status.is_success() {
        return Err(DeviceSignInError::Rejected(error_text(
            &body,
            "The server refused to start sign-in with a code.",
        ))
        .into());
    }
    let code: CodeResponse =
        serde_json::from_value(body).context("the server sent an unexpected code response")?;
    on_prompt(&DevicePrompt {
        user_code: code.user_code.clone(),
        verification_uri: code.verification_uri.clone(),
        expires_in: Duration::from_secs(code.expires_in),
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(code.expires_in);
    let mut interval = Duration::from_secs(code.interval.unwrap_or(5).clamp(1, 60));
    let token_url = format!("{}{DEVICE_TOKEN_PATH}", config.base_url);
    loop {
        if std::time::Instant::now() >= deadline {
            return Err(DeviceSignInError::Expired.into());
        }
        sleep(interval).await;
        let poll = post_form(
            client,
            &token_url,
            &[
                ("grant_type", DEVICE_CODE_GRANT_TYPE),
                ("client_id", config.client_id.as_str()),
                ("device_code", code.device_code.as_str()),
            ],
        )
        .await;
        let (status, body) = match poll {
            Ok(result) => result,
            // A dropped connection is retried until the code expires.
            Err(_) => {
                interval = (interval + SLOW_DOWN_STEP).min(MAX_INTERVAL);
                continue;
            }
        };
        if status.is_success() {
            let tokens: TokenResponse = serde_json::from_value(body)
                .context("the server sent an unexpected token response")?;
            return session_entry(config, tokens);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            interval = (interval + SLOW_DOWN_STEP).min(MAX_INTERVAL);
            continue;
        }
        match body.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                interval = body
                    .get("interval")
                    .and_then(Value::as_u64)
                    .map(Duration::from_secs)
                    .unwrap_or(interval + SLOW_DOWN_STEP)
                    .min(MAX_INTERVAL);
            }
            Some("access_denied") => {
                return Err(DeviceSignInError::Denied(error_text(
                    &body,
                    "The sign-in was denied.",
                ))
                .into());
            }
            Some("expired_token") => return Err(DeviceSignInError::Expired.into()),
            _ => {
                return Err(DeviceSignInError::Rejected(error_text(
                    &body,
                    "The server refused the sign-in.",
                ))
                .into());
            }
        }
    }
}

fn session_entry(config: &DeviceSignInConfig, tokens: TokenResponse) -> Result<CloudSessionEntry> {
    let account_id = tokens
        .account
        .as_ref()
        .and_then(|account| account.get("accountId"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("the server did not name the signed-in account"))?
        .to_string();
    if tokens.access_token.is_empty() || tokens.refresh_token.is_empty() || tokens.expires_in <= 0 {
        bail!("the server sent an unusable session");
    }
    Ok(CloudSessionEntry {
        token: tokens.access_token,
        account_id,
        expires_at: (Utc::now() + chrono::Duration::seconds(tokens.expires_in)).to_rfc3339(),
        device_id: Some(tokens.device_id),
        refresh_token: Some(tokens.refresh_token),
        client_id: Some(config.client_id.clone()),
        token_endpoint: Some(format!("{}{APP_TOKEN_PATH}", config.base_url)),
    })
}

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?.trim().to_string();
    (output.status.success() && !text.is_empty()).then_some(text)
}

/// This host's name, platform, OS version and installation key. The key is
/// the Kordi app's installation key on this host, created if missing, so
/// the app and this command register as the same device.
fn this_device() -> Result<DeviceDescription> {
    let macos = cfg!(target_os = "macos");
    let name = if macos {
        command_output("scutil", &["--get", "ComputerName"])
    } else {
        None
    }
    .or_else(|| command_output("hostname", &[]));
    let os_version = if macos {
        command_output("sw_vers", &["-productVersion"])
    } else {
        command_output("uname", &["-r"])
    };
    let identity = secret_store::installation_identity().map_err(|error| keychain_hint(&error))?;
    Ok(DeviceDescription {
        name,
        platform: Some(
            match std::env::consts::OS {
                "macos" => "macos",
                other => other,
            }
            .to_string(),
        ),
        os_version,
        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        public_key: Some(identity.public_key_spki),
        key_algorithm: Some(identity.key_algorithm),
    })
}

fn keychain_hint(error: &str) -> anyhow::Error {
    anyhow!(
        "Could not use the keychain: {error}. On a Mac reached over SSH, unlock the login \
         keychain with `security unlock-keychain` and try again."
    )
}

/// End a sign-in this command could not save, so no session is left behind.
async fn revoke(client: &reqwest::Client, config: &DeviceSignInConfig, entry: &CloudSessionEntry) {
    if let Some(refresh_token) = entry.refresh_token.as_deref() {
        let url = format!("{}/v1/cloud/auth/app/revoke", config.base_url);
        let _ = post_form(
            client,
            &url,
            &[
                ("client_id", config.client_id.as_str()),
                ("token", refresh_token),
            ],
        )
        .await;
    }
}

fn print_prompt(prompt: &DevicePrompt) {
    println!();
    println!(
        "To sign in, open {} on another device and enter:",
        prompt.verification_uri
    );
    println!();
    println!("    {}", prompt.user_code);
    println!();
    println!(
        "Never share this code. It expires in {} minutes.",
        prompt.expires_in.as_secs().div_ceil(60)
    );
    println!("Waiting for approval…");
}

/// `kordi login --device [--server <url>]`.
pub async fn handle_device_login(server: Option<&str>) -> Result<()> {
    let config = DeviceSignInConfig::resolve(server)?;
    let device = this_device()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let sign_in = device_sign_in(&client, &config, &device, print_prompt, tokio::time::sleep);
    let entry = tokio::select! {
        result = sign_in => result?,
        _ = tokio::signal::ctrl_c() => bail!("Sign-in cancelled."),
    };
    if let Err(error) = secret_store::store_session(&entry) {
        revoke(&client, &config, &entry).await;
        return Err(keychain_hint(&error));
    }
    println!("Signed in to Kordi Cloud on this device.");
    Ok(())
}

#[cfg(test)]
mod tests;
