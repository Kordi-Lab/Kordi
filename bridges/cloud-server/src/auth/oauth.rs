use axum::response::{IntoResponse, Redirect, Response};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const DEFAULT_PUBLIC_BASE_URL: &str = "https://kordi.ai";
const AVATAR_SEED_PREFIX: &str = "kordi-pixel-avatar://";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OAuthProvider {
    Google,
    Github,
}

impl OAuthProvider {
    pub(super) const ALL: [Self; 2] = [Self::Google, Self::Github];

    pub(super) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "google" => Some(Self::Google),
            "github" => Some(Self::Github),
            _ => None,
        }
    }

    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Github => "github",
        }
    }

    pub(super) fn display_name(self) -> &'static str {
        match self {
            Self::Google => "Google",
            Self::Github => "GitHub",
        }
    }

    fn env_prefix(self) -> &'static str {
        match self {
            Self::Google => "GOOGLE",
            Self::Github => "GITHUB",
        }
    }

    pub(super) fn auth_url(self) -> &'static str {
        match self {
            Self::Google => "https://accounts.google.com/o/oauth2/v2/auth",
            Self::Github => "https://github.com/login/oauth/authorize",
        }
    }

    pub(super) fn token_url(self) -> &'static str {
        match self {
            Self::Google => "https://oauth2.googleapis.com/token",
            Self::Github => "https://github.com/login/oauth/access_token",
        }
    }

    pub(super) fn scope(self) -> &'static str {
        match self {
            Self::Google => "openid email profile",
            Self::Github => "read:user user:email",
        }
    }
}

fn oauth_credentials_are_complete(client_id: &str, client_secret: &str) -> bool {
    !client_id.trim().is_empty() && !client_secret.trim().is_empty()
}

pub(super) fn oauth_provider_is_configured(provider: OAuthProvider) -> bool {
    let prefix = provider.env_prefix();
    let client_id = std::env::var(format!("KORDI_OAUTH_{prefix}_CLIENT_ID")).unwrap_or_default();
    let client_secret =
        std::env::var(format!("KORDI_OAUTH_{prefix}_CLIENT_SECRET")).unwrap_or_default();
    oauth_credentials_are_complete(&client_id, &client_secret)
}

fn oauth_not_configured_message(provider: OAuthProvider) -> String {
    format!(
        "{} sign-in is not available on this server. Use email and password.",
        provider.display_name()
    )
}

pub(super) struct OAuthConfig {
    pub(super) provider: OAuthProvider,
    pub(super) client_id: String,
    pub(super) client_secret: String,
    pub(super) redirect_uri: String,
}

pub(super) fn oauth_config(provider: OAuthProvider) -> Result<OAuthConfig, String> {
    let prefix = provider.env_prefix();
    let client_id = std::env::var(format!("KORDI_OAUTH_{prefix}_CLIENT_ID")).unwrap_or_default();
    let client_secret =
        std::env::var(format!("KORDI_OAUTH_{prefix}_CLIENT_SECRET")).unwrap_or_default();
    if !oauth_credentials_are_complete(&client_id, &client_secret) {
        return Err(oauth_not_configured_message(provider));
    }
    let public_base = public_base_url();
    Ok(OAuthConfig {
        provider,
        client_id,
        client_secret,
        redirect_uri: format!(
            "{public_base}/v1/cloud/auth/oauth/{}/callback",
            provider.id()
        ),
    })
}

pub(crate) fn public_base_url() -> String {
    std::env::var("KORDI_CLOUD_PUBLIC_BASE_URL")
        .unwrap_or_else(|_| DEFAULT_PUBLIC_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

pub(crate) fn is_allowed_oauth_redirect(target: &str) -> bool {
    let allowlist = std::env::var("KORDI_CLOUD_OAUTH_REDIRECT_ALLOWLIST").ok();
    is_allowed_oauth_redirect_with_config(target, allowlist.as_deref(), &public_base_url())
}

fn is_allowed_oauth_redirect_with_config(
    target: &str,
    allowlist: Option<&str>,
    public_base: &str,
) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return false;
    }

    let Ok(url) = url::Url::parse(trimmed) else {
        return false;
    };
    if is_loopback_http_url(&url) || is_public_base_url(&url, public_base) {
        return true;
    }

    allowlist
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter_map(|allowed| url::Url::parse(allowed).ok())
        .any(|allowed_url| same_origin_or_loopback_prefix(&url, &allowed_url))
}

fn is_loopback_http_url(url: &url::Url) -> bool {
    matches!(url.scheme(), "http")
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
}

fn is_public_base_url(url: &url::Url, public_base: &str) -> bool {
    let Ok(base) = url::Url::parse(public_base) else {
        return false;
    };
    url.scheme() == base.scheme()
        && url.host_str() == base.host_str()
        && url.port_or_known_default() == base.port_or_known_default()
}

fn same_origin_or_loopback_prefix(target: &url::Url, allowed: &url::Url) -> bool {
    if is_loopback_http_url(allowed) && is_loopback_http_url(target) {
        return allowed.port().is_none() || allowed.port() == target.port();
    }
    target.scheme() == allowed.scheme()
        && target.host_str() == allowed.host_str()
        && target.port_or_known_default() == allowed.port_or_known_default()
        && target.path().starts_with(allowed.path())
}

