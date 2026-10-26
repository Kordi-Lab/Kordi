//! The evaluation's answer. Anything that is not the documented object, a
//! `share` without a message, or a `share` that names no event or an event
//! outside the snapshot, is `skip`: bare text is never posted.

use serde::Deserialize;
use serde_json::Value;

/// Characters kept from the message, the ellipsis included.
const MESSAGE_LIMIT: usize = 800;
const EVENT_LIMIT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Share {
    pub message: String,
    pub event_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Decision {
    Skip,
    Share(Share),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    decision: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    event_ids: Vec<Value>,
}

fn unfenced(text: &str) -> &str {
    let trimmed = text.trim();
    trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|rest| rest.trim_end().trim_end_matches("```").trim())
        .unwrap_or(trimmed)
}

fn bounded(text: &str) -> String {
    if text.chars().count() <= MESSAGE_LIMIT {
        return text.to_string();
    }
    let cut: String = text.chars().take(MESSAGE_LIMIT - 1).collect();
    format!("{}\u{2026}", cut.trim_end())
}

/// Reads the model's reply. `known` are the event ids of the snapshot.
pub(super) fn parse(text: &str, known: &[&str]) -> Decision {
    let Ok(raw) = serde_json::from_str::<Raw>(unfenced(text)) else {
        return Decision::Skip;
    };
    if raw.decision.trim() != "share" {
        return Decision::Skip;
    }
    let Some(message) = raw
        .message
        .as_deref()
        .map(str::trim)
        .filter(|message| !message.is_empty())
    else {
        return Decision::Skip;
    };
    let mut event_ids: Vec<String> = Vec::new();
    for id in &raw.event_ids {
        let Some(id) = id.as_str().map(str::trim) else {
            return Decision::Skip;
        };
        if !known.contains(&id) {
            return Decision::Skip;
        }
        if !event_ids.iter().any(|seen| seen == id) {
            event_ids.push(id.to_string());
        }
    }
    if event_ids.is_empty() {
        return Decision::Skip;
    }
    event_ids.truncate(EVENT_LIMIT);
    Decision::Share(Share {
        message: bounded(message),
        event_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: &[&str] = &["cnevt_a", "cnevt_b"];

    #[test]
    fn a_share_keeps_its_message_and_event_order() {
        let decision = parse(
            "```json\n{\"decision\":\"share\",\"message\":\" Sam is waiting for your answer. \",\"eventIds\":[\"cnevt_b\",\"cnevt_a\",\"cnevt_b\"]}\n```",
            KNOWN,
        );
        assert_eq!(
            decision,
            Decision::Share(Share {
                message: "Sam is waiting for your answer.".into(),
                event_ids: vec!["cnevt_b".into(), "cnevt_a".into()],
            })
        );
    }

    #[test]
    fn everything_else_is_skip() {
        for reply in [
            "{\"decision\":\"skip\"}",
            "Sam wrote to you!",
            "",
            "[]",
            "{\"decision\":\"share\",\"eventIds\":[\"cnevt_a\"]}",
            "{\"decision\":\"share\",\"message\":\"  \",\"eventIds\":[\"cnevt_a\"]}",
            "{\"decision\":\"share\",\"message\":\"Hi\"}",
            "{\"decision\":\"share\",\"message\":\"Hi\",\"eventIds\":[]}",
            "{\"decision\":\"share\",\"message\":\"Hi\",\"eventIds\":[\"cnevt_a\",\"cnevt_x\"]}",
            "{\"decision\":\"share\",\"message\":\"Hi\",\"eventIds\":[3]}",
            "{\"decision\":\"maybe\",\"message\":\"Hi\",\"eventIds\":[\"cnevt_a\"]}",
        ] {
            assert_eq!(parse(reply, KNOWN), Decision::Skip, "{reply}");
        }
    }

    #[test]
    fn long_messages_are_bounded() {
        let reply = serde_json::json!({
            "decision": "share", "message": "x".repeat(2_000), "eventIds": ["cnevt_a"]
        })
        .to_string();
        let Decision::Share(share) = parse(&reply, KNOWN) else {
            panic!("share expected");
        };
        assert_eq!(share.message.chars().count(), MESSAGE_LIMIT);
    }
}
