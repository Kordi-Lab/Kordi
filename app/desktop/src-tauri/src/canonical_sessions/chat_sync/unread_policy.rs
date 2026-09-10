use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;

const CLOUD_GROUP_PREFIX: &str = "kordi-cloud-group:";
const AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";

fn envelope(body: &str, prefix: &str) -> Option<Value> {
    let encoded = body.strip_prefix(prefix)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()
}

pub(super) fn is_self_agent_reply(body: Option<&str>) -> bool {
    let Some(body) = body else { return false };
    if let Some(response) = envelope(body, AGENT_RESPONSE_PREFIX) {
        return response.get("kind").and_then(Value::as_str) == Some("agent-response")
            && !matches!(
                response.get("deliveryState").and_then(Value::as_str),
                Some("queued" | "processing")
            )
            && response
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty());
    }
    envelope(body, CLOUD_GROUP_PREFIX).is_some_and(|group| {
        group.get("kind").and_then(Value::as_str) == Some("group-message")
            && group.pointer("/message/senderKind").and_then(Value::as_str) == Some("agent")
    })
}

pub(super) fn chat_sync_unread_key(message_id: &str, body: Option<&str>) -> Option<String> {
    let Some(encoded) = body.and_then(|value| value.strip_prefix(CLOUD_GROUP_PREFIX)) else {
        return Some(message_id.to_string());
    };
    let Ok(decoded) = URL_SAFE_NO_PAD.decode(encoded) else {
        return None;
    };
    let Ok(envelope) = serde_json::from_slice::<Value>(&decoded) else {
        return None;
    };
    if envelope.get("kind").and_then(Value::as_str) != Some("group-message") {
        return None;
    }
    let message = envelope.get("message").filter(|value| !value.is_null())?;
    if message.get("senderKind").and_then(Value::as_str) == Some("agent")
        && matches!(
            message.get("deliveryState").and_then(Value::as_str),
            Some("queued" | "processing")
        )
    {
        return None;
    }
    Some(
        message
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(message_id)
            .to_string(),
    )
}
