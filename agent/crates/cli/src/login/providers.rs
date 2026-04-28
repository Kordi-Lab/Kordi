use std::borrow::Cow;

use super::*;

const KNOWN_PROVIDERS: &[(&str, &str, &str)] = &[
    (
        "anthropic",
        "ANTHROPIC_API_KEY",
        "https://console.anthropic.com/settings/keys",
    ),
    ("openai-codex", "", "https://chatgpt.com/"),
    ("github-copilot", "", "https://github.com/features/copilot"),
    (
        "openai",
        "OPENAI_API_KEY",
        "https://platform.openai.com/api-keys",
    ),
    (
        "lm-studio",
        "LM_STUDIO_API_KEY",
        "https://lmstudio.ai/docs/app/api/endpoints/openai",
    ),
    ("ollama", "OLLAMA_API_KEY", "https://docs.ollama.com/openai"),
    (
        "google",
        "GOOGLE_API_KEY",
        "https://aistudio.google.com/app/apikey",
    ),
    ("groq", "GROQ_API_KEY", "https://console.groq.com/keys"),
    ("xai", "XAI_API_KEY", "https://console.x.ai/"),
    (
        "openrouter",
        "OPENROUTER_API_KEY",
        "https://openrouter.ai/settings/keys",
    ),
];

const OAUTH_PROVIDERS: &[&str] = &["anthropic", "openai-codex", "github-copilot"];

pub fn known_providers() -> &'static [(&'static str, &'static str, &'static str)] {
    KNOWN_PROVIDERS
}

pub fn is_oauth_provider(provider: &str) -> bool {
    OAUTH_PROVIDERS.contains(&provider)
}

pub fn local_openai_provider_base_url(provider: &str) -> Option<&'static str> {
    match normalize_provider_for_model_selection(provider).as_str() {
        "lm-studio" => Some("http://localhost:1234/v1"),
        "ollama" => Some("http://localhost:11434/v1"),
        _ => None,
    }
}

pub fn is_local_openai_provider(provider: &str) -> bool {
    local_openai_provider_base_url(provider).is_some()
}

pub fn is_loopback_base_url(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };

    let host = host.trim_matches(|ch| ch == '[' || ch == ']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

pub fn provider_allows_no_auth(provider: &str, base_url: Option<&str>) -> bool {
    if is_local_openai_provider(provider) {
        return base_url.map(is_loopback_base_url).unwrap_or(true);
    }
    base_url.is_some_and(is_loopback_base_url)
}

pub fn normalize_provider_for_model_selection(provider: &str) -> String {
    match provider {
        "openai-codex" => "openai".to_string(),
        other => other.to_string(),
    }
}

pub fn provider_names_match(left: &str, right: &str) -> bool {
    left == right
        || normalize_provider_for_model_selection(left)
            == normalize_provider_for_model_selection(right)
}

/// Resolve the environment-variable hint and help URL used by both the CLI
/// and TUI login flows.
///
/// Examples:
/// - `provider_meta("google")` => (`"GOOGLE_API_KEY"`, `"https://aistudio.google.com/app/apikey"`)
/// - unknown providers fall back to (`"API_KEY"`, `""`)
pub fn provider_meta(provider: &str) -> (&str, &str) {
    KNOWN_PROVIDERS
        .iter()
        .find(|(name, _, _)| *name == provider)
        .map(|(_, env_var, url)| (*env_var, *url))
        .unwrap_or(("API_KEY", ""))
}

/// Human-readable provider label reused across login prompts, TUI menus, and
/// session status rendering.
///
/// Known providers borrow a static label; unknown providers fall back to the
/// raw provider name without allocating a new `String`.
pub fn provider_display_name(provider: &str) -> Cow<'_, str> {
    match provider {
        "anthropic" => Cow::Borrowed("Claude Pro/Max"),
        "openai-codex" => Cow::Borrowed("ChatGPT Plus/Pro (Codex)"),
        "github-copilot" => Cow::Borrowed("GitHub Copilot"),
        "openai" => Cow::Borrowed("OpenAI"),
        "lm-studio" => Cow::Borrowed("LM Studio"),
        "ollama" => Cow::Borrowed("Ollama"),
        "google" => Cow::Borrowed("Google Gemini"),
        "groq" => Cow::Borrowed("Groq"),
        "xai" => Cow::Borrowed("xAI"),
        "openrouter" => Cow::Borrowed("OpenRouter"),
        _ => Cow::Borrowed(provider),
    }
}

