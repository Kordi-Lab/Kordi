//! Input validation for reactions, comments, and reader identity.

use unicode_segmentation::UnicodeSegmentation;

pub(crate) const MAX_COMMENT_CHARS: usize = 4000;
pub(crate) const MAX_REACTION_CHARS: usize = 16;
pub(crate) const MAX_READER_NAME_CHARS: usize = 40;
pub(crate) const MIN_READER_KEY_LEN: usize = 16;
pub(crate) const MAX_READER_KEY_LEN: usize = 64;

/// `^b\d{1,5}$`.
pub(crate) fn is_valid_block_id(value: &str) -> bool {
    let Some(digits) = value.strip_prefix('b') else {
        return false;
    };
    (1..=5).contains(&digits.len()) && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// One emoji: 1 to 16 characters, a single grapheme, no letters, digits,
/// whitespace, or markup characters.
pub(crate) fn clean_reaction(value: &str) -> Option<String> {
    let value = value.trim();
    let chars = value.chars().count();
    if chars == 0 || chars > MAX_REACTION_CHARS || value.graphemes(true).count() != 1 {
        return None;
    }
    if value.chars().any(|ch| {
        ch.is_alphanumeric() || ch.is_whitespace() || ch.is_control() || "<>&\"'".contains(ch)
    }) {
        return None;
    }
    Some(value.to_string())
}

/// Comment body: 1 to 4000 characters after trimming.
pub(crate) fn clean_body(value: &str) -> Option<String> {
    let value = value.trim();
    let chars = value.chars().count();
    (1..=MAX_COMMENT_CHARS)
        .contains(&chars)
        .then(|| value.to_string())
}

/// Reader name: 1 to 40 characters after trimming, no control characters.
pub(crate) fn clean_reader_name(value: &str) -> Option<String> {
    let value = value.trim();
    let chars = value.chars().count();
    ((1..=MAX_READER_NAME_CHARS).contains(&chars) && !value.chars().any(char::is_control))
        .then(|| value.to_string())
}

/// Reader key: 16 to 64 URL-safe characters (`A-Z a-z 0-9 - _`).
pub(crate) fn is_valid_reader_key(value: &str) -> bool {
    (MIN_READER_KEY_LEN..=MAX_READER_KEY_LEN).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// True when `body` mentions the agent: `@` followed by the agent display
/// name (case-insensitive), or the literal `@agent`.
pub(crate) fn mentions_agent(body: &str, agent_name: Option<&str>) -> bool {
    let lower = body.to_lowercase();
    if lower.contains("@agent") {
        return true;
    }
    agent_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .is_some_and(|name| lower.contains(&format!("@{}", name.to_lowercase())))
}
