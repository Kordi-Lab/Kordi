//! The ids other records use to refer to a message, and which of them name
//! only that message.
//!
//! Only the canonical id is chosen by the server. A client chooses its client
//! id and the logical id inside a group envelope, and each is unique only per
//! sender, so another member may reuse one of them for a different message.
//! Records that belong to other people (replies, task summaries, files-panel
//! entries) are therefore matched only through ids that no other message of
//! the conversation also uses.

use std::collections::HashSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::TryStreamExt;

use super::super::message::CLOUD_GROUP_PREFIX;
use super::*;

/// The longest identifier kept for a removal job.
pub(super) const MAX_IDENTIFIER_CHARS: usize = 300;
const COLLABORATION_MESSAGE_PREFIX: &str = "collaboration-message:";

/// Every id another record may use to refer to this message: the canonical
/// id, the client id, the iOS form of the client id, and the logical id of a
/// group envelope. Direct envelopes carry no id of their own; direct quotes
/// use the canonical id. Compute it before the content is emptied.
pub(crate) fn message_identifiers(message: &MessageSnapshot) -> Vec<String> {
    let mut values = vec![
        message.id.to_string(),
        message.client_message_id.to_string(),
        format!("ios_{}", message.client_message_id),
    ];
    values.extend(group_envelope_ids(&message.content));
    normalize_identifiers(values)
}

/// The same ids read from a stored snapshot, which may be incomplete.
pub(in crate::chat_sync::store) fn snapshot_identifiers(snapshot: &Value) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(id) = snapshot.get("id").and_then(Value::as_str) {
        values.push(id.to_string());
    }
    if let Some(client_id) = snapshot.get("client_message_id").and_then(Value::as_str) {
        values.push(client_id.to_string());
        values.push(format!("ios_{client_id}"));
    }
    if let Some(content) = snapshot.get("content") {
        values.extend(group_envelope_ids(content));
    }
    normalize_identifiers(values)
}

fn group_envelope_ids(content: &Value) -> Vec<String> {
    content
        .get("blocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .filter_map(|text| text.trim_start().strip_prefix(CLOUD_GROUP_PREFIX))
        .filter_map(|encoded| URL_SAFE_NO_PAD.decode(encoded.trim()).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter_map(|envelope| {
            envelope
                .get("message")?
                .get("id")?
                .as_str()
                .map(ToString::to_string)
        })
        .collect()
}

pub(in crate::chat_sync::store) fn normalize_identifiers(
    values: impl IntoIterator<Item = String>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.chars().count() <= MAX_IDENTIFIER_CHARS)
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// The form two ids are compared in: without the `collaboration-message:` and
/// `ios_` prefixes, without case, and with UUIDs in their hyphenated form.
/// Comparing loosely drops more ids, which is the safe direction.
pub(super) fn identifier_key(id: &str) -> String {
    let id = id.trim();
    let id = id.strip_prefix(COLLABORATION_MESSAGE_PREFIX).unwrap_or(id);
    let id = id.strip_prefix("ios_").unwrap_or(id);
    Uuid::parse_str(id).map_or_else(|_| id.to_ascii_lowercase(), |uuid| uuid.to_string())
}

/// The ids in `identifiers` that name only `message_id` within its
/// conversation. The canonical id is always kept. Any other id is dropped when
/// another message of the conversation uses it as its canonical id, client
/// id, iOS client id, or group envelope id, because a record that names it may
/// belong to that other message.
pub(crate) async fn exclusive_identifiers(
    pool: &PgPool,
    conversation_id: Uuid,
    message_id: Uuid,
    identifiers: &[String],
) -> Result<Vec<String>, StoreError> {
    let canonical = message_id.to_string();
    let candidates = identifiers
        .iter()
        .filter(|id| id.trim() != canonical)
        .cloned()
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Ok(vec![canonical]);
    }
    let keys = candidates
        .iter()
        .map(|id| identifier_key(id))
        .collect::<HashSet<_>>();
    let mut taken = HashSet::new();
    let uuids = keys
        .iter()
        .filter_map(|key| Uuid::parse_str(key).ok())
        .collect::<Vec<_>>();
    if !uuids.is_empty() {
        let rows: Vec<(Uuid, Uuid)> = query_as(
            "SELECT message_id, client_message_id FROM cloud_chat_messages \
             WHERE conversation_id = $1 AND message_id <> $2 \
               AND (message_id = ANY($3) OR client_message_id = ANY($3))",
        )
        .bind(conversation_id)
        .bind(message_id)
        .bind(&uuids)
        .fetch_all(pool)
        .await?;
        for (other_id, other_client_id) in rows {
            taken.insert(other_id.to_string());
            taken.insert(other_client_id.to_string());
        }
    }
    // Group envelope ids are not indexed, so other messages that carry a group
    // envelope are read once. A deleted message has no content left to match.
    let mut others = query_as::<_, (Value,)>(
        "SELECT content FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND message_id <> $2 AND deleted_at IS NULL \
           AND strpos(content::text, $3) > 0",
    )
    .bind(conversation_id)
    .bind(message_id)
    .bind(CLOUD_GROUP_PREFIX)
    .fetch(pool);
    while let Some((content,)) = others.try_next().await? {
        for id in group_envelope_ids(&content) {
            let key = identifier_key(&id);
            if keys.contains(&key) {
                taken.insert(key);
            }
        }
    }
    Ok(normalize_identifiers(
        std::iter::once(canonical).chain(
            candidates
                .into_iter()
                .filter(|id| !taken.contains(&identifier_key(id))),
        ),
    ))
}
