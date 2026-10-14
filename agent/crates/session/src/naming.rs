//! Shared, deterministic session-title policy.
//!
//! Titles are deliberately generated without a provider call so naming never
//! blocks a turn or creates another authentication dependency.  The same
//! policy is mirrored by the desktop optimistic UI and covered by equivalent
//! fixtures there.

use unicode_segmentation::UnicodeSegmentation;

pub const SESSION_TITLE_POLICY_VERSION: i64 = 1;
pub const MAX_SESSION_TITLE_GRAPHEMES: usize = 48;
const MAX_SESSION_TITLE_WORDS: usize = 8;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SessionTitleSource {
    #[default]
    Placeholder,
    Auto,
    Imported,
    External,
    Legacy,
    Manual,
}

impl SessionTitleSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Placeholder => "placeholder",
            Self::Auto => "auto",
            Self::Imported => "imported",
            Self::External => "external",
            Self::Legacy => "legacy",
            Self::Manual => "manual",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" => Self::Auto,
            "imported" => Self::Imported,
            "external" => Self::External,
            "legacy" => Self::Legacy,
            "manual" => Self::Manual,
            _ => Self::Placeholder,
        }
    }

    pub fn precedence(self) -> u8 {
        match self {
            Self::Placeholder => 0,
            Self::Auto => 1,
            Self::Legacy => 2,
            Self::Imported | Self::External => 3,
            Self::Manual => 4,
        }
    }

    pub fn can_be_replaced_by(self, incoming: Self) -> bool {
        incoming.precedence() >= self.precedence()
    }
}

fn is_url_or_path_token(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("www.")
        || token.starts_with("./")
        || token.starts_with("../")
        || token.starts_with("~/")
        || (token.starts_with('/') && token.len() > 1)
        || (token.len() > 2
            && token.as_bytes().get(1) == Some(&b':')
            && matches!(token.as_bytes().get(2), Some(b'\\') | Some(b'/')))
}

fn trim_title_punctuation(value: &str) -> &str {
    value.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '.' | ','
                    | ':'
                    | ';'
                    | '!'
                    | '?'
                    | '。'
                    | '，'
                    | '：'
                    | '；'
                    | '！'
                    | '？'
                    | '-'
                    | '_'
                    | '"'
                    | '\''
                    | '`'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
            )
    })
}

fn remove_reply_and_code_context(value: &str) -> String {
    let mut in_code_fence = false;
    value
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_code_fence = !in_code_fence;
                return None;
            }
            if in_code_fence
                || trimmed.starts_with('>')
                || trimmed.to_ascii_lowercase().starts_with("replying to:")
                || trimmed.to_ascii_lowercase().starts_with("quoted message:")
            {
                return None;
            }
            Some(trimmed)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn remove_command_mentions_and_transport_noise(value: &str) -> String {
    let mut tokens = value.split_whitespace().peekable();
    if tokens.peek().is_some_and(|token| token.starts_with('/')) {
        tokens.next();
    }
    while tokens.peek().is_some_and(|token| token.starts_with('@')) {
        tokens.next();
    }

    let mut cleaned = Vec::new();
    let mut inside_attachment = false;
    let mut skip_attachment_value = false;
    for token in tokens {
        let lower = token.to_ascii_lowercase();
        if inside_attachment {
            if token.ends_with(']') {
                inside_attachment = false;
            }
            continue;
        }
        if lower.starts_with("[attachment:") {
            inside_attachment = !token.ends_with(']');
            continue;
        }
        if skip_attachment_value {
            skip_attachment_value = false;
            continue;
        }
        if lower == "attachment:" || lower == "attached" {
            skip_attachment_value = true;
            continue;
        }
        if !is_url_or_path_token(token) {
            cleaned.push(token);
        }
    }
    cleaned.join(" ")
}

