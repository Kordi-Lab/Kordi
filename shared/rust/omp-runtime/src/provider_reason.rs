//! The provider's own error text, cleaned for display.
//!
//! Provider error bodies can name credentials, accounts, or request IDs. Only
//! the first line is kept, any word that looks like a secret or an identifier
//! is masked, and the result is capped.

const MAX_CHARS: usize = 200;
const MASK: &str = "[hidden]";
/// Credential prefixes are hidden whenever a value follows them.
const SECRET_PREFIXES: [&str; 9] = [
    "sk-", "sk_", "rk-", "rk_", "pk-", "pk_", "sess-", "sess_", "eyj",
];
/// Account and project prefixes are hidden when an id follows: one with digits, or a long one.
const ID_PREFIXES: [&str; 8] = [
    "org-", "org_", "proj-", "proj_", "acct-", "acct_", "user-", "user_",
];
/// The value after one of these labels is hidden: `api_key=…`, `token: …`.
const SECRET_LABELS: [&str; 9] = [
    "key",
    "apikey",
    "token",
    "secret",
    "password",
    "authorization",
    "session",
    "cookie",
    "credential",
];

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
            // "Authorization: Bearer <token>" hides the token, not the scheme.
            let scheme = word.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
            if scheme.eq_ignore_ascii_case("bearer") {
                words.push(word);
                continue;
            }
            words.push(MASK.to_string());
            mask_next = false;
            continue;
        }
        let (cleaned, hide_next) = clean_word(&word);
        words.push(cleaned);
        mask_next = hide_next;
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

/// The word as shown, and whether the next word is a secret value.
fn clean_word(word: &str) -> (String, bool) {
    let lower = word
        .trim_matches(|ch: char| !ch.is_ascii_alphanumeric())
        .to_ascii_lowercase();
    if lower.ends_with("bearer") {
        return (word.to_string(), true);
    }
    if let Some(split) = word.find(['=', ':']) {
        let (label, value) = (&word[..split], &word[split + 1..]);
        if is_secret_label(label) {
            let value_core = value.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
            if value_core.is_empty() {
                return (word.to_string(), true);
            }
            if value_core.eq_ignore_ascii_case("bearer") {
                return (word.to_string(), true);
            }
            return (format!("{}{MASK}", &word[..=split]), false);
        }
    }
    if looks_sensitive(word) {
        (MASK.to_string(), false)
    } else {
        (word.to_string(), false)
    }
}

fn is_secret_label(label: &str) -> bool {
    let label = label
        .trim_matches(|ch: char| !ch.is_ascii_alphanumeric())
        .to_ascii_lowercase();
    SECRET_LABELS.iter().any(|secret| {
        label == *secret
            || label.ends_with(&format!("_{secret}"))
            || label.ends_with(&format!("-{secret}"))
    })
}

fn looks_sensitive(word: &str) -> bool {
    let core = word.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
    let lower = core.to_ascii_lowercase();
    let after = |prefix: &str| lower.strip_prefix(prefix).filter(|rest| rest.len() >= 4);
    if SECRET_PREFIXES.iter().any(|prefix| after(prefix).is_some()) {
        return true;
    }
    if ID_PREFIXES.iter().any(|prefix| {
        after(prefix)
            .is_some_and(|rest| rest.len() >= 16 || rest.chars().any(|ch| ch.is_ascii_digit()))
    }) {
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
    if is_uuid(core) || is_ipv4(core) {
        return true;
    }
    // Long numbers are account or project numbers; token counts stay readable.
    if core
        .split(|ch: char| !ch.is_ascii_digit())
        .any(|run| run.len() >= 9)
    {
        return true;
    }
    // Keys, tokens, and request IDs mix letters and digits; model names split at '-' and '.'.
    word.split(|ch: char| !(ch.is_ascii_alphanumeric() || "_+=".contains(ch)))
        .any(|run| {
            run.len() >= 32
                || (run.len() >= 12
                    && run.chars().any(|ch| ch.is_ascii_digit())
                    && run.chars().any(|ch| ch.is_ascii_alphabetic()))
        })
}

fn is_uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.chars().all(|ch| ch.is_ascii_hexdigit()))
}

fn is_ipv4(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 3 && part.chars().all(|ch| ch.is_ascii_digit())
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
    fn hides_labelled_values_glued_bearers_and_long_ids() {
        let reason = provider_reason(
            "Authorization:Bearer ab12cd34 api_key=ab12cd token: zz99 sess_ab12cd34 sk_live_abcdefgh \
             org-AbCdEfGhIjKlMnOpQrStUvWx ab12cd34ef56:gh78ij90kl12 project 123456789012 from 10.0.0.12 \
             id 123e4567-e89b-12d3-a456-426614174000",
        )
        .unwrap();
        for secret in [
            "ab12cd34",
            "api_key=ab12cd",
            "zz99",
            "sess_ab12",
            "sk_live",
            "AbCdEfGh",
            "gh78ij90",
            "123456789012",
            "10.0.0.12",
            "123e4567",
        ] {
            assert!(!reason.contains(secret), "{secret} leaked in {reason}");
        }
        assert!(
            reason.starts_with("Authorization:Bearer [hidden] api_key=[hidden] token: [hidden]")
        );
    }

    #[test]
    fn keeps_model_names_counts_and_codes_readable() {
        let text = "Rate limit reached for openai/gpt-4o-mini-2024-07-18 on tokens per min: Limit 30000, Used 28401, Requested 3000 (code=rate_limit_exceeded)";
        assert_eq!(provider_reason(text).as_deref(), Some(text));
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
