//! Shared guards for account memory text.
//!
//! The keyword guard is deliberately narrow. It is a floor that catches
//! obvious sensitive records, not a classifier. The quote guard rejects
//! memories that repeat a long verbatim run from a member who turned off AI
//! use.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

/// Maximum memory length in characters, after normalization.
pub const MEMORY_MAX_CHARS: usize = 500;

/// Number of consecutive words that counts as a verbatim quote.
const QUOTE_WINDOW_WORDS: usize = 12;

/// Collapse all whitespace runs to one space and trim.
pub fn normalize_memory_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryGuardError {
    Empty,
    TooLong { max: usize },
    Sensitive { category: &'static str },
    QuotesProtectedText,
}

impl std::fmt::Display for MemoryGuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(f, "Enter a memory."),
            Self::TooLong { max } => write!(f, "Memories are {max} characters or fewer."),
            Self::Sensitive { category } => write!(
                f,
                "This memory looks like it records {category}. Save a memory about the task instead."
            ),
            Self::QuotesProtectedText => write!(
                f,
                "This memory quotes a member who turned off AI use. Save a memory about the task without quoting them."
            ),
        }
    }
}

impl std::error::Error for MemoryGuardError {}

pub struct MemoryGuardOptions<'a> {
    pub exclude_sensitive: bool,
    pub protected_texts: &'a [String],
}

/// Validate memory text and return its normalized form.
pub fn check_memory_text(
    text: &str,
    options: &MemoryGuardOptions<'_>,
) -> Result<String, MemoryGuardError> {
    let normalized = normalize_memory_text(text);
    if normalized.is_empty() {
        return Err(MemoryGuardError::Empty);
    }
    if normalized.chars().count() > MEMORY_MAX_CHARS {
        return Err(MemoryGuardError::TooLong {
            max: MEMORY_MAX_CHARS,
        });
    }
    if options.exclude_sensitive
        && let Some(category) = sensitive_category(&normalized)
    {
        return Err(MemoryGuardError::Sensitive { category });
    }
    if quotes_protected_text(&normalized, options.protected_texts) {
        return Err(MemoryGuardError::QuotesProtectedText);
    }
    Ok(normalized)
}

const SENSITIVE_TERMS: &[(&str, &[&str])] = &[
    (
        "health details",
        &[
            "diagnosed",
            "diagnosis",
            "prescription",
            "medication",
            "antidepressant",
            "chemotherapy",
            "therapist",
            "pregnant",
            "pregnancy",
            "hiv",
            "sexually transmitted",
            "disability",
            "mental health",
        ],
    ),
    (
        "financial details",
        &[
            "salary",
            "net worth",
            "bank account",
            "account number",
            "routing number",
            "credit card",
            "card number",
            "iban",
            "ssn",
            "social security",
            "tax id",
        ],
    ),
    (
        "credentials",
        &[
            "password",
            "passcode",
            "api key",
            "secret key",
            "access token",
            "private key",
            "seed phrase",
            "otp",
        ],
    ),
    (
        "relationship or identity details",
        &[
            "divorce",
            "divorced",
            "affair",
            "sexual orientation",
            "gay",
            "lesbian",
            "bisexual",
            "transgender",
            "religion",
            "religious",
            "ethnicity",
            "immigration status",
            "undocumented",
            "political party",
            "voted for",
        ],
    ),
];

const SENSITIVE_PATTERNS: &[(&str, &str)] = &[
    ("financial details", r"\b\d(?:[ -]?\d){12,18}\b"),
    ("credentials", r"sk-[A-Za-z0-9]{8,}"),
    ("credentials", r"ghp_[A-Za-z0-9]{8,}"),
    ("credentials", r"AKIA[A-Z0-9]{12,}"),
    ("credentials", r"-----BEGIN"),
];

fn sensitive_matchers() -> &'static [(&'static str, Regex)] {
    static MATCHERS: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    MATCHERS.get_or_init(|| {
        let mut matchers = Vec::new();
        for (category, terms) in SENSITIVE_TERMS {
            let alternatives = terms
                .iter()
                .map(|term| regex::escape(term).replace(' ', r"\s+"))
                .collect::<Vec<_>>()
                .join("|");
            let pattern = format!(r"(?i)\b(?:{alternatives})\b");
            matchers.push((
                *category,
                Regex::new(&pattern).expect("valid keyword regex"),
            ));
        }
        for (category, pattern) in SENSITIVE_PATTERNS {
            matchers.push((*category, Regex::new(pattern).expect("valid pattern regex")));
        }
        matchers
    })
}

