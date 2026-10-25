//! The provider's own error text, cleaned for display.
//!
//! Provider error bodies can name credentials, accounts, or request IDs. Only
//! the first line is kept, any word that looks like a secret or an identifier
//! is masked, and the result is capped.

const MAX_CHARS: usize = 200;
const MASK: &str = "[hidden]";
/// Credential prefixes are hidden whenever a value follows them.
const SECRET_PREFIXES: [&str; 5] = ["sk-", "rk-", "pk-", "sess-", "eyj"];
/// Account and project prefixes are hidden when an ID with digits follows.
const ID_PREFIXES: [&str; 6] = ["org-", "proj-", "acct_", "acct-", "user-", "user_"];

/// Returns a single safe line, or `None` when nothing displayable remains.
pub fn provider_reason(raw: &str) -> Option<String> {
    let line = raw.lines().find(|line| !line.trim().is_empty())?.trim();
    // "Codex error event: Codex is at capacity…" reads better without the event label.
    let line = match line.find("error event:") {
        Some(index) if index <= 40 => line[index + "error event:".len()..].trim(),
        _ => line,
    };
    let mut words = Vec::new();
    let mut mask_next = false;
    for word in line.split_whitespace() {
        let word: String = word.chars().filter(|ch| !ch.is_control()).collect();
        if word.is_empty() {
            continue;
        }
        if mask_next {
            words.push(MASK.to_string());
            mask_next = false;
            continue;
        }
        if word
            .trim_matches(|ch: char| !ch.is_ascii_alphanumeric())
            .eq_ignore_ascii_case("bearer")
        {
            words.push(word);
            mask_next = true;
            continue;
        }
        words.push(if looks_sensitive(&word) {
            MASK.to_string()
        } else {
            word
        });
    }
    let cleaned = words.join(" ");
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.chars().count() <= MAX_CHARS {
        return Some(cleaned);
    }
    let mut capped: String = cleaned.chars().take(MAX_CHARS).collect();
    capped.push('…');
    Some(capped)
}

fn looks_sensitive(word: &str) -> bool {
    let core = word.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
    let lower = core.to_ascii_lowercase();
    let after = |prefix: &str| lower.strip_prefix(prefix).filter(|rest| rest.len() >= 4);
    if SECRET_PREFIXES.iter().any(|prefix| after(prefix).is_some()) {
        return true;
    }
    if ID_PREFIXES
        .iter()
        .any(|prefix| after(prefix).is_some_and(|rest| rest.chars().any(|ch| ch.is_ascii_digit())))
    {
        return true;
    }
    if core.contains('@')
        && core
            .rsplit('@')
            .next()
            .is_some_and(|domain| domain.contains('.'))
    {
        return true;
    }
    // Long runs mixing letters and digits are keys, tokens, or request IDs.
    word.split(|ch: char| !(ch.is_ascii_alphanumeric() || "-_+/=.".contains(ch)))
        .any(|run| {
            run.len() >= 20
                && run.chars().any(|ch| ch.is_ascii_digit())
                && run.chars().any(|ch| ch.is_ascii_alphabetic())
        })
}

#[cfg(test)]
mod tests {
    use super::provider_reason;

    #[test]
    fn keeps_the_provider_fault() {
        assert_eq!(
            provider_reason(
                "Codex error event: Codex is at capacity, please try again later (code=turn_rate_limit_exceeded)"
            )
            .as_deref(),
            Some("Codex is at capacity, please try again later (code=turn_rate_limit_exceeded)"),
        );
        assert_eq!(
            provider_reason("This model's maximum context length is 128000 tokens.").as_deref(),
            Some("This model's maximum context length is 128000 tokens."),
        );
    }

    #[test]
    fn hides_credentials_accounts_and_ids() {
        let reason = provider_reason(
            "Incorrect API key provided: sk-test12345. Authorization: Bearer abc.def.ghi \
             for org-Xy12ab34Cd user someone@example.com request req_9f8e7d6c5b4a39281706aa",
        )
        .unwrap();
        for secret in [
            "sk-test",
            "abc.def.ghi",
            "org-Xy12",
            "someone@example.com",
            "req_9f8e7d6c",
        ] {
            assert!(!reason.contains(secret), "{secret} leaked in {reason}");
        }
        assert!(reason.starts_with("Incorrect API key provided: [hidden]"));
    }

    #[test]
    fn keeps_ordinary_words_that_share_an_id_prefix() {
        assert_eq!(
            provider_reason("A user-provided tool schema is invalid.").as_deref(),
            Some("A user-provided tool schema is invalid."),
        );
    }

    #[test]
    fn keeps_one_capped_line() {
        assert_eq!(
            provider_reason("first line\nsecond line").as_deref(),
            Some("first line")
        );
        assert_eq!(provider_reason("  \n  ").as_deref(), None);
        let long = "word ".repeat(100);
        let reason = provider_reason(&long).unwrap();
        assert_eq!(reason.chars().count(), 201);
        assert!(reason.ends_with('…'));
    }
}
