//! The free check before any model call: at least one new collaborator
//! message must read like a problem or a request.

/// Word stems; a word matches when it starts with one ("fails", "errors").
const STEMS: &[&str] = &[
    "help", "stuck", "issue", "problem", "error", "bug", "broken", "fail", "fix", "crash", "need",
    "blocked", "deadline", "urgent", "wrong", "missing", "unable",
];
/// Whole words, written without apostrophes.
const WORDS: &[&str] = &["cant", "cannot", "doesnt", "wont"];
/// Phrases matched on the normalized word sequence.
const PHRASES: &[&str] = &["how do", "anyone know", "not working"];

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .replace(['\u{2019}', '\''], "")
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether one message reads like a problem or a request.
pub(super) fn reads_like_a_request(text: &str) -> bool {
    if text.contains('?') || text.contains('\u{ff1f}') {
        return true;
    }
    let words = words(text);
    if words.iter().any(|word| {
        WORDS.contains(&word.as_str()) || STEMS.iter().any(|stem| word.starts_with(stem))
    }) {
        return true;
    }
    let joined = format!(" {} ", words.join(" "));
    PHRASES
        .iter()
        .any(|phrase| joined.contains(&format!(" {phrase} ")))
}

/// Whether any of the new collaborator messages is worth an evaluation.
pub(super) fn worth_a_look(texts: &[String]) -> bool {
    texts.iter().any(|text| reads_like_a_request(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn look(texts: &[&str]) -> bool {
        worth_a_look(&texts.iter().map(|t| t.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn small_talk_is_skipped() {
        assert!(!look(&["haha nice", "see you tomorrow", "lol"]));
        assert!(!look(&["great work everyone"]));
        assert!(!look(&[]));
    }

    #[test]
    fn problems_and_requests_are_looked_at() {
        for text in [
            "anyone free tonight?",
            "I'm stuck on the build",
            "the deploy keeps failing",
            "Getting a weird ERROR from the parser",
            "I can't get the tests to pass",
            "it doesn\u{2019}t load",
            "the login is not working",
            "how do I export this",
            "does anyone know the wifi password",
            "we need the slides by Friday",
            "the app crashed again",
            "blocked on review",
            "\u{8fd9}\u{4e2a}\u{600e}\u{4e48}\u{529e}\u{ff1f}",
        ] {
            assert!(look(&[text]), "{text}");
        }
    }

    #[test]
    fn phrases_need_whole_words() {
        assert!(!look(&["show domains"]));
        assert!(look(&["so how do we split it"]));
    }
}
