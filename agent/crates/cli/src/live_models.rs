mod concurrent;
use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use anyhow::{Result, bail};
use kordi_core::settings::Settings;
use kordi_provider::registry::{Model, ModelRegistry};
use reqwest::Client;
use serde_json::Value;

use crate::{login, runtime_model};
use concurrent::fetch_authenticated_provider_model_ids;

const LIVE_MODEL_FETCH_TIMEOUT: Duration = Duration::from_secs(4);

fn live_model_client() -> Client {
    Client::builder()
        .timeout(LIVE_MODEL_FETCH_TIMEOUT)
        .build()
        .unwrap_or_else(|_| Client::new())
}

fn openai_compatible_model_client(base_url: &str) -> Client {
    let timeout = if login::is_loopback_base_url(base_url) {
        Duration::from_secs(2)
    } else {
        LIVE_MODEL_FETCH_TIMEOUT
    };
    Client::builder()
        .timeout(timeout)
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// Fetch the provider's live model ids using the currently active auth profile.
///
/// This is intentionally best-effort: callers fall back to the built-in registry when the upstream
/// endpoint is unavailable. ChatGPT/Codex OAuth is not queried because its internal catalog exposes
/// non-runtime slugs such as `gpt-5-5-thinking`; like pi, Kordi uses curated public model ids for
/// that path.
#[allow(dead_code)]
pub async fn fetch_live_model_ids_for_provider(provider: &str) -> Option<Vec<String>> {
    fetch_live_model_ids_for_provider_with_settings(provider, &Settings::default()).await
}

pub async fn fetch_live_model_ids_for_provider_with_settings(
    provider: &str,
    settings: &Settings,
) -> Option<Vec<String>> {
    let normalized = login::normalize_provider_for_model_selection(provider);
    let auth = runtime_model::resolve_provider_auth_with_settings(settings, &normalized);
    let bearer_token = auth
        .as_ref()
        .map(|auth| auth.credential.as_str())
        .unwrap_or_default();
    let base_url_override = runtime_model::provider_override_base_url(settings, &normalized);
    let result = match normalized.as_str() {
        "anthropic" => fetch_anthropic_model_ids(auth.as_ref()?).await,
        "openai"
            if base_url_override.is_none()
                && auth.as_ref().is_some_and(|auth| {
                    matches!(auth.method, login::ProviderAuthMethod::OAuth)
                }) =>
        {
            return None;
        }
        "openai" => {
            fetch_openai_compatible_model_ids(
                base_url_override
                    .as_deref()
                    .unwrap_or("https://api.openai.com/v1"),
                bearer_token,
            )
            .await
        }
        "lm-studio" | "ollama" => {
            fetch_openai_compatible_model_ids(
                base_url_override
                    .as_deref()
                    .or_else(|| login::local_openai_provider_base_url(&normalized))?,
                bearer_token,
            )
            .await
        }
        "google" => fetch_google_model_ids(&auth.as_ref()?.credential).await,
        "groq" => {
            fetch_openai_compatible_model_ids(
                base_url_override
                    .as_deref()
                    .unwrap_or("https://api.groq.com/openai/v1"),
                bearer_token,
            )
            .await
        }
        "xai" => {
            fetch_openai_compatible_model_ids(
                base_url_override
                    .as_deref()
                    .unwrap_or("https://api.x.ai/v1"),
                bearer_token,
            )
            .await
        }
        "openrouter" => {
            fetch_openai_compatible_model_ids(
                base_url_override
                    .as_deref()
                    .unwrap_or("https://openrouter.ai/api/v1"),
                bearer_token,
            )
            .await
        }
        "github-copilot" => Ok(login::github_copilot_cached_models()),
        _ => {
            let base_url = base_url_override?;
            fetch_openai_compatible_model_ids(&base_url, bearer_token).await
        }
    };

    result
        .ok()
        .map(|ids| sanitize_model_ids_for_provider(settings, &normalized, ids))
        .filter(|ids| !ids.is_empty())
}

/// Return the full model registry, augmented with fresh upstream model ids for authenticated
/// providers. Unknown live ids are synthesized from the provider's built-in runtime template so they
/// can be selected immediately without waiting for a hard-coded registry update.
pub async fn model_registry_candidates_with_live(settings: &Settings) -> Vec<Model> {
    let mut registry = ModelRegistry::new();
    registry.load_custom_models(settings);
    login::add_cached_github_copilot_models(&mut registry);

    let mut by_provider = registry.list().iter().cloned().fold(
        BTreeMap::<String, Vec<Model>>::new(),
        |mut map, model| {
            map.entry(model.provider.clone()).or_default().push(model);
            map
        },
    );

    for (provider, live_ids) in fetch_authenticated_provider_model_ids(settings).await {
        let static_models = by_provider.get(&provider).cloned().unwrap_or_default();
        let auth_mode_static_models = login::model_candidates_for_provider_auth_mode(
            &registry,
            settings,
            &provider,
            &static_models,
        );
        if let Some(live_ids) = live_ids {
            by_provider.insert(
                provider.clone(),
                merge_live_model_ids_with_settings(
                    &registry,
                    settings,
                    &provider,
                    &auth_mode_static_models,
                    live_ids,
                ),
            );
        } else if auth_mode_static_models.len() != static_models.len()
            || auth_mode_static_models
                .iter()
                .zip(static_models.iter())
                .any(|(left, right)| left.id != right.id || left.provider != right.provider)
        {
            by_provider.insert(provider.clone(), auth_mode_static_models);
        }
    }

    by_provider.into_values().flatten().collect()
}

/// Return models for authenticated providers only, augmented with live upstream model ids.
#[allow(dead_code)]
pub async fn authenticated_model_candidates_with_live(settings: &Settings) -> Vec<Model> {
    let available = login::authenticated_providers_for_settings(settings);
    if available.is_empty() {
        return Vec::new();
    }

    model_registry_candidates_with_live(settings)
        .await
        .into_iter()
        .filter(|model| available.iter().any(|provider| provider == &model.provider))
        .collect()
}

#[allow(dead_code)]
pub fn merge_live_model_ids(
    registry: &ModelRegistry,
    provider: &str,
    static_models: &[Model],
    live_ids: Vec<String>,
) -> Vec<Model> {
    merge_live_model_ids_with_settings(
        registry,
        &Settings::default(),
        provider,
        static_models,
        live_ids,
    )
}

pub fn merge_live_model_ids_with_settings(
    registry: &ModelRegistry,
    settings: &Settings,
    provider: &str,
    static_models: &[Model],
    live_ids: Vec<String>,
) -> Vec<Model> {
    let case_insensitive_dedup =
        login::normalize_provider_for_model_selection(provider) == "anthropic";
    let dedup_key = |model_id: &str| {
        if case_insensitive_dedup {
            model_id.to_ascii_lowercase()
        } else {
            model_id.to_string()
        }
    };
    let mut seen = HashSet::new();
    let mut merged = Vec::new();

    for model in static_models {
        if seen.insert(dedup_key(&model.id)) {
            merged.push(model.clone());
        }
    }

    for model_id in sanitize_model_ids_for_provider(settings, provider, live_ids) {
        if !seen.insert(dedup_key(&model_id)) {
            continue;
        }
        merged.push(runtime_model::synthesize_model_candidate_with_settings(
            registry, settings, provider, &model_id,
        ));
    }

    merged.sort_by(|left, right| {
        login::model_catalog_rank(provider, &left.id)
            .cmp(&login::model_catalog_rank(provider, &right.id))
            .then_with(|| left.id.cmp(&right.id))
    });
    merged
}

async fn fetch_openai_compatible_model_ids(
    base_url: &str,
    bearer_token: &str,
) -> Result<Vec<String>> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut request = openai_compatible_model_client(base_url)
        .get(url)
        .header("Accept", "application/json");
    if !bearer_token.trim().is_empty() {
        request = request.header("Authorization", format!("Bearer {bearer_token}"));
    }
    let response = request.send().await?;

    if !response.status().is_success() {
        bail!("HTTP {}", response.status());
    }

    let body: Value = response.json().await?;
    Ok(body
        .get("data")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(model_id_from_json_object)
        .collect())
}

