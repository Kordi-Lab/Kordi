//! Redaction applied to every piece of evidence before a card build run
//! reads it: addresses, links, keys, ids and paths never reach the model or
//! the stored references.

use std::sync::OnceLock;

use regex::Regex;

fn patterns() -> &'static [(Regex, &'static str)] {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b", "[email]"),
            (r"\bhttps?://\S+", "[link]"),
            (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[ip]"),
            (
                r"\b(?:sk|ghp|gho|ghs|github_pat|glpat|xox[bpae]|AKIA|AIza)[-_A-Za-z0-9]{12,}\b",
                "[secret]",
            ),
            (r"\bBearer\s+[-._~+/A-Za-z0-9]{16,}=*", "Bearer [secret]"),
            // Assignments in env files and shell snippets: `API_KEY=...`.
            (
                r#"\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|PASSWORD))\s*[=:]\s*["']?[^\s"'`]+["']?"#,
                "$1=[secret]",
            ),
            (
                r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b",
                "[id]",
            ),
            (
                r"(?:~|\$HOME|/Users|/home|/root|/Volumes|/private|/var)/[^\s`'\x22)\]>]+",
                "[path]",
            ),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (Regex::new(pattern).expect("valid pattern"), replacement))
        .collect()
    })
}

pub(super) fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for (pattern, replacement) in patterns() {
        out = pattern.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// Collapses whitespace and keeps at most `max` characters.
pub(super) fn squeeze(text: &str, max: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}
