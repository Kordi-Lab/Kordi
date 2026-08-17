pub(super) fn equivalent_provider_ids(provider: Option<&str>) -> Option<Vec<String>> {
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

pub(super) fn canonical_provider_id(provider: &str) -> String {
    let provider = provider.trim().to_ascii_lowercase();
    match provider.as_str() {
        "openai" | "openai-codex" | "codex" => "openai".to_string(),
        "google" | "google-gemini" => "google".to_string(),
        _ => provider,
    }
}