async fn fetch_anthropic_model_ids(auth: &login::ResolvedProviderAuth) -> Result<Vec<String>> {
    let mut request = live_model_client()
        .get("https://api.anthropic.com/v1/models")
        .header("anthropic-version", "2023-06-01")
        .header("accept", "application/json")
        .header("anthropic-dangerous-direct-browser-access", "true");

    request = match auth.method {
        login::ProviderAuthMethod::OAuth => request
            .header("Authorization", format!("Bearer {}", auth.credential))
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("user-agent", "claude-cli/2.1.75")
            .header("x-app", "cli"),
        login::ProviderAuthMethod::ApiKey => request.header("x-api-key", auth.credential.clone()),
    };

    let response = request.send().await?;
    if !response.status().is_success() {
        bail!("HTTP {}", response.status());
    }

    let body: Value = response.json().await?;
    Ok(body
        .get("data")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(model_id_from_json_object)
        .collect())
}

async fn fetch_google_model_ids(api_key: &str) -> Result<Vec<String>> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={api_key}");
    let response = live_model_client().get(url).send().await?;
    if !response.status().is_success() {
        bail!("HTTP {}", response.status());
    }

    let body: Value = response.json().await?;
    Ok(body
        .get("models")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter(|item| {
            item.get("supportedGenerationMethods")
                .and_then(|value| value.as_array())
                .map(|methods| {
                    methods.iter().any(|method| {
                        method
                            .as_str()
                            .is_some_and(|value| value.eq_ignore_ascii_case("generateContent"))
                    })
                })
                .unwrap_or(false)
        })
        .filter_map(model_id_from_json_object)
        .collect())
}