fn normalized_information_probe(value: &str) -> String {
    trim_title_punctuation(value)
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_attachment_boilerplate(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    let word_count = trimmed.split_whitespace().count();
    (lower.starts_with("attached ") || lower.starts_with("attachment:")) && word_count <= 3
}

pub fn is_low_information_session_seed(value: &str) -> bool {
    let probe = normalized_information_probe(value);
    if probe.is_empty() || probe.chars().all(|character| character.is_numeric()) {
        return true;
    }
    if !probe.chars().any(char::is_alphanumeric) {
        return true;
    }

    matches!(
        probe.as_str(),
        "hi" | "hii"
            | "hiii"
            | "hiiii"
            | "hello"
            | "helloo"
            | "hey"
            | "heyy"
            | "yo"
            | "sup"
            | "test"
            | "testing"
            | "testmessage"
            | "testreply"
            | "ok"
            | "okay"
            | "k"
            | "yes"
            | "yep"
            | "sure"
            | "thanks"
            | "thankyou"
            | "gotit"
            | "kordi"
            | "mykordi"
            | "myagent"
            | "newchat"
            | "newsession"
            | "voicemessage"
            | "\u{4F60}\u{597D}"
            | "\u{60A8}\u{597D}"
            | "\u{55E8}"
            | "\u{6D4B}\u{8BD5}"
            | "\u{6536}\u{5230}"
            | "\u{597D}\u{7684}"
            | "\u{8C22}\u{8C22}"
            | "hithere"
            | "hellothere"
            | "howareyou"
            | "hihowareyou"
            | "hellohowareyou"
            | "howcanihelp"
            | "hihowcanihelp"
            | "hellohowcanihelp"
            | "\u{4F60}\u{597D}\u{5417}"
            | "\u{4F60}\u{597D}\u{55CE}"
    ) || ["test", "testreply", "testmessage"].iter().any(|prefix| {
        probe
            .strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(char::is_numeric))
    })
}

fn semantic_known_title(value: &str) -> Option<&'static str> {
    let lower = value.to_lowercase();
    if lower.contains('\u{6A21}')
        && lower.contains("\u{6A21}\u{578B}")
        && (lower.contains('\u{8C01}')
            || lower.contains("\u{8EAB}\u{4EFD}")
            || lower.contains("\u{4F60}\u{662F}"))
    {
        return Some("\u{6A21}\u{578B}\u{4E0E}\u{8EAB}\u{4EFD}");
    }
    if lower.contains("model")
        && (lower.contains("who are you")
            || lower.contains("which model")
            || lower.contains("what model")
            || lower.contains("identity"))
    {
        return Some("Model and identity");
    }
    if lower.contains("node") && lower.contains("cpu") && lower.contains("diagnos") {
        return Some("Diagnose high Node CPU");
    }
    None
}

/// Legacy rows did not record whether their title was generated or manually
/// entered. Keep the migration conservative, but recognize the old values we
/// can prove came from weak/transport content or that the current policy maps
/// to a dedicated semantic title.
pub fn is_known_legacy_auto_title(value: &str) -> bool {
    let trimmed = value.trim();
    is_low_information_session_seed(trimmed)
        || is_attachment_boilerplate(trimmed)
        || is_dated_fallback_session_title(trimmed)
        || semantic_known_title(trimmed).is_some_and(|title| !title.eq_ignore_ascii_case(trimmed))
}

/// Older desktop builds displayed `Chat with Kordi · <date>` for a session
/// whose runtime history had no title seed, and that value could be mirrored
/// into other stores. It never describes the conversation, so it is treated
/// as a generated placeholder that a derived title may replace.
fn is_dated_fallback_session_title(value: &str) -> bool {
    let Some(suffix) = value.trim().strip_prefix("Chat with Kordi · ") else {
        return false;
    };
    let suffix = suffix.trim();
    if suffix == "recently" {
        return true;
    }
    let mut parts = suffix.split(' ');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(month), Some(day), None)
            if month.len() == 3
                && month.chars().all(|character| character.is_ascii_alphabetic())
                && (1..=2).contains(&day.len())
                && day.chars().all(|character| character.is_ascii_digit())
    )
}

