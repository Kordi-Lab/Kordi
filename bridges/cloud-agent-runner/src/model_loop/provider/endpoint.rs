//! Where a hosted provider account is sent, and whether the runner speaks its
//! protocol. Every decision fails closed: an account is never posted to
//! another vendor's endpoint or spoken to in the wrong wire protocol.

use serde_json::Value;

use super::{ModelLoopError, OpenAiApiMode};

pub(super) fn normalize_provider(provider: &str) -> &str {
    match provider.trim().to_ascii_lowercase().as_str() {
        "google-gemini" => "google",
        "openai-codex" | "codex" => "openai",
        _ => provider.trim(),
    }
}

/// Endpoints the runner knows without a `baseUrl` in the snapshot. Any other
/// provider must carry its own `baseUrl`.
fn default_base_url(provider: &str, api_mode: OpenAiApiMode) -> Option<&'static str> {
    if api_mode == OpenAiApiMode::CodexOAuth {
        return Some("https://chatgpt.com/backend-api");
    }
    match provider {
        "anthropic" => Some("https://api.anthropic.com"),
        "google" => Some("https://generativelanguage.googleapis.com"),
        "openai" => Some("https://api.openai.com/v1"),
        "openrouter" => Some("https://openrouter.ai/api/v1"),
        "groq" => Some("https://api.groq.com/openai/v1"),
        "xai" => Some("https://api.x.ai/v1"),
        _ => None,
    }
}

/// The endpoint for a snapshot: its own `baseUrl` when present, else the
/// known endpoint of its provider. The native Anthropic and Google clients add
/// their own version path (`/v1/messages`, `/v1beta/models`), which OMP catalog
/// base URLs may already end in, so that suffix is removed for them.
pub(super) fn base_url_for(
    provider: &str,
    api_mode: OpenAiApiMode,
    payload: &Value,
) -> Result<String, ModelLoopError> {
    let base_url = payload
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| default_base_url(provider, api_mode))
        .ok_or_else(|| {
            ModelLoopError::Provider(format!(
                "Kordi Cloud cannot run {provider} yet: no endpoint is known for it."
            ))
        })?
        .trim_end_matches('/');
    let version_suffixes: &[&str] = match provider {
        "anthropic" => &["/v1"],
        "google" => &["/v1beta", "/v1"],
        _ => &[],
    };
    let base_url = version_suffixes
        .iter()
        .find_map(|suffix| base_url.strip_suffix(suffix))
        .unwrap_or(base_url);
    Ok(base_url.to_string())
}

/// Rejects a snapshot whose OMP `api` kind is not a protocol the runner's
/// client for that provider speaks. Anthropic and Google use their native
/// clients. Every other provider uses the OpenAI client, which always posts
/// to `{baseUrl}/chat/completions` and switches to the Responses API only for
/// GPT-5 models on `api.openai.com`. So `openai-responses` is accepted only
/// for OpenAI and xAI, and OMP's `openrouter` kind only for OpenRouter: those
/// endpoints also serve OpenAI chat completions. Any other provider must be
/// `openai-completions`; one that only offers the Responses API, or an
/// Anthropic-style endpoint, would receive the wrong protocol. An absent
/// `api` keeps the provider's known client.
pub(super) fn ensure_supported_api(
    provider: &str,
    api_mode: OpenAiApiMode,
    payload: &Value,
) -> Result<(), ModelLoopError> {
    let Some(api) = payload
        .get("api")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let supported: &[&str] = match (provider, api_mode) {
        (_, OpenAiApiMode::CodexOAuth) => &["openai-codex-responses"],
        ("anthropic", _) => &["anthropic-messages"],
        ("google", _) => &["google-generative-ai"],
        ("openai" | "xai", _) => &["openai-completions", "openai-responses"],
        ("openrouter", _) => &["openai-completions", "openrouter"],
        _ => &["openai-completions"],
    };
    if supported.contains(&api) {
        return Ok(());
    }
    let named = api.len() <= 64
        && api
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    Err(ModelLoopError::Provider(if named {
        format!("Kordi Cloud cannot run {provider} yet: its {api} API is not supported.")
    } else {
        format!("Kordi Cloud cannot run {provider} yet: its API is not supported.")
    }))
}

