//! The short label of a connector event: what a source chip under the
//! agent's message shows after the provider name, and what the evaluation
//! sees as the event's `title`. Sender or subject for mail, the event title
//! for calendar, `#<number> <what>` for GitHub, the channel for Slack.

use serde_json::Value;

/// Characters in a label, the ellipsis included.
pub(super) const TITLE_LIMIT: usize = 60;

fn text<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// `snake_case` or `dotted.words` as plain words.
fn words(value: &str) -> String {
    value.replace(['_', '.'], " ")
}

/// The display name of a `From` header: `Sam <sam@example.com>` is `Sam`,
/// a bare address stays as it is.
fn sender_name(from: &str) -> String {
    let name = match from.find('<') {
        Some(at) if at > 0 => &from[..at],
        _ => from,
    };
    name.trim().trim_matches('"').trim().to_string()
}

fn joined(parts: &[Option<String>]) -> Option<String> {
    let parts: Vec<&str> = parts
        .iter()
        .flatten()
        .map(String::as_str)
        .filter(|part| !part.is_empty())
        .collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn mail(payload: &Value) -> Option<String> {
    let sender = text(payload, "from").map(sender_name);
    joined(&[sender, text(payload, "subject").map(str::to_string)])
}

fn github(kind: &str, payload: &Value) -> Option<String> {
    let action = text(payload, "action").map(words).or_else(|| {
        kind.split_once('.')
            .map(|(_, action)| words(action))
            .filter(|action| !action.is_empty())
    });
    let title = text(payload, "title").map(str::to_string);
    if let Some(number) = payload.get("number").and_then(Value::as_u64) {
        let what = action.or(title).unwrap_or_default();
        return Some(format!("#{number} {what}").trim().to_string());
    }
    let reason = text(payload, "reason").map(words);
    joined(&[reason, title]).or_else(|| text(payload, "repository").map(str::to_string))
}

fn slack(payload: &Value) -> Option<String> {
    let channel = text(payload, "channelName").or_else(|| text(payload, "channel"))?;
    Some(format!("#{}", channel.trim_start_matches('#')))
}

/// The label of one event, at most [`TITLE_LIMIT`] characters.
pub(super) fn title(provider: &str, kind: &str, payload: &Value) -> String {
    let found = match provider {
        "gmail" => mail(payload),
        "google_calendar" => text(payload, "summary").map(str::to_string),
        "github" => github(kind, payload),
        "slack" => slack(payload),
        _ => None,
    };
    let label = found.unwrap_or_else(|| words(kind));
    let label = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.chars().count() <= TITLE_LIMIT {
        return label;
    }
    let cut: String = label.chars().take(TITLE_LIMIT - 1).collect();
    format!("{}\u{2026}", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mail_shows_the_sender_and_subject() {
        let payload =
            json!({"from": "\"Airbnb\" <automated@airbnb.com>", "subject": "Sam sent a message"});
        assert_eq!(
            title("gmail", "message.received", &payload),
            "Airbnb · Sam sent a message"
        );
        assert_eq!(
            title(
                "gmail",
                "message.received",
                &json!({"from": "riya@example.com"})
            ),
            "riya@example.com"
        );
        assert_eq!(
            title("gmail", "message.received", &json!({"subject": "Invoice"})),
            "Invoice"
        );
    }

    #[test]
    fn calendar_github_and_slack_have_their_own_labels() {
        assert_eq!(
            title(
                "google_calendar",
                "event.updated",
                &json!({"summary": "Lab sync"})
            ),
            "Lab sync"
        );
        assert_eq!(
            title(
                "github",
                "pull_request.review_requested",
                &json!({"number": 412, "action": "review_requested", "title": "Fix login"})
            ),
            "#412 review requested"
        );
        assert_eq!(
            title(
                "github",
                "issues",
                &json!({"number": 7, "title": "Crash on start"})
            ),
            "#7 Crash on start"
        );
        assert_eq!(
            title(
                "github",
                "notification",
                &json!({"reason": "mention", "title": "Release notes"})
            ),
            "mention · Release notes"
        );
        assert_eq!(
            title("slack", "message", &json!({"channel": "C024BE91L"})),
            "#C024BE91L"
        );
        assert_eq!(title("slack", "message", &json!({})), "message");
        assert_eq!(title("other", "thing.changed", &json!({})), "thing changed");
    }

    #[test]
    fn labels_are_bounded_and_on_one_line() {
        let long = "word ".repeat(40);
        let label = title(
            "google_calendar",
            "event.updated",
            &json!({"summary": long}),
        );
        assert_eq!(label.chars().count(), TITLE_LIMIT);
        assert!(label.ends_with('\u{2026}'));
        assert_eq!(
            title(
                "google_calendar",
                "event.updated",
                &json!({"summary": "Lab\n  sync"})
            ),
            "Lab sync"
        );
    }
}