fn sensitive_category(text: &str) -> Option<&'static str> {
    sensitive_matchers()
        .iter()
        .find(|(_, regex)| regex.is_match(text))
        .map(|(category, _)| *category)
}

fn quote_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            word.trim_matches(|ch: char| !ch.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

fn quotes_protected_text(text: &str, protected_texts: &[String]) -> bool {
    if protected_texts.is_empty() {
        return false;
    }
    let memory_words = quote_words(text);
    if memory_words.len() < QUOTE_WINDOW_WORDS {
        return false;
    }
    let mut protected_windows: HashSet<&[String]> = HashSet::new();
    let protected_words = protected_texts
        .iter()
        .map(|text| quote_words(text))
        .collect::<Vec<_>>();
    for words in &protected_words {
        for window in words.windows(QUOTE_WINDOW_WORDS) {
            protected_windows.insert(window);
        }
    }
    memory_words
        .windows(QUOTE_WINDOW_WORDS)
        .any(|window| protected_windows.contains(window))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(text: &str) -> Result<String, MemoryGuardError> {
        check_memory_text(
            text,
            &MemoryGuardOptions {
                exclude_sensitive: true,
                protected_texts: &[],
            },
        )
    }

    fn check_protected(text: &str, protected: &[String]) -> Result<String, MemoryGuardError> {
        check_memory_text(
            text,
            &MemoryGuardOptions {
                exclude_sensitive: true,
                protected_texts: protected,
            },
        )
    }

    #[test]
    fn normalizes_whitespace() {
        assert_eq!(normalize_memory_text("  a \n\t b   c  "), "a b c");
        assert_eq!(
            check("  Use   the\nstaging  branch ").unwrap(),
            "Use the staging branch"
        );
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(check(" \n\t "), Err(MemoryGuardError::Empty));
        assert_eq!(MemoryGuardError::Empty.to_string(), "Enter a memory.");
    }

    #[test]
    fn enforces_length_limit() {
        assert!(check(&"a".repeat(500)).is_ok());
        let err = check(&"a".repeat(501)).unwrap_err();
        assert_eq!(err, MemoryGuardError::TooLong { max: 500 });
        assert_eq!(err.to_string(), "Memories are 500 characters or fewer.");
    }

    #[test]
    fn rejects_one_hit_per_category() {
        let cases = [
            ("Remember my password is hunter2", "credentials"),
            ("Priya was diagnosed with asthma", "health details"),
            ("Card number 4111 1111 1111 1111", "financial details"),
            ("Use 4111-1111-1111-1111 for checkout", "financial details"),
            ("Deploy key is sk-abcdef123456", "credentials"),
            (
                "He voted for the green party",
                "relationship or identity details",
            ),
        ];
        for (text, category) in cases {
            let err = check(text).unwrap_err();
            assert_eq!(err, MemoryGuardError::Sensitive { category }, "{text}");
            assert!(err.to_string().contains(category));
        }
    }

    #[test]
    fn benign_memories_pass() {
        assert!(check("Track key results in the weekly doc").is_ok());
        assert!(check("Include account manager context in summaries").is_ok());
        assert!(check("Order 12345 shipped on Monday").is_ok());
    }

    #[test]
    fn keyword_guard_can_be_disabled() {
        let result = check_memory_text(
            "Remember my password is hunter2",
            &MemoryGuardOptions {
                exclude_sensitive: false,
                protected_texts: &[],
            },
        );
        assert_eq!(result.unwrap(), "Remember my password is hunter2");
    }

    const PROTECTED: &str = "I think we should move the launch to next Thursday because the vendor contract is still unsigned and legal wants more time.";

    #[test]
    fn rejects_twelve_word_quote() {
        let protected = vec![PROTECTED.to_string()];
        let memory =
            "Note: move the launch to next Thursday because the vendor contract is still unsigned";
        assert_eq!(
            check_protected(memory, &protected),
            Err(MemoryGuardError::QuotesProtectedText)
        );
    }

    #[test]
    fn eleven_word_quote_passes() {
        let protected = vec![PROTECTED.to_string()];
        let memory =
            "Note: move the launch to next Thursday because the vendor contract is pending";
        assert!(check_protected(memory, &protected).is_ok());
    }

    #[test]
    fn punctuation_and_case_do_not_defeat_quote_guard() {
        let protected = vec![PROTECTED.to_string()];
        let memory = "MOVE the Launch, to next thursday; because THE vendor contract is still \"unsigned\" and";
        assert_eq!(
            check_protected(memory, &protected),
            Err(MemoryGuardError::QuotesProtectedText)
        );
    }
}
