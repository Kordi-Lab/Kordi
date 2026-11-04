//! Provider error text is written into reports that get shared, so it is
//! masked for anything that looks like a credential and kept short.

use std::sync::LazyLock;

use regex::Regex;

/// Longest error text a report keeps, in characters.
pub const MAX_ERROR_CHARS: usize = 300;
const MASK: &str = "[redacted]";

/// (pattern, replacement); `${name}` keeps the named group.
static PATTERNS: LazyLock<Vec<(Regex, String)>> = LazyLock::new(|| {
    [
        // Header or JSON fields that carry a credential, before bare schemes.
        (
            r#"(?i)(?P<field>\b(?:authorization|x-api-key|x-goog-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)"?\s*[:=]\s*"?(?:(?:bearer|basic)\s+)?)[^\s",;&}]{4,}"#,
            format!("${{field}}{MASK}"),
        ),
        // Bare bearer and basic credentials.
        (
            r"(?i)(?P<scheme>\b(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]{8,}",
            format!("${{scheme}}{MASK}"),
        ),
        // Query parameters such as `?key=...` or `&sig=...`.
        (
            r"(?i)(?P<param>[?&](?:key|api_key|apikey|token|access_token|sig|signature|secret)=)[^&\s#]+",
            format!("${{param}}{MASK}"),
        ),
        // Vendor key formats: OpenAI/OpenRouter/Anthropic `sk-...`, Google
        // `AIza...` keys and `ya29.` access tokens, JWTs.
        (r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}", MASK.to_string()),
        (r"\bAIza[0-9A-Za-z_-]{20,}", MASK.to_string()),
        (r"\bya29\.[0-9A-Za-z._-]+", MASK.to_string()),
        (
            r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*",
            MASK.to_string(),
        ),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(pattern).expect("redaction pattern"), replacement))
    .collect()
});

/// Long runs of hex or base64 characters that mix letters and digits.
static OPAQUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9+/_=-]{32,}").expect("opaque token pattern"));

fn looks_secret(token: &str) -> bool {
    let core = token.trim_matches(|c: char| matches!(c, '/' | '-' | '_' | '=' | '+'));
    // A path or URL segment list is not a secret.
    if core.matches('/').count() > 1 {
        return false;
    }
    core.len() >= 32
        && core.bytes().any(|b| b.is_ascii_digit())
        && core.bytes().any(|b| b.is_ascii_alphabetic())
}

/// Replaces anything that looks like a credential with `[redacted]`.
pub fn mask_secrets(text: &str) -> String {
    let mut masked = text.to_string();
    for (pattern, replacement) in PATTERNS.iter() {
        masked = pattern
            .replace_all(&masked, replacement.as_str())
            .into_owned();
    }
    OPAQUE
        .replace_all(&masked, |captures: &regex::Captures| {
            let token = &captures[0];
            if looks_secret(token) {
                MASK.to_string()
            } else {
                token.to_string()
            }
        })
        .into_owned()
}

/// Masked and cut to [`MAX_ERROR_CHARS`], with an ellipsis when cut.
pub fn provider_error(text: &str) -> String {
    let masked = mask_secrets(text);
    if masked.chars().count() <= MAX_ERROR_CHARS {
        return masked;
    }
    let mut cut: String = masked.chars().take(MAX_ERROR_CHARS - 1).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_masked() {
        let cases = [
            (
                "401: Authorization: Bearer abcDEF123456.xyz-_~ rejected",
                "Bearer [redacted] rejected",
            ),
            ("invalid key sk-or-v1-0123456789abcdef", "invalid key [redacted]"),
            ("key sk-proj-AbC_dEf-1234567890", "key [redacted]"),
            ("used sk-ant-api03-abcdefghij", "used [redacted]"),
            (
                "GET https://host.example.test/v1/models?key=AIzaSyA-1234567890abcdefghijk&alt=json",
                "?key=[redacted]&alt=json",
            ),
            ("token ya29.a0AfH6SMBx-yz.123", "token [redacted]"),
            (r#"{"api_key": "plainsecretvalue"}"#, r#""api_key": "[redacted]""#),
            ("x-api-key: abcdefgh1234", "x-api-key: [redacted]"),
            (
                "request 0123456789abcdef0123456789abcdef01 failed",
                "request [redacted] failed",
            ),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl end",
                "jwt [redacted] end",
            ),
        ];
        for (input, expected) in cases {
            let masked = mask_secrets(input);
            assert!(masked.contains(expected), "{input} -> {masked}");
            assert!(!masked.contains("0123456789abcdef0"), "{masked}");
        }
    }

    #[test]
    fn ordinary_error_text_survives() {
        for text in [
            "provider returned 429 Too Many Requests: rate limit exceeded",
            "https://openrouter.ai/api/v1/chat/completions returned 400: model not found",
            "timed out",
            "/v1/cloud/agent-runs/run_1/plan-card returned 409 Conflict: stale_revision",
        ] {
            assert_eq!(mask_secrets(text), text);
        }
    }

    #[test]
    fn long_errors_are_cut_after_masking() {
        let long = format!("Bearer sk-abcdefghijklmnop {}", "é".repeat(500));
        let cut = provider_error(&long);
        assert_eq!(cut.chars().count(), MAX_ERROR_CHARS);
        assert!(cut.ends_with('…'));
        assert!(cut.starts_with("Bearer [redacted]"), "{cut}");
        assert_eq!(provider_error("short"), "short");
    }
}
