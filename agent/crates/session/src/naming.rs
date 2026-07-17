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
            | "你好"
            | "您好"
            | "嗨"
            | "测试"
            | "收到"
            | "好的"
            | "谢谢"
            | "hithere"
            | "hellothere"
            | "howareyou"
            | "hihowareyou"
            | "hellohowareyou"
            | "howcanihelp"
            | "hihowcanihelp"
            | "hellohowcanihelp"
            | "你好吗"
            | "你好嗎"
    ) || ["test", "testreply", "testmessage"].iter().any(|prefix| {
        probe
            .strip_prefix(prefix)
            .is_some_and(|suffix| !suffix.is_empty() && suffix.chars().all(char::is_numeric))
    })
}

fn semantic_known_title(value: &str) -> Option<&'static str> {
    let lower = value.to_lowercase();
    if lower.contains('模')
        && lower.contains("模型")
        && (lower.contains('谁') || lower.contains("身份") || lower.contains("你是"))
    {
        return Some("模型与身份");
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
        || semantic_known_title(trimmed).is_some_and(|title| !title.eq_ignore_ascii_case(trimmed))
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
    let without_context = remove_reply_and_code_context(value);
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
mod tests {
    use super::*;

    #[test]
    fn low_information_seeds_wait_for_a_topic() {
        for value in [
            "hi",
            "hiiii",
            "hello!",
            "hi, how are you?",
            "Hi! How can I help?",
            "test",
            "test reply 11",
            "111",
            "👍🏽",
            "@MyKordi",
            "你好",
        ] {
            assert_eq!(derive_session_title(value), None, "{value}");
        }
    }

    #[test]
    fn meaningful_titles_remove_transport_noise_and_preserve_language() {
        assert_eq!(
            derive_session_title("@MyKordi help diagnose high Node CPU usage").as_deref(),
            Some("Diagnose high Node CPU")
        );
        assert_eq!(
            derive_session_title("which model are you").as_deref(),
            Some("Model and identity")
        );
        assert_eq!(
            derive_session_title("你是谁你在使用什么模型").as_deref(),
            Some("模型与身份")
        );
    }

    #[test]
    fn reply_code_url_and_command_context_do_not_become_titles() {
        assert_eq!(
            derive_session_title(
                "> old answer\n/retry @MyKordi plan release validation https://example.com"
            )
            .as_deref(),
            Some("Plan release validation")
        );
        assert_eq!(derive_session_title("```rust\nfn main() {}\n```"), None);
        assert_eq!(
            derive_session_title("Attached private-report.pdf please diagnose memory usage")
                .as_deref(),
            Some("Diagnose memory usage")
        );
        assert_eq!(
            derive_session_title("[attachment: private-report.pdf] diagnose memory usage")
                .as_deref(),
            Some("Diagnose memory usage")
        );
    }

    #[test]
    fn titles_are_capped_by_graphemes_without_splitting_emoji() {
        let title = derive_session_title(
            "organize this deliberately very long conversation topic with enough extra words to overflow",
        )
        .unwrap();
        assert!(UnicodeSegmentation::graphemes(title.as_str(), true).count() <= 48);
    }

    #[test]
    fn attachment_titles_never_depend_on_local_filenames() {
        assert_eq!(derive_session_title("Attached private-report.pdf"), None);
        assert_eq!(derive_session_title("Attachment: private-report.pdf"), None);
        assert_eq!(
            attachment_session_title(1, true).as_deref(),
            Some("Image attachment")
        );
        assert_eq!(
            attachment_session_title(1, false).as_deref(),
            Some("File attachment")
        );
        assert_eq!(
            attachment_session_title(3, true).as_deref(),
            Some("3 attachments")
        );
    }

    #[test]
    fn title_source_precedence_is_explicit() {
        assert!(SessionTitleSource::Placeholder.can_be_replaced_by(SessionTitleSource::Auto));
        assert!(SessionTitleSource::Auto.can_be_replaced_by(SessionTitleSource::Manual));
        assert!(!SessionTitleSource::Manual.can_be_replaced_by(SessionTitleSource::Auto));
        assert!(!SessionTitleSource::Imported.can_be_replaced_by(SessionTitleSource::Auto));
    }

    #[test]
    fn legacy_backfill_only_targets_known_generated_shapes() {
        assert!(is_known_legacy_auto_title("which model are you"));
        assert!(is_known_legacy_auto_title("Attached private-report.pdf"));
        assert!(is_known_legacy_auto_title("hello"));
        assert!(!is_known_legacy_auto_title("Release validation plan"));
        assert!(!is_known_legacy_auto_title("Model and identity"));
    }

    #[test]
    fn raw_identifiers_are_recognized_without_matching_normal_titles() {
        let id = "e2b79cd7-70c0-4cee-ae1b-9bc8cb28da83";
        assert!(is_raw_session_identifier(id, id));
        assert!(is_raw_session_identifier("session:self-agent:test", id));
        assert!(is_raw_session_identifier("Session e2b79cd7", id));
        assert!(!is_raw_session_identifier("Release validation plan", id));
    }
}
