use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
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

// The attention fields the server derives from a message body: a group
// envelope's inner message, another Kordi envelope itself, or nothing.
fn attention_content(body: Option<&str>) -> Option<Value> {
    let body = body?;
    if let Some(group) = envelope(body, CLOUD_GROUP_PREFIX) {
        return group.get("message").cloned();
    }
    let (prefix, _) = body.split_once(':')?;
    prefix
        .starts_with("kordi-cloud-")
        .then(|| envelope(body, &format!("{prefix}:")))
        .flatten()
}

fn uuid_reference(reference: &str) -> &str {
    reference
        .strip_prefix("collaboration-message:")
        .map_or(reference, |rest| rest.rsplit(':').next().unwrap_or(rest))
}

/// Mirrors the server's `cloud_chat_resolve_thread` trigger. A discussion
/// reply is counted against its own thread read cursor (through the server
/// attention endpoint), never against the conversation read cursor.
pub(super) fn is_thread_message(
    conn: &Connection,
    account_id: &str,
    conversation_id: &str,
    body: Option<&str>,
    reply_to_message_id: Option<&str>,
) -> Result<bool, String> {
    let mut body = body.map(str::to_string);
    let mut reply_to = reply_to_message_id.map(str::to_string);
    let mut statement = conn
        .prepare_cached(
            "SELECT json_extract(snapshot_json, '$.content.blocks[0].text'),
                    json_extract(snapshot_json, '$.reply_to_message_id')
             FROM chat_sync_messages
             WHERE account_id = ?1 AND conversation_id = ?2
               AND (message_id = ?3 OR client_message_id = ?3)
             ORDER BY message_id = ?3 DESC LIMIT 1",
        )
        .map_err(|error| error.to_string())?;
    // Replies inherit the thread of their parent; bound the walk.
    for _ in 0..16 {
        let content = attention_content(body.as_deref());
        if content
            .as_ref()
            .and_then(|value| value.pointer("/messageAction/kind"))
            .and_then(Value::as_str)
            == Some("thread")
        {
            return Ok(true);
        }
        let reference = content
            .as_ref()
            .and_then(|value| {
                ["replyToMessageId", "requestId"]
                    .iter()
                    .find_map(|key| value.get(*key).and_then(Value::as_str))
            })
            .map(str::to_string)
            .or(reply_to.take());
        let Some(reference) = reference.filter(|value| !value.trim().is_empty()) else {
            return Ok(false);
        };
        let parent: Option<(Option<String>, Option<String>)> = statement
            .query_row(
                params![
                    account_id,
                    conversation_id,
                    uuid_reference(reference.trim())
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((parent_body, parent_reply_to)) = parent else {
            return Ok(false);
        };
        body = parent_body;
        reply_to = parent_reply_to;
    }
    Ok(false)
}
