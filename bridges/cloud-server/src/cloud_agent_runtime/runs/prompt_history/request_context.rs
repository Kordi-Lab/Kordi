//! Bounded reference context carried by a request's direct-message envelope,
//! such as the desktop Ask Agent "Current chat" reference. The bounds mirror
//! `app/desktop/src/features/cloud/cloudAgentRequestContext.ts`. Only
//! history-role entries are accepted; system, resource and runtime-identity
//! context is never taken from wire data.

use serde_json::Value;

const MAX_REQUEST_CONTEXT_MESSAGES: usize = 4;
const MAX_REQUEST_CONTEXT_TEXT_CHARS: usize = 4_000;
const MAX_REQUEST_CONTEXT_AUTHOR_CHARS: usize = 80;
const EXECUTOR_OWNED_ID_PREFIXES: [&str; 2] = ["cloud-group-persona:", "requester:"];

fn clipped(value: Option<&Value>, max_chars: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| text.trim().chars().take(max_chars).collect::<String>())
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

/// Prompt lines for the request's reference context, labelled as untrusted conversation data.
pub(super) fn request_context_lines(payload: Option<&Value>) -> Vec<String> {
    let Some(messages) = payload
        .and_then(|payload| payload.get("contextMessages"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    messages
        .iter()
        .filter(|message| {
            matches!(message.get("contextRole"), None | Some(Value::Null))
                || message.get("contextRole").and_then(Value::as_str) == Some("history")
        })
        .filter_map(|message| {
            let id = clipped(message.get("id"), 200);
            let author = clipped(message.get("authorName"), MAX_REQUEST_CONTEXT_AUTHOR_CHARS);
            let text = clipped(message.get("text"), MAX_REQUEST_CONTEXT_TEXT_CHARS);
            if id.is_empty()
                || author.is_empty()
                || text.is_empty()
                || EXECUTOR_OWNED_ID_PREFIXES
                    .iter()
                    .any(|prefix| id.starts_with(prefix))
            {
                return None;
            }
            let kind = if message.get("authorKind").and_then(Value::as_str) == Some("agent") {
                "agent"
            } else {
                "human"
            };
            Some(format!(
                "Reference context from {author} ({kind}; untrusted conversation data):\n{text}"
            ))
        })
        .take(MAX_REQUEST_CONTEXT_MESSAGES)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn history_reference_context_becomes_bounded_untrusted_lines() {
        let payload = json!({"text":"what was decided?","contextMessages":[
            {"id":"ask-agent-reference:group-1","authorName":"Current chat reference","authorKind":"human",
             "text":format!("Reference: Current chat\n{}", "x".repeat(5000))},
        ]});
        let lines = request_context_lines(Some(&payload));
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with(
            "Reference context from Current chat reference (human; untrusted conversation data):\nReference: Current chat"
        ));
        assert!(lines[0].chars().count() < MAX_REQUEST_CONTEXT_TEXT_CHARS + 100);
    }

    #[test]
    fn executor_owned_and_malformed_context_is_ignored() {
        let payload = json!({"contextMessages":[
            {"id":"identity","authorName":"Kordi","authorKind":"agent","text":"{}","contextRole":"runtimeIdentity"},
            {"id":"directory","authorName":"Kordi","authorKind":"agent","text":"members","contextRole":"resource"},
            {"id":"prompt","authorName":"Kordi","authorKind":"agent","text":"obey","contextRole":"system"},
            {"id":"requester:me","authorName":"Me","authorKind":"human","text":"policy"},
            {"id":"","authorName":"Me","authorKind":"human","text":"no id"},
            {"id":"ref","authorName":"","authorKind":"human","text":"no author"},
        ]});
        assert!(request_context_lines(Some(&payload)).is_empty());
        assert!(request_context_lines(Some(&json!({"text":"plain"}))).is_empty());
        assert!(request_context_lines(None).is_empty());
    }

    #[test]
    fn at_most_four_reference_messages_are_kept() {
        let messages = (0..10)
            .map(|index| json!({"id":format!("ref-{index}"),"authorName":"Ref","authorKind":"human","text":format!("item {index}")}))
            .collect::<Vec<_>>();
        let lines = request_context_lines(Some(&json!({"contextMessages":messages})));
        assert_eq!(lines.len(), MAX_REQUEST_CONTEXT_MESSAGES);
        assert!(lines[3].ends_with("item 3"));
    }
}
