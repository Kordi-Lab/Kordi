//! "@Name" mentions in Grounding notices. The text goes out in the cloud
//! message envelope the Mac and iPhone apps decode, with one mention per
//! "@Name" so each person renders as a real mention.

use std::collections::{HashMap, VecDeque};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

const ENVELOPE_PREFIX: &str = "kordi-cloud-message:";

/// The most mentions the clients read from one message.
const MAX_MENTIONS: usize = 32;

/// A group member a notice names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Member {
    pub name: String,
    pub account_id: String,
}

impl Member {
    pub(super) fn new(name: impl Into<String>, account_id: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            account_id: account_id.into(),
        }
    }
}

/// Distinct non-empty names, longest first, so "Maya Chen" wins over "Maya".
fn names_longest_first(people: &[Member]) -> Vec<&str> {
    let mut names: Vec<&str> = people
        .iter()
        .map(|person| person.name.as_str())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort_by_key(|name| (std::cmp::Reverse(name.chars().count()), *name));
    names.dedup();
    names
}

/// The longest name `rest` starts with as a whole word.
fn name_at<'a>(rest: &str, names: &[&'a str]) -> Option<&'a str> {
    names.iter().copied().find(|name| {
        rest.strip_prefix(name)
            .is_some_and(|after| after.chars().next().is_none_or(|c| !c.is_alphanumeric()))
    })
}

/// One mention per "@Name" in `text`, with UTF-16 ranges. People who share
/// a name are taken in the order given, one per occurrence; the last one
/// takes any further occurrences.
pub(super) fn mention_ranges(text: &str, people: &[Member]) -> Vec<Value> {
    let names = names_longest_first(people);
    let mut ids: HashMap<&str, VecDeque<&str>> = HashMap::new();
    for person in people {
        ids.entry(person.name.as_str())
            .or_default()
            .push_back(person.account_id.as_str());
    }
    let mut mentions = Vec::new();
    let (mut index, mut utf16) = (0, 0);
    let mut previous: Option<char> = None;
    while let Some(c) = text[index..].chars().next() {
        let starts = c == '@' && previous.is_none_or(|p| !p.is_alphanumeric());
        let name = starts
            .then(|| name_at(&text[index + 1..], &names))
            .flatten();
        if let (Some(name), true) = (name, mentions.len() < MAX_MENTIONS) {
            let queue = ids.get_mut(name).expect("every name has an id");
            let id = if queue.len() > 1 {
                queue.pop_front()
            } else {
                queue.front().copied()
            }
            .expect("every name has an id");
            let display = format!("@{name}");
            let length = display.encode_utf16().count();
            mentions.push(json!({
                "label": name,
                "displayLabel": name,
                "targetKind": "person",
                "targetIdentityId": format!("human:{id}"),
                "humanId": id,
                "startUtf16": utf16,
                "lengthUtf16": length,
                "displayText": display,
            }));
            index += display.len();
            utf16 += length;
            previous = name.chars().last();
            continue;
        }
        index += c.len_utf8();
        utf16 += c.len_utf16();
        previous = Some(c);
    }
    mentions
}

/// `text` in the cloud message envelope, mentioning `people` wherever it
/// says "@Name".
pub(super) fn envelope(text: &str, people: &[Member]) -> String {
    let payload = json!({
        "schemaVersion": 1,
        "kind": "message",
        "text": text,
        "mentions": mention_ranges(text, people),
    });
    format!(
        "{ENVELOPE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(payload.to_string())
    )
}