/// Voice messages reach the agent with a provenance header. Only the spoken
/// transcript may name a session; a message without a transcript has no seed.
fn without_voice_provenance(value: &str) -> Option<&str> {
    let trimmed = value.trim_start();
    if trimmed.starts_with("[Voice message:") {
        return None;
    }
    match trimmed.strip_prefix("[Voice transcript;") {
        Some(rest) => Some(
            rest.split_once(']')
                .map_or("", |(_, transcript)| transcript),
        ),
        None => Some(value),
    }
}

pub fn truncate_session_title(value: &str) -> String {
    let graphemes = UnicodeSegmentation::graphemes(value, true).collect::<Vec<_>>();
    if graphemes.len() <= MAX_SESSION_TITLE_GRAPHEMES {
        return value.to_string();
    }
    let keep = MAX_SESSION_TITLE_GRAPHEMES.saturating_sub(1);
    format!("{}…", graphemes[..keep].concat())
}

fn capitalize_first_ascii(value: &str) -> String {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    if first.is_ascii_lowercase() {
        format!(
            "{}{}",
            first.to_ascii_uppercase(),
            chars.collect::<String>()
        )
    } else {
        value.to_string()
    }
}

/// Derive a stable local title from meaningful user-authored text.
pub fn derive_session_title(value: &str) -> Option<String> {
    let without_context = remove_reply_and_code_context(without_voice_provenance(value)?);
    if is_attachment_boilerplate(&without_context) {
        return None;
    }
    let cleaned = remove_command_mentions_and_transport_noise(&without_context);
    let cleaned = trim_title_punctuation(&cleaned);
    if is_low_information_session_seed(cleaned) {
        return None;
    }
    if let Some(title) = semantic_known_title(cleaned) {
        return Some(title.to_string());
    }

    let mut words = cleaned.split_whitespace().filter(|word| !word.is_empty());
    while words.clone().next().is_some_and(|word| {
        matches!(
            word.to_ascii_lowercase().as_str(),
            "please" | "help" | "hey" | "hello"
        )
    }) {
        words.next();
    }
    let concise = words
        .take(MAX_SESSION_TITLE_WORDS)
        .collect::<Vec<_>>()
        .join(" ");
    let concise = trim_title_punctuation(&concise);
    if concise.is_empty() || is_low_information_session_seed(concise) {
        return None;
    }
    Some(truncate_session_title(&capitalize_first_ascii(concise)))
}

pub fn attachment_session_title(attachment_count: usize, contains_image: bool) -> Option<String> {
    match (attachment_count, contains_image) {
        (0, _) => None,
        (1, true) => Some("Image attachment".to_string()),
        (1, false) => Some("File attachment".to_string()),
        (count, _) => Some(format!("{count} attachments")),
    }
}

pub fn is_raw_session_identifier(value: &str, session_id: &str) -> bool {
    let trimmed = value.trim();
    trimmed == session_id
        || trimmed.to_ascii_lowercase().starts_with("session:")
        || (trimmed.len() == 36
            && [8, 13, 18, 23]
                .into_iter()
                .all(|index| trimmed.as_bytes().get(index) == Some(&b'-'))
            && trimmed
                .chars()
                .filter(|character| *character != '-')
                .all(|character| character.is_ascii_hexdigit()))
        || trimmed
            .strip_prefix("Session ")
            .is_some_and(|suffix| !suffix.is_empty() && session_id.starts_with(suffix))
}

pub fn is_explicit_placeholder_session_title(value: &str) -> bool {
    let trimmed = value.trim();
    trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("new session")
        || trimmed.eq_ignore_ascii_case("new chat")
        || trimmed.eq_ignore_ascii_case("new fork")
        || trimmed.eq_ignore_ascii_case("untitled session")
        || trimmed.eq_ignore_ascii_case("session")
}

pub fn is_placeholder_or_weak_legacy_title(value: &str, session_id: &str) -> bool {
    let trimmed = value.trim();
    is_explicit_placeholder_session_title(trimmed)
        || is_raw_session_identifier(trimmed, session_id)
        || is_known_legacy_auto_title(trimmed)
}

#[cfg(test)]
mod tests;