fn model_id_from_json_object(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    ["id", "slug", "model", "name"]
        .into_iter()
        .filter_map(|key| object.get(key)?.as_str())
        .map(normalize_model_id)
        .find(|id| is_safe_model_id(id))
}

fn normalize_model_id(value: &str) -> String {
    value.trim().trim_start_matches("models/").to_string()
}

fn sanitize_model_ids(ids: Vec<String>) -> Vec<String> {
    sanitize_model_ids_with(ids, looks_like_model_id)
}

fn sanitize_model_ids_for_provider(
    settings: &Settings,
    provider: &str,
    ids: Vec<String>,
) -> Vec<String> {
    if accepts_arbitrary_safe_live_model_ids(settings, provider) {
        sanitize_model_ids_with(ids, |id| {
            is_safe_model_id(id) && !looks_like_embedding_model_id(id)
        })
    } else {
        sanitize_model_ids(ids)
    }
}

fn sanitize_model_ids_with(ids: Vec<String>, keep: impl Fn(&str) -> bool) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut sanitized = ids
        .into_iter()
        .map(|id| normalize_model_id(&id))
        .filter(|id| keep(id))
        .filter(|id| seen.insert(id.clone()))
        .collect::<Vec<_>>();
    sanitized.sort();
    sanitized
}

fn accepts_arbitrary_safe_live_model_ids(settings: &Settings, provider: &str) -> bool {
    let configured_base_url = runtime_model::provider_override_base_url(settings, provider)
        .or_else(|| login::local_openai_provider_base_url(provider).map(ToString::to_string));
    runtime_model::provider_override_for_settings(settings, provider).is_some()
        || login::provider_allows_no_auth(provider, configured_base_url.as_deref())
}

fn is_safe_model_id(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_whitespace) {
        return false;
    }

    if let Some((prefix, suffix)) = value.rsplit_once('/') {
        return !prefix.is_empty() && !prefix.contains('/') && !suffix.is_empty();
    }

    true
}

fn looks_like_model_id(value: &str) -> bool {
    if !is_safe_model_id(value) || looks_like_embedding_model_id(value) {
        return false;
    }

    let lower = value.trim().to_ascii_lowercase();
    let model_part = if let Some((_, suffix)) = lower.rsplit_once('/') {
        suffix
    } else {
        lower.as_str()
    };

    model_part.starts_with("gpt-")
        || model_part
            .strip_prefix('o')
            .and_then(|rest| rest.chars().next())
            .is_some_and(|ch| ch.is_ascii_digit())
        || model_part.starts_with("chatgpt-")
        || model_part.starts_with("codex-")
        || model_part.starts_with("claude-")
        || model_part.starts_with("gemini-")
        || model_part.starts_with("grok-")
        || model_part.starts_with("llama")
        || model_part.starts_with("mistral")
        || model_part.starts_with("mixtral")
        || model_part.starts_with("qwen")
        || model_part.starts_with("deepseek")
        || model_part.starts_with("gemma")
        || model_part.starts_with("phi")
        || model_part.starts_with("granite")
        || model_part.starts_with("codestral")
        || model_part.starts_with("starcoder")
        || model_part.starts_with("smollm")
}