/// Authentication mechanism shown in login menus.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthMethod {
    OAuth,
    ApiKey,
}

impl ProviderAuthMethod {
    pub fn label(self) -> &'static str {
        match self {
            Self::OAuth => "OAuth",
            Self::ApiKey => "API key",
        }
    }

    pub fn footer_label(self) -> &'static str {
        match self {
            Self::OAuth => "oauth",
            Self::ApiKey => "api-key",
        }
    }
}

/// Return the login method used for a provider so callers can format their own
/// UI labels without relying on stringly-typed flags.
pub fn provider_auth_method(provider: &str) -> ProviderAuthMethod {
    if is_oauth_provider(provider) {
        ProviderAuthMethod::OAuth
    } else {
        ProviderAuthMethod::ApiKey
    }
}

/// Explain the non-obvious login behavior for a provider.
///
/// This is intentionally shared between `kordi login` and the TUI auth menus so
/// provider-specific caveats stay consistent in both entry points.
pub fn provider_login_hint(provider: &str) -> String {
    match provider {
        "openai-codex" => {
            "Requires ChatGPT Plus or Pro subscription. Uses browser OAuth, not OpenAI API keys."
                .to_string()
        }
        "anthropic" => {
            "Requires Claude Pro or Max subscription. Uses browser OAuth, not Anthropic API keys."
                .to_string()
        }
        "github-copilot" => {
            let target = github_copilot_domain().unwrap_or_else(|| "github.com".to_string());
            format!(
                "Uses GitHub device/browser auth, then exchanges the GitHub token for a Copilot runtime token. Supports github.com or GitHub Enterprise Server. Current target: {target}."
            )
        }
        "lm-studio" => {
            "Runs against LM Studio's local OpenAI-compatible server at http://localhost:1234/v1. No API key is required unless you enabled one in LM Studio."
                .to_string()
        }
        "ollama" => {
            "Runs against Ollama's local OpenAI-compatible server at http://localhost:11434/v1. No API key is required for the default local server."
                .to_string()
        }
        other => {
            let (env_var, url) = provider_meta(other);
            if url.is_empty() {
                format!("Set {env_var} or paste an API key.")
            } else {
                format!("Get an API key from {url} or set {env_var}.")
            }
        }
    }
}

pub fn provider_oauth_variant(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("anthropic"),
        "openai" | "openai-codex" => Some("openai-codex"),
        "github-copilot" => Some("github-copilot"),
        _ => None,
    }
}

pub fn provider_api_key_variant(provider: &str) -> Option<&'static str> {
    match provider {
        "anthropic" => Some("anthropic"),
        "openai" | "openai-codex" => Some("openai"),
        "lm-studio" => Some("lm-studio"),
        "ollama" => Some("ollama"),
        "google" => Some("google"),
        "groq" => Some("groq"),
        "xai" => Some("xai"),
        "openrouter" => Some("openrouter"),
        _ => None,
    }
}