pub(crate) fn random_url_token(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub(super) fn encode_oauth_fragment<T: Serialize>(body: &T) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(body).unwrap_or_default())
}

pub(super) fn redirect_with_oauth_error(redirect_after: &str, message: &str) -> Response {
    Redirect::to(&oauth_error_redirect_url(redirect_after, message, None)).into_response()
}

/// Like [`redirect_with_oauth_error`], adding a stable machine-readable code
/// next to the user-facing message so clients can show localized copy.
pub(super) fn redirect_with_oauth_error_code(
    redirect_after: &str,
    code: &str,
    message: &str,
) -> Response {
    Redirect::to(&oauth_error_redirect_url(
        redirect_after,
        message,
        Some(code),
    ))
    .into_response()
}

fn oauth_error_redirect_url(redirect_after: &str, message: &str, code: Option<&str>) -> String {
    let mut url = redirect_after.to_string();
    let separator = if url.contains('#') { '&' } else { '#' };
    url.push(separator);
    url.push_str("kordi_cloud_oauth_error=");
    url.push_str(&fragment_component(message));
    if let Some(code) = code {
        url.push_str("&kordi_cloud_oauth_error_code=");
        url.push_str(&fragment_component(code));
    }
    url
}

/// Percent-encodes a fragment value. Spaces become `%20` rather than `+`
/// because native URL parsers do not decode `+` in fragments.
fn fragment_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

pub(super) fn clean_profile_display_name(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(80).collect::<String>())
}

pub(super) fn clean_profile_avatar_url(avatar_url: Option<&str>) -> Option<String> {
    let normalized = avatar_url?.trim();
    if normalized.is_empty() || normalized.starts_with(AVATAR_SEED_PREFIX) {
        return None;
    }
    Some(normalized.chars().take(4096).collect::<String>())
}

#[derive(Debug, Clone)]
pub(super) struct OAuthProfile {
    pub(super) provider_subject: String,
    pub(super) username: Option<String>,
    pub(super) display_name: Option<String>,
    pub(super) email: Option<String>,
    pub(super) email_verified: bool,
    pub(super) avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
}

pub(super) async fn exchange_oauth_code(
    client: &reqwest::Client,
    config: &OAuthConfig,
    code: &str,
    code_verifier: Option<&str>,
) -> Result<String, reqwest::Error> {
    let mut form = vec![
        ("client_id", config.client_id.as_str()),
        ("code", code),
        ("redirect_uri", config.redirect_uri.as_str()),
        ("grant_type", "authorization_code"),
        ("client_secret", config.client_secret.as_str()),
    ];
    if let Some(verifier) = code_verifier {
        form.push(("code_verifier", verifier));
    }
    let token = client
        .post(config.provider.token_url())
        .header("accept", "application/json")
        .form(&form)
        .send()
        .await?
        .error_for_status()?
        .json::<OAuthTokenResponse>()
        .await?;
    Ok(token.access_token)
}

pub(super) async fn fetch_oauth_profile(
    client: &reqwest::Client,
    provider: OAuthProvider,
    access_token: &str,
) -> Result<OAuthProfile, reqwest::Error> {
    match provider {
        OAuthProvider::Google => fetch_google_profile(client, access_token).await,
        OAuthProvider::Github => fetch_github_profile(client, access_token).await,
    }
}

async fn fetch_google_profile(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<OAuthProfile, reqwest::Error> {
    let value = client
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(access_token)
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    Ok(OAuthProfile {
        provider_subject: value["sub"].as_str().unwrap_or_default().to_string(),
        username: value["email"].as_str().map(str::to_string),
        display_name: value["name"].as_str().map(str::to_string),
        email: value["email"].as_str().map(str::to_string),
        email_verified: value["email_verified"].as_bool().unwrap_or(false),
        avatar_url: value["picture"].as_str().map(str::to_string),
    })
}

async fn fetch_github_profile(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<OAuthProfile, reqwest::Error> {
    let user = client
        .get("https://api.github.com/user")
        .bearer_auth(access_token)
        .header("user-agent", "kordi-cloud")
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    let emails = client
        .get("https://api.github.com/user/emails")
        .bearer_auth(access_token)
        .header("user-agent", "kordi-cloud")
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    Ok(github_profile_from_values(&user, &emails))
}

fn github_profile_from_values(user: &Value, emails: &Value) -> OAuthProfile {
    let primary_verified_email = emails.as_array().and_then(|items| {
        items.iter().find_map(|item| {
            let primary = item["primary"].as_bool().unwrap_or(false);
            let verified = item["verified"].as_bool().unwrap_or(false);
            let email = item["email"].as_str()?.trim();
            (primary && verified && !email.is_empty()).then(|| email.to_string())
        })
    });
    let email_verified = primary_verified_email.is_some();
    OAuthProfile {
        provider_subject: user["id"].to_string().trim_matches('"').to_string(),
        username: user["login"].as_str().map(str::to_string),
        display_name: user["name"]
            .as_str()
            .or_else(|| user["login"].as_str())
            .map(str::to_string),
        email: primary_verified_email,
        email_verified,
        avatar_url: user["avatar_url"].as_str().map(str::to_string),
    }
}

#[cfg(test)]
mod tests;