fn looks_like_embedding_model_id(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    let model_part = if let Some((_, suffix)) = lower.rsplit_once('/') {
        suffix
    } else {
        lower.as_str()
    };

    model_part.contains("embedding")
        || model_part.contains("embed-text")
        || model_part.contains("-embed")
        || model_part.starts_with("text-embedding")
        || model_part.starts_with("embed-")
        || model_part.starts_with("nomic-embed")
        || model_part.starts_with("mxbai-embed")
        || model_part.starts_with("all-minilm")
        || model_part.starts_with("bge-")
        || model_part.starts_with("bge_")
        || model_part.starts_with("paraphrase-")
        || model_part.starts_with("snowflake-arctic-embed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_provider::anthropic::capabilities::ANTHROPIC_SUBSCRIPTION_MODEL_IDS;
    use kordi_provider::registry::ApiType;
    use std::sync::Mutex;

    fn env_lock() -> &'static Mutex<()> {
        crate::login::auth_test_env_lock()
    }

    struct EnvVarGuard {
        key: &'static str,
        old: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set_path(key: &'static str, value: &std::path::Path) -> Self {
            let old = std::env::var_os(key);
            unsafe { std::env::set_var(key, value) };
            Self { key, old }
        }

        fn unset(key: &'static str) -> Self {
            let old = std::env::var_os(key);
            unsafe { std::env::remove_var(key) };
            Self { key, old }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old {
                unsafe { std::env::set_var(self.key, value) };
            } else {
                unsafe { std::env::remove_var(self.key) };
            }
        }
    }

    #[test]
    fn merge_live_model_ids_preserves_static_and_synthesizes_new_ids() {
        let registry = ModelRegistry::new();
        let static_models = registry
            .list()
            .iter()
            .filter(|model| model.provider == "openai" && model.id == "gpt-5.4")
            .cloned()
            .collect::<Vec<_>>();

        let merged = merge_live_model_ids(
            &registry,
            "openai",
            &static_models,
            vec!["gpt-5.4".to_string(), "gpt-5.5".to_string()],
        );

        assert!(merged.iter().any(|model| model.id == "gpt-5.4"));
        let live = merged
            .iter()
            .find(|model| model.id == "gpt-5.5")
            .expect("live model synthesized");
        assert_eq!(live.provider, "openai");
        assert_eq!(live.name, "gpt-5.5");
    }

    #[test]
    fn merge_live_anthropic_models_keeps_curated_order_before_unknown_ids() {
        let registry = ModelRegistry::new();
        let static_models = registry
            .list()
            .iter()
            .filter(|model| model.provider == "anthropic")
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(static_models.len(), ANTHROPIC_SUBSCRIPTION_MODEL_IDS.len());

        let legacy_live_id = "claude-3-5-haiku-20241022";
        let merged = merge_live_model_ids(
            &registry,
            "anthropic",
            &static_models,
            vec![
                "claude-opus-4-8".to_string(),
                "claude-opus-4-8".to_string(),
                "CLAUDE-OPUS-4-8".to_string(),
                "claude-fable-5".to_string(),
                legacy_live_id.to_string(),
                legacy_live_id.to_string(),
            ],
        );
        let merged_ids = merged
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(merged.len(), ANTHROPIC_SUBSCRIPTION_MODEL_IDS.len() + 1);
        assert_eq!(
            &merged_ids[..ANTHROPIC_SUBSCRIPTION_MODEL_IDS.len()],
            ANTHROPIC_SUBSCRIPTION_MODEL_IDS
        );
        assert_eq!(merged_ids.last(), Some(&legacy_live_id));
        let legacy = merged.last().expect("legacy live model synthesized");
        assert_eq!(legacy.provider, "anthropic");
        assert!(matches!(legacy.api, ApiType::AnthropicMessages));
        assert_eq!(
            merged_ids
                .iter()
                .filter(|model_id| model_id.eq_ignore_ascii_case("claude-opus-4-8"))
                .count(),
            1
        );
        assert!(merged_ids.contains(&"claude-opus-4-8"));
    }

    #[test]
    fn anthropic_oauth_live_legacy_model_is_shown_and_selectable() {
        let _lock = env_lock().lock().expect("env lock");
        let home = tempfile::tempdir().expect("home tempdir");
        let _home_guard = EnvVarGuard::set_path("HOME", home.path());
        let _anthropic_api_key = EnvVarGuard::unset("ANTHROPIC_API_KEY");
        let _anthropic_oauth_token = EnvVarGuard::unset("ANTHROPIC_OAUTH_TOKEN");
        let _auth_path = EnvVarGuard::unset("KORDI_AUTH_PATH");
        let _storage_root = EnvVarGuard::unset("KORDI_STORAGE_ROOT");
        let _app_data_dir = EnvVarGuard::unset("APP_DATA_DIR");
        login::save_oauth_credentials(
            "anthropic",
            &crate::oauth::OAuthCredentials {
                access: "anthropic-oauth-access".to_string(),
                refresh: String::new(),
                expires: i64::MAX,
                extra: serde_json::json!({"accountId": "acct_test"}),
            },
        )
        .expect("save Anthropic OAuth");

        let settings = Settings::default();
        let registry = ModelRegistry::new();
        let static_models = registry
            .list()
            .iter()
            .filter(|model| model.provider == "anthropic")
            .cloned()
            .collect::<Vec<_>>();
        let auth_mode_static_models = login::model_candidates_for_provider_auth_mode(
            &registry,
            &settings,
            "anthropic",
            &static_models,
        );
        assert_eq!(
            auth_mode_static_models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ANTHROPIC_SUBSCRIPTION_MODEL_IDS
        );

        let legacy_live_id = "claude-3-7-sonnet-20250219";
        let merged = merge_live_model_ids_with_settings(
            &registry,
            &settings,
            "anthropic",
            &auth_mode_static_models,
            vec![legacy_live_id.to_string()],
        );
        let legacy = merged
            .iter()
            .find(|model| model.id == legacy_live_id)
            .expect("legacy live model shown");
        assert_eq!(legacy.provider, "anthropic");
        assert!(matches!(legacy.api, ApiType::AnthropicMessages));
        assert!(login::model_id_allowed_for_active_auth(
            &settings,
            "anthropic",
            legacy_live_id
        ));
    }

    #[test]
    fn accepts_provider_prefixed_model_ids_from_openai_compatible_catalogs() {
        assert!(looks_like_model_id("openai/gpt-5.5"));
        assert!(looks_like_model_id("anthropic/claude-opus-4-6"));
        assert!(looks_like_model_id("lmstudio-community/Qwen3-4B-Instruct"));
        assert!(looks_like_model_id("llama3.2:latest"));
    }

    #[test]
    fn embedding_model_ids_are_not_chat_model_candidates() {
        assert!(looks_like_embedding_model_id(
            "text-embedding-nomic-embed-text-v1.5"
        ));
        assert!(looks_like_embedding_model_id(
            "nomic-ai/nomic-embed-text-v1.5"
        ));
        assert!(looks_like_embedding_model_id("all-minilm:latest"));
        assert!(looks_like_embedding_model_id("bge-m3:latest"));
        assert!(!looks_like_model_id("text-embedding-3-large"));
    }

    #[test]
    fn model_id_extraction_keeps_safe_local_catalog_ids_for_provider_filtering() {
        let value = serde_json::json!({"id": "NousResearch/Hermes-3-Llama"});
        assert_eq!(
            model_id_from_json_object(&value).as_deref(),
            Some("NousResearch/Hermes-3-Llama")
        );
        assert!(!looks_like_model_id("NousResearch/Hermes-3-Llama"));
    }

    #[test]
    fn merge_live_model_ids_synthesizes_local_providers_without_static_templates() {
        let registry = ModelRegistry::new();
        let merged = merge_live_model_ids(
            &registry,
            "lm-studio",
            &[],
            vec![
                "qwen3-coder-30b".to_string(),
                "NousResearch/Hermes-3-Llama".to_string(),
                "text-embedding-nomic-embed-text-v1.5".to_string(),
            ],
        );

        let model = merged
            .iter()
            .find(|model| model.id == "qwen3-coder-30b")
            .expect("local live model synthesized");
        assert_eq!(model.provider, "lm-studio");
        assert_eq!(model.base_url.as_deref(), Some("http://localhost:1234/v1"));
        assert!(
            merged
                .iter()
                .any(|model| model.id == "NousResearch/Hermes-3-Llama")
        );
        assert!(
            !merged
                .iter()
                .any(|model| model.id == "text-embedding-nomic-embed-text-v1.5")
        );
        assert_eq!(
            merged
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["NousResearch/Hermes-3-Llama", "qwen3-coder-30b"]
        );
    }
}
