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
