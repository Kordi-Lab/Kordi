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

pub(super) fn is_owner_local_provider_endpoint(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return true;
    };
    let Some(host) = url.host_str() else {
        return true;
    };
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".local") || host.ends_with(".localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                ip.is_loopback()
                    || ip.is_private()
                    || ip.is_link_local()
                    || ip.is_unspecified()
                    || ip.is_broadcast()
            }
            std::net::IpAddr::V6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local()
            }
        };
    }
    false
}
