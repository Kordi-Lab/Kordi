/// Every provider ID that names the same saved-account family as `provider`,
/// lowercased, or `None` for a blank provider.
pub(crate) fn equivalent_provider_ids(provider: Option<&str>) -> Option<Vec<String>> {
    let provider = provider?.trim().to_ascii_lowercase();
    if provider.is_empty() {
        return None;
    }
    Some(match provider.as_str() {
        "openai" | "openai-codex" | "codex" => vec![
            "openai".to_string(),
            "openai-codex".to_string(),
            "codex".to_string(),
        ],
        "google" | "google-gemini" => {
            vec!["google".to_string(), "google-gemini".to_string()]
        }
        _ => vec![provider],
    })
}

/// The name people know a provider by, for disclosure copy. Unknown providers
/// show their id.
pub(crate) fn provider_display_label(provider: &str) -> String {
    match provider.trim().to_ascii_lowercase().as_str() {
        "openai" | "openai-codex" | "codex" => "OpenAI".to_string(),
        "anthropic" => "Anthropic".to_string(),
        "google" | "google-gemini" => "Google".to_string(),
        _ => provider.trim().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::provider_display_label;

    #[test]
    fn provider_families_have_one_display_label() {
        for id in ["openai", "openai-codex", "Codex"] {
            assert_eq!(provider_display_label(id), "OpenAI");
        }
        assert_eq!(provider_display_label("anthropic"), "Anthropic");
        assert_eq!(provider_display_label("google-gemini"), "Google");
        assert_eq!(provider_display_label(" mistral "), "mistral");
    }
}
