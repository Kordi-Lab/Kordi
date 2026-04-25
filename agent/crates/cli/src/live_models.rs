use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use anyhow::{Result, bail};
use kordi_core::settings::Settings;
use kordi_provider::registry::{Model, ModelRegistry};
use reqwest::Client;
use serde_json::Value;

use crate::{login, runtime_model};

const LIVE_MODEL_FETCH_TIMEOUT: Duration = Duration::from_secs(8);

fn live_model_client() -> Client {
    Client::builder()
        .timeout(LIVE_MODEL_FETCH_TIMEOUT)
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// Fetch the provider's live model ids using the currently active auth profile.
///
/// This is intentionally best-effort: callers fall back to the built-in registry when the upstream
/// endpoint is unavailable. ChatGPT/Codex OAuth is not queried because its internal catalog exposes
/// non-runtime slugs such as `gpt-5-5-thinking`; like pi, Kordi uses curated public model ids for
/// that path.
pub async fn fetch_live_model_ids_for_provider(provider: &str) -> Option<Vec<String>> {
    let normalized = login::normalize_provider_for_model_selection(provider);
    let auth = login::resolve_provider_auth(&normalized)?;
    let result = match normalized.as_str() {
        "anthropic" => fetch_anthropic_model_ids(&auth).await,
        "openai" if matches!(auth.method, login::ProviderAuthMethod::OAuth) => return None,
        "openai" => {
            fetch_openai_compatible_model_ids("https://api.openai.com/v1", &auth.credential).await
        }
        "google" => fetch_google_model_ids(&auth.credential).await,
        "groq" => {
            fetch_openai_compatible_model_ids("https://api.groq.com/openai/v1", &auth.credential)
                .await
        }
        "xai" => fetch_openai_compatible_model_ids("https://api.x.ai/v1", &auth.credential).await,
        "openrouter" => {
            fetch_openai_compatible_model_ids("https://openrouter.ai/api/v1", &auth.credential)
                .await
        }
        "github-copilot" => Ok(login::github_copilot_cached_models()),
        _ => return None,
    };

    result
        .ok()
        .map(sanitize_model_ids)
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

    for provider in login::authenticated_providers() {
        let static_models = by_provider.get(&provider).cloned().unwrap_or_default();
        if static_models.is_empty() {
            continue;
        }
        if let Some(live_ids) = fetch_live_model_ids_for_provider(&provider).await {
            by_provider.insert(
                provider.clone(),
                merge_live_model_ids(&registry, &provider, &static_models, live_ids),
            );
        }
    }

    by_provider.into_values().flatten().collect()
}

/// Return models for authenticated providers only, augmented with live upstream model ids.
#[allow(dead_code)]
pub async fn authenticated_model_candidates_with_live(settings: &Settings) -> Vec<Model> {
    let available = login::authenticated_providers();
    if available.is_empty() {
        return Vec::new();
    }

    model_registry_candidates_with_live(settings)
        .await
        .into_iter()
        .filter(|model| available.iter().any(|provider| provider == &model.provider))
        .collect()
}

pub fn merge_live_model_ids(
    registry: &ModelRegistry,
    provider: &str,
    static_models: &[Model],
    live_ids: Vec<String>,
) -> Vec<Model> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();

    for model in static_models {
        if seen.insert(model.id.clone()) {
            merged.push(model.clone());
        }
    }

    for model_id in sanitize_model_ids(live_ids) {
        if !seen.insert(model_id.clone()) {
            continue;
        }
        merged.push(runtime_model::synthesize_model_candidate(
            registry, provider, &model_id,
        ));
    }

    merged.sort_by(|left, right| left.id.cmp(&right.id));
    merged
}

async fn fetch_openai_compatible_model_ids(
    base_url: &str,
    bearer_token: &str,
) -> Result<Vec<String>> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let response = live_model_client()
        .get(url)
        .header("Authorization", format!("Bearer {bearer_token}"))
        .header("Accept", "application/json")
        .send()
        .await?;

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
        .find(|id| looks_like_model_id(id))
}

fn normalize_model_id(value: &str) -> String {
    value.trim().trim_start_matches("models/").to_string()
}

fn sanitize_model_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut sanitized = ids
        .into_iter()
        .map(|id| normalize_model_id(&id))
        .filter(|id| looks_like_model_id(id))
        .filter(|id| seen.insert(id.clone()))
        .collect::<Vec<_>>();
    sanitized.sort();
    sanitized
}

fn looks_like_model_id(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_whitespace) {
        return false;
    }

    let lower = value.to_ascii_lowercase();
    let model_part = if let Some((prefix, suffix)) = lower.rsplit_once('/') {
        if prefix.is_empty() || prefix.contains('/') || suffix.is_empty() {
            return false;
        }
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn accepts_provider_prefixed_model_ids_from_openai_compatible_catalogs() {
        assert!(looks_like_model_id("openai/gpt-5.5"));
        assert!(looks_like_model_id("anthropic/claude-opus-4-6"));
    }
}
