use kordi_core::error::{KordiError, KordiResult};

use super::{WebSearchInput, normalize_domain};

pub(super) fn validate_input(input: &WebSearchInput) -> KordiResult<()> {
    if input.query.trim().is_empty() {
        return Err(KordiError::Tool("web_search query must be non-empty".into()));
    }

    let has_allowed = input
        .allowed_domains
        .as_ref()
        .map(|domains| {
            domains
                .iter()
                .any(|domain| !normalize_domain(domain).is_empty())
        })
        .unwrap_or(false);
    let has_blocked = input
        .blocked_domains
        .as_ref()
        .map(|domains| {
            domains
                .iter()
                .any(|domain| !normalize_domain(domain).is_empty())
        })
        .unwrap_or(false);

    if has_allowed && has_blocked {
        return Err(KordiError::Tool(
            "web_search cannot use both allowed_domains and blocked_domains".into(),
        ));
    }
    Ok(())
}
