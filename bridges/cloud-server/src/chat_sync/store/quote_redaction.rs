//! Quote and thread previews of a message deleted for everyone.
//!
//! A reply that quotes a message, or opens a thread on it, carries a short
//! preview of the source inside its own envelope. When the source is deleted
//! for everyone, the preview in later replies is replaced: the text, mentions,
//! and attachment count are emptied and the source is marked deleted, so
//! clients show "Original message was deleted". Forwards are separate
//! messages by design and are never changed. Edits never change previews.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::message::{
    ensure_rewrite_keeps_envelope_placement, fanout_message_sync_event,
    CLOUD_AGENT_RESPONSE_PREFIX, CLOUD_DIRECT_PREFIX, CLOUD_GROUP_PREFIX,
};
use super::redaction::supersede_message_events;
use super::support::load_message;
use super::*;

/// The most replies one page examines.
const MAX_QUOTE_PAGE: i64 = 200;
const COLLABORATION_MESSAGE_PREFIX: &str = "collaboration-message:";

/// One page of a quote scrub.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct QuotePage {
    /// The sequence to continue after.
    pub(crate) last_sequence: i64,
    /// Whether no later message remains.
    pub(crate) finished: bool,
    /// Replies whose preview was replaced.
    pub(crate) rewritten: u32,
}

/// Replaces the preview of the deleted source in replies sent after it, one
/// page at a time. `identifiers` are every id a reply may use for the source.
pub(crate) async fn scrub_quote_page(
    pool: &PgPool,
    conversation_id: Uuid,
    source_sequence: i64,
    identifiers: &[String],
    after_sequence: i64,
    limit: i64,
) -> Result<QuotePage, StoreError> {
    let limit = limit.clamp(1, MAX_QUOTE_PAGE);
    let after = after_sequence.max(source_sequence);
    let sessions: Option<(Option<String>,)> = query_as(
        "SELECT legacy_session_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    let Some((legacy_session_id,)) = sessions else {
        return Ok(QuotePage {
            last_sequence: after,
            finished: true,
            rewritten: 0,
        });
    };
    let sessions = legacy_session_id
        .into_iter()
        .chain([conversation_id.to_string()])
        .collect::<Vec<_>>();
    let page: Vec<(Uuid, i64, Value)> = query_as(
        "SELECT message_id, conversation_sequence, content FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND conversation_sequence > $2 AND deleted_at IS NULL \
         ORDER BY conversation_sequence LIMIT $3",
    )
    .bind(conversation_id)
    .bind(after)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let finished = (page.len() as i64) < limit;
    let last_sequence = page.last().map_or(after, |row| row.1);
    let mut rewritten = 0;
    for (message_id, _, content) in page {
        if scrubbed_content(&content, &sessions, identifiers).is_some()
            && rewrite_reply(pool, message_id, &sessions, identifiers).await?
        {
            rewritten += 1;
        }
    }
    Ok(QuotePage {
        last_sequence,
        finished,
        rewritten,
    })
}

/// Rewrites one reply under its row lock. Returns whether it changed.
async fn rewrite_reply(
    pool: &PgPool,
    message_id: Uuid,
    sessions: &[String],
    identifiers: &[String],
) -> Result<bool, StoreError> {
    let mut transaction = pool.begin().await?;
    let row: Option<(Value, Option<DateTime<Utc>>)> = query_as(
        "SELECT content, deleted_at FROM cloud_chat_messages WHERE message_id = $1 FOR UPDATE",
    )
    .bind(message_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((content, None)) = row else {
        return Ok(false);
    };
    let Some(scrubbed) = scrubbed_content(&content, sessions, identifiers) else {
        return Ok(false);
    };
    if ensure_rewrite_keeps_envelope_placement(&content, &scrubbed).is_err() {
        eprintln!("[content-removal] step=quotes outcome=skipped:envelope_placement");
        return Ok(false);
    }
    query(
        "UPDATE cloud_chat_messages SET content = $2, version = version + 1 WHERE message_id = $1",
    )
    .bind(message_id)
    .bind(&scrubbed)
    .execute(&mut *transaction)
    .await?;
    let reply = load_message(&mut transaction, message_id).await?;
    fanout_message_sync_event(&mut transaction, "message.updated", &reply).await?;
    supersede_message_events(&mut transaction, reply.id, reply.version).await?;
    transaction.commit().await?;
    Ok(true)
}

/// The content with the deleted source's preview replaced, or `None` when the
/// content does not quote or thread on that source, or already shows it as
/// deleted.
pub(super) fn scrubbed_content(
    content: &Value,
    sessions: &[String],
    identifiers: &[String],
) -> Option<Value> {
    let blocks = content.get("blocks")?.as_array()?;
    let index = blocks
        .iter()
        .position(|block| block.get("type").and_then(Value::as_str) == Some("text"))?;
    let text = blocks[index].get("text")?.as_str()?;
    let prefix = [
        CLOUD_DIRECT_PREFIX,
        CLOUD_AGENT_RESPONSE_PREFIX,
        CLOUD_GROUP_PREFIX,
    ]
    .into_iter()
    .find(|prefix| text.starts_with(prefix))?;
    let decoded = URL_SAFE_NO_PAD.decode(text[prefix.len()..].trim()).ok()?;
    let mut envelope: Value = serde_json::from_slice(&decoded).ok()?;
    let action = if prefix == CLOUD_GROUP_PREFIX {
        envelope.get_mut("message")?.get_mut("messageAction")?
    } else {
        envelope.get_mut("messageAction")?
    };
    if !matches!(
        action.get("kind").and_then(Value::as_str),
        Some("quote" | "thread")
    ) {
        return None;
    }
    let source = action.get_mut("source")?.as_object_mut()?;
    let session_matches = source
        .get("sourceSessionId")
        .and_then(Value::as_str)
        .is_some_and(|session| sessions.iter().any(|known| known == session.trim()));
    let source_matches = source
        .get("sourceMessageId")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|id| {
            let suffix = id.strip_prefix(COLLABORATION_MESSAGE_PREFIX).unwrap_or(id);
            identifiers
                .iter()
                .any(|known| known == id || known == suffix)
        });
    if !session_matches || !source_matches {
        return None;
    }
    let already_scrubbed = source.get("sourceDeleted") == Some(&Value::Bool(true))
        && source.get("textPreview") == Some(&Value::String(String::new()))
        && source.get("attachmentCount") == Some(&Value::from(0))
        && !source.contains_key("mentions");
    if already_scrubbed {
        return None;
    }
    source.insert("textPreview".to_string(), Value::String(String::new()));
    source.remove("mentions");
    source.insert("attachmentCount".to_string(), Value::from(0));
    source.insert("sourceDeleted".to_string(), Value::Bool(true));
    let encoded = format!(
        "{prefix}{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).ok()?)
    );
    let mut scrubbed = content.clone();
    scrubbed["blocks"][index]["text"] = Value::String(encoded);
    Some(scrubbed)
}

#[cfg(test)]
#[path = "quote_redaction_tests.rs"]
mod tests;
