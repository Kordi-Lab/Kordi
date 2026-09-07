use super::*;

pub(super) const MAX_CLOUD_FALLBACK_HISTORY_MESSAGES: i64 = 8;

pub(super) fn history_payload(body: &str) -> Option<serde_json::Value> {
    let (prefix, encoded) = body.trim().split_once(':')?;
    if !matches!(
        prefix,
        "kordi-cloud-group" | "kordi-cloud-message" | "kordi-cloud-agent-response"
    ) {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    if prefix == "kordi-cloud-group" {
        value.get("message").cloned()
    } else {
        Some(value)
    }
}

// Rows are bounded by the existing 256-message query. Resolve reply ancestry
// before applying the history limit so an old thread request still scopes its result.
pub(super) fn context_history_indices(
    rows: &[(String, String, String, String)],
    request_id: &str,
    reply_action: Option<&serde_json::Value>,
) -> (Option<usize>, Vec<usize>) {
    let payloads: Vec<_> = rows
        .iter()
        .map(|(_, _, _, body)| history_payload(body))
        .collect();
    let mut indices = HashMap::new();
    for (index, (id, client_id, _, _)) in rows.iter().enumerate() {
        indices.insert(id.clone(), index);
        indices.insert(format!("ios_{client_id}"), index);
        if let Some(id) = payloads[index]
            .as_ref()
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str())
        {
            indices.insert(id.to_string(), index);
        }
    }
    let request_index = indices.get(request_id).copied();
    let root_for = |index: usize| -> Option<String> {
        let mut current = index;
        let mut visited = HashSet::new();
        while visited.insert(current) {
            let value = payloads[current].as_ref()?;
            if let Some(action) = value.get("messageAction") {
                if action.get("kind").and_then(|kind| kind.as_str()) == Some("thread") {
                    return action
                        .pointer("/source/sourceMessageId")
                        .and_then(|id| id.as_str())
                        .map(str::to_string);
                }
            }
            if Some(current) == request_index {
                if let Some(root) = reply_action
                    .and_then(|action| action.pointer("/source/sourceMessageId"))
                    .and_then(|id| id.as_str())
                {
                    return Some(root.to_string());
                }
            }
            let parent = value
                .get("requestId")
                .or_else(|| value.get("replyToMessageId"))?
                .as_str()?;
            let Some(parent_index) = indices.get(parent) else {
                // An orphan response may belong to an older thread. Do not leak it
                // into main context merely because its request is outside the window.
                return Some(format!("unresolved:{parent}"));
            };
            current = *parent_index;
        }
        Some(format!("unresolved:{}", rows[index].0))
    };
    let root = request_index.and_then(root_for);
    let root_index = root.as_ref().and_then(|id| indices.get(id)).copied();
    let history = (0..request_index.unwrap_or(rows.len()))
        .filter(|&index| {
            let payload = payloads[index].as_ref();
            if payload
                .and_then(|value| value.pointer("/messageAction/kind"))
                .and_then(|value| value.as_str())
                == Some("forward")
                || payload
                    .and_then(|value| value.get("deliveryState"))
                    .and_then(|value| value.as_str())
                    == Some("processing")
            {
                return false;
            }
            root_for(index) == root || Some(index) == root_index
        })
        .collect();
    (request_index, history)
}

#[cfg(test)]
mod tests;

#[derive(Debug, Clone)]
pub(in crate::cloud_agent_runtime::runs) struct CloudFallbackHistoryMessage {
    pub(in crate::cloud_agent_runtime::runs) from_account_id: String,
    pub(in crate::cloud_agent_runtime::runs) body: String,
}

pub(super) fn strip_leading_agent_mention(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with('@') {
        return trimmed.to_string();
    }
    let Some((_, rest)) = trimmed.split_once(char::is_whitespace) else {
        return trimmed.to_string();
    };
    rest.trim().to_string()
}

fn action_context_suffix(action: Option<&serde_json::Value>) -> String {
    let Some(action) = action else {
        return String::new();
    };
    let kind = action
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    let source = action.get("source").and_then(serde_json::Value::as_object);
    let sender = source
        .and_then(|source| source.get("senderLabel"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown sender");
    let source_message_id = source
        .and_then(|source| source.get("sourceMessageId"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let preview = source
        .and_then(|source| source.get("textPreview"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!(": {}", value.chars().take(180).collect::<String>()))
        .unwrap_or_default();
    match kind {
        "quote" => format!(" [quotes message {source_message_id} from {sender}{preview}]"),
        "forward" => format!(" [forwarded from message {source_message_id} by {sender}{preview}]"),
        _ => String::new(),
    }
}

fn fallback_prompt_history_line(
    requester_account_id: &str,
    owner_account_id: &str,
    message: &CloudFallbackHistoryMessage,
) -> Option<String> {
    let (label, text, suffix) = if let Some(text) = cloud_agent_response_text(&message.body) {
        ("Owner agent", text, String::new())
    } else if let Some(envelope) = parse_cloud_group_envelope(&message.body) {
        let group_message = envelope.message?;
        let label = if group_message.sender_account_id == requester_account_id {
            "Requester"
        } else if group_message.sender_account_id == owner_account_id {
            if group_message.sender_kind.as_deref() == Some("agent") {
                "Owner agent"
            } else {
                "Owner"
            }
        } else {
            "Participant"
        };
        (
            label,
            strip_leading_agent_mention(&group_message.text),
            action_context_suffix(group_message.message_action.as_ref()),
        )
    } else if let Some(envelope) = direct_message_envelope(&message.body) {
        let text = envelope
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let suffix = action_context_suffix(envelope.get("messageAction"));
        if message.from_account_id == requester_account_id {
            ("Requester", strip_leading_agent_mention(&text), suffix)
        } else if message.from_account_id == owner_account_id {
            ("Owner", text.trim().to_string(), suffix)
        } else {
            return None;
        }
    } else if message.from_account_id == requester_account_id {
        (
            "Requester",
            strip_leading_agent_mention(&message.body),
            String::new(),
        )
    } else if message.from_account_id == owner_account_id {
        ("Owner", message.body.trim().to_string(), String::new())
    } else {
        return None;
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(format!(
        "{label}: {}{suffix}",
        text.chars().take(800).collect::<String>()
    ))
}

pub(in crate::cloud_agent_runtime::runs) fn fallback_prompt_with_history(
    requester_account_id: &str,
    owner_account_id: &str,
    current_prompt: &str,
    history: &[CloudFallbackHistoryMessage],
) -> String {
    let current_prompt = current_prompt.trim();
    let lines = history[history
        .len()
        .saturating_sub(MAX_CLOUD_FALLBACK_HISTORY_MESSAGES as usize)..]
        .iter()
        .filter_map(|message| {
            fallback_prompt_history_line(requester_account_id, owner_account_id, message)
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return current_prompt.to_string();
    }
    format!(
        "Conversation history:\n{}\n\nCurrent request:\n{}",
        lines.join("\n"),
        current_prompt
    )
}