pub(super) fn get_provider_status(name: &str) -> &'static str {
    if !stored_auth_methods(name).is_empty() {
        return "✓";
    }

    match auth_source(name) {
        Some(AuthSource::EnvVar) => "✓ (env)",
        _ if provider_allows_no_auth(name, local_openai_provider_base_url(name)) => "✓ (local)",
        _ => "✗",
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ProviderAuthMethod, is_local_openai_provider, is_loopback_base_url, is_oauth_provider,
        local_openai_provider_base_url, normalize_provider_for_model_selection,
        provider_allows_no_auth, provider_api_key_variant, provider_auth_method,
        provider_display_name, provider_login_hint, provider_meta, provider_names_match,
        provider_oauth_variant,
    };

    #[test]
    fn provider_meta_returns_known_and_fallback_values() {
        assert_eq!(
            provider_meta("google"),
            ("GOOGLE_API_KEY", "https://aistudio.google.com/app/apikey")
        );
        assert_eq!(provider_meta("unknown-provider"), ("API_KEY", ""));
    }

    #[test]
    fn provider_display_name_covers_known_and_unknown_providers() {
        assert_eq!(provider_display_name("github-copilot"), "GitHub Copilot");
        assert_eq!(
            provider_display_name("openai-codex"),
            "ChatGPT Plus/Pro (Codex)"
        );
        assert_eq!(provider_display_name("lm-studio"), "LM Studio");
        assert_eq!(provider_display_name("ollama"), "Ollama");
        assert_eq!(provider_display_name("custom"), "custom");
    }

    #[test]
    fn oauth_and_api_key_variants_are_reported_consistently() {
        assert!(is_oauth_provider("anthropic"));
        assert!(is_oauth_provider("github-copilot"));
        assert!(!is_oauth_provider("google"));

        assert_eq!(
            provider_auth_method("openai-codex"),
            ProviderAuthMethod::OAuth
        );
        assert_eq!(
            provider_auth_method("openrouter"),
            ProviderAuthMethod::ApiKey
        );
        assert_eq!(provider_auth_method("openrouter").label(), "API key");

        assert_eq!(provider_oauth_variant("openai"), Some("openai-codex"));
        assert_eq!(provider_oauth_variant("google"), None);
        assert_eq!(provider_api_key_variant("openai-codex"), Some("openai"));
        assert_eq!(provider_api_key_variant("lm-studio"), Some("lm-studio"));
        assert_eq!(provider_api_key_variant("ollama"), Some("ollama"));
        assert_eq!(provider_api_key_variant("github-copilot"), None);
    }

    #[test]
    fn provider_login_hints_match_provider_type() {
        let oauth_hint = provider_login_hint("openai-codex");
        assert!(oauth_hint.contains("browser OAuth"));
        assert!(oauth_hint.contains("ChatGPT Plus or Pro"));

        let api_key_hint = provider_login_hint("google");
        assert!(api_key_hint.contains("GOOGLE_API_KEY"));
        assert!(api_key_hint.contains("aistudio.google.com"));

        let local_hint = provider_login_hint("lm-studio");
        assert!(local_hint.contains("localhost:1234"));
        assert!(local_hint.contains("No API key is required"));

        let fallback_hint = provider_login_hint("custom");
        assert_eq!(fallback_hint, "Set API_KEY or paste an API key.");
    }

    #[test]
    fn provider_name_normalization_keeps_model_selection_aliases_stable() {
        assert_eq!(
            normalize_provider_for_model_selection("openai-codex"),
            "openai"
        );
        assert_eq!(
            normalize_provider_for_model_selection("anthropic"),
            "anthropic"
        );
        assert!(provider_names_match("openai", "openai-codex"));
        assert!(provider_names_match("lm-studio", "lm-studio"));
        assert!(!provider_names_match("openai", "lm-studio"));
    }

    #[test]
    fn local_openai_providers_allow_no_auth_on_loopback_endpoints() {
        assert_eq!(
            local_openai_provider_base_url("lm-studio"),
            Some("http://localhost:1234/v1")
        );
        assert_eq!(
            local_openai_provider_base_url("ollama"),
            Some("http://localhost:11434/v1")
        );
        assert!(is_local_openai_provider("lm-studio"));
        assert!(is_loopback_base_url("http://127.0.0.1:8000/v1"));
        assert!(is_loopback_base_url("http://127.0.0.42:8000/v1"));
        assert!(is_loopback_base_url("http://[::1]:1234/v1"));
        assert!(!is_loopback_base_url("file://localhost/v1"));
        assert!(!is_loopback_base_url("http://localhost.evil.example/v1"));
        assert!(!is_loopback_base_url("http://127.0.0.1.evil.example/v1"));
        assert!(provider_allows_no_auth("lm-studio", None));
        assert!(provider_allows_no_auth(
            "lm-studio",
            Some("http://localhost:1234/v1")
        ));
        assert!(!provider_allows_no_auth(
            "lm-studio",
            Some("https://models.example.com/v1")
        ));
        assert!(provider_allows_no_auth(
            "custom-local",
            Some("http://localhost:8000/v1")
        ));
        assert!(!provider_allows_no_auth(
            "custom-remote",
            Some("https://llm.example.com/v1")
        ));
    }
}