/// Rejects a structured credential. Some OMP providers (such as Alibaba token
/// plans or Cloudflare AI Gateway) store a JSON object as the key, which
/// only their own OMP transport can unpack; sending it as a bearer token
/// would leak the whole object to the endpoint and fail anyway.
pub(super) fn ensure_plain_api_key(provider: &str, api_key: &str) -> Result<(), ModelLoopError> {
    let structured = api_key.trim_start().starts_with('{')
        && serde_json::from_str::<Value>(api_key).is_ok_and(|value| value.is_object());
    if structured {
        return Err(ModelLoopError::Provider(format!(
            "Kordi Cloud cannot run {provider} yet: its structured credential is not supported."
        )));
    }
    Ok(())
}

/// Operator switch for self-hosted deployments whose model endpoints are on a
/// private network. When it is off, which is the default, provider requests
/// only reach public internet addresses. When it is on, private and loopback
/// addresses are reachable, but link-local and cloud metadata addresses still
/// are not.
pub const PRIVATE_PROVIDER_ENDPOINTS_ENV: &str = "KORDI_CLOUD_ALLOW_PRIVATE_PROVIDER_ENDPOINTS";

pub(crate) fn private_provider_endpoints_allowed() -> bool {
    crate::config::env_flag_enabled(
        std::env::var(PRIVATE_PROVIDER_ENDPOINTS_ENV)
            .ok()
            .as_deref(),
    )
}

pub(super) const OWNER_LOCAL_ENDPOINT_ERROR: &str =
    "Cloud fallback cannot use owner-local provider endpoints such as localhost or private networks.";

/// Rejects an endpoint the runner must not send an account's credentials to.
/// Without the operator opt-in it must pass the same public-address policy as
/// the web tools: HTTP(S), no embedded credentials, and a public literal
/// address or a multi-label host name. With the opt-in it may also be on a
/// private network, but never link-local or a cloud metadata service. Host
/// names are checked again against every DNS answer when the provider client
/// connects.
pub(super) fn ensure_provider_endpoint_allowed(
    base_url: &str,
    allow_private: bool,
) -> Result<(), ModelLoopError> {
    let allowed = match reqwest::Url::parse(base_url) {
        Ok(url) if allow_private => kordi_tools::validate_private_network_endpoint(&url).is_ok(),
        Ok(url) => kordi_tools::validate_public_endpoint(&url).is_ok(),
        Err(_) => false,
    };
    if allowed {
        Ok(())
    } else {
        Err(ModelLoopError::Provider(
            OWNER_LOCAL_ENDPOINT_ERROR.to_string(),
        ))
    }
}

/// Checks the current DNS answers for an endpoint's host with the address
/// policy that the guarded provider clients apply when they connect. The OMP
/// worker opens provider connections itself and cannot apply that policy, so
/// this check runs before an endpoint is handed to it. It does not cover a
/// name that is rebound after the check, or a redirect the worker follows.
pub(crate) async fn ensure_endpoint_resolves_to_allowed_addresses(
    base_url: &str,
    allow_private: bool,
) -> Result<(), ModelLoopError> {
    let refused = || ModelLoopError::Provider(OWNER_LOCAL_ENDPOINT_ERROR.to_string());
    let url = reqwest::Url::parse(base_url).map_err(|_| refused())?;
    let host = url.host_str().ok_or_else(refused)?;
    let addresses = match host.trim_matches(['[', ']']).parse::<std::net::IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => {
            let port = url.port_or_known_default().unwrap_or(443);
            tokio::net::lookup_host((host, port))
                .await
                .map_err(|error| {
                    ModelLoopError::Provider(format!(
                        "Could not resolve the provider endpoint: {error}"
                    ))
                })?
                .map(|address| address.ip())
                .collect()
        }
    };
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|ip| !kordi_tools::endpoint_address_allowed(*ip, allow_private))
    {
        return Err(refused());
    }
    Ok(())
}