/// Puts "@" before a name the model wrote bare where it introduces someone:
/// at the start of a line, or followed by ":" or " (invited)".
pub(super) fn at_names(text: &str, people: &[Member]) -> String {
    let names = names_longest_first(people);
    let mut out = String::with_capacity(text.len() + 16);
    let mut index = 0;
    let mut previous: Option<char> = None;
    let mut line_start = true;
    while let Some(c) = text[index..].chars().next() {
        let boundary = previous.is_none_or(|p| !p.is_alphanumeric() && p != '@');
        if let Some(name) = boundary.then(|| name_at(&text[index..], &names)).flatten() {
            let after = &text[index + name.len()..];
            if line_start || after.starts_with(':') || after.starts_with(" (invited)") {
                out.push('@');
            }
            out.push_str(name);
            index += name.len();
            previous = name.chars().last();
            line_start = false;
            continue;
        }
        out.push(c);
        index += c.len_utf8();
        previous = Some(c);
        line_start = c == '\n' || (line_start && c.is_whitespace());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(envelope: &str) -> Value {
        let encoded = envelope.strip_prefix(ENVELOPE_PREFIX).unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
    }

    fn ranges(mentions: &[Value]) -> Vec<(u64, u64, &str, &str)> {
        mentions
            .iter()
            .map(|m| {
                (
                    m["startUtf16"].as_u64().unwrap(),
                    m["lengthUtf16"].as_u64().unwrap(),
                    m["displayText"].as_str().unwrap(),
                    m["humanId"].as_str().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn ranges_are_utf16_and_prefer_the_longest_name() {
        let people = [
            Member::new("Maya", "acct_maya"),
            Member::new("Maya Chen", "acct_chen"),
            Member::new("Nadia", "acct_nadia"),
        ];
        // The emoji is two UTF-16 units and four bytes.
        let text = "🎉 @Maya Chen and @Maya: hi @Nadia. a@Maya @Mayank @Nadia";
        let mentions = mention_ranges(text, &people);
        assert_eq!(
            ranges(&mentions),
            vec![
                (3, 10, "@Maya Chen", "acct_chen"),
                (18, 5, "@Maya", "acct_maya"),
                (28, 6, "@Nadia", "acct_nadia"),
                (51, 6, "@Nadia", "acct_nadia"),
            ]
        );
        let first = &mentions[0];
        assert_eq!(first["label"], "Maya Chen");
        assert_eq!(first["targetKind"], "person");
        assert_eq!(first["targetIdentityId"], "human:acct_chen");
        let utf16: Vec<u16> = text.encode_utf16().collect();
        for (start, length, display, _) in ranges(&mentions) {
            let slice = &utf16[start as usize..(start + length) as usize];
            assert_eq!(String::from_utf16(slice).unwrap(), display);
        }
    }

    #[test]
    fn people_sharing_a_name_are_taken_in_order() {
        let people = [Member::new("Sam", "one"), Member::new("Sam", "two")];
        let ids: Vec<_> = mention_ranges("@Sam, @Sam, @Sam", &people)
            .iter()
            .map(|m| m["humanId"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, ["one", "two", "two"]);
    }

    #[test]
    fn mentions_stop_at_the_client_limit() {
        let people = [Member::new("Sam", "sam")];
        let text = "@Sam ".repeat(40);
        assert_eq!(mention_ranges(&text, &people).len(), MAX_MENTIONS);
    }

    #[test]
    fn envelope_carries_text_and_mentions() {
        let people = [Member::new("Tomas", "acct_tomas")];
        let payload = decode(&envelope("@Tomas joined.", &people));
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["kind"], "message");
        assert_eq!(payload["text"], "@Tomas joined.");
        assert_eq!(payload["mentions"][0]["startUtf16"], 0);
        assert_eq!(payload["mentions"][0]["lengthUtf16"], 6);
        let plain = decode(&envelope("Welcome.", &people));
        assert_eq!(plain["mentions"], json!([]));
    }

    #[test]
    fn bare_names_get_an_at_where_people_are_introduced() {
        let people = [
            Member::new("Alex", "a"),
            Member::new("Maya", "m"),
            Member::new("Maya Chen", "c"),
            Member::new("Priya", "p"),
        ];
        let text = "Welcome, Alex and Priya.\nAlex: memory.\n  Maya Chen (invited): evals.\n\
                    @Priya: retrieval. Ask Maya: she knows.\nMayank is not here.";
        assert_eq!(
            at_names(text, &people),
            "Welcome, Alex and Priya.\n@Alex: memory.\n  @Maya Chen (invited): evals.\n\
             @Priya: retrieval. Ask @Maya: she knows.\nMayank is not here."
        );
    }
}
