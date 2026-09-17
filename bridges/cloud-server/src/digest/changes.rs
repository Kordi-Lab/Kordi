//! When a digest needs to rerun.
//!
//! A digest used to rebuild its whole input every few seconds and rerun the
//! model after any change. Now a message write marks the members of its
//! conversation as changed, unless the message cannot change a digest, and
//! the worker reruns a marked digest only once the person's chats have been
//! quiet for a while (or a maximum wait has passed). A slow safety check
//! still catches anything not marked here, such as task updates.

use serde_json::Value;
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::chat_sync::models::MessageSnapshot;

/// Reruns wait until a person's chats have been quiet this long.
pub const QUIET_WINDOW_MINUTES: i64 = 5;
/// A marked digest never waits longer than this after its first change.
pub const MAX_WAIT_MINUTES: i64 = 30;
/// Unmarked digests are still checked this often.
pub const SAFETY_CHECK_MINUTES: i64 = 30;

const ACKNOWLEDGEMENTS: &[&str] = &[
    "ok", "okay", "k", "kk", "lol", "lmao", "haha", "hahaha", "hehe", "thanks", "thank", "you",
    "thx", "ty", "nice", "cool", "wow", "yay", "great",
];

/// A message that cannot change a digest on its own: no readable text, or
/// only emoji, punctuation, and a short acknowledgement. Such messages still
/// reach the digest at its next run.
pub fn is_trivial(content: &Value) -> bool {
    let Some(text) = super::source_reader::visible_text(content) else {
        return true;
    };
    let words: Vec<String> = text
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect();
    words.is_empty()
        || (words.len() <= 3
            && words
                .iter()
                .all(|word| ACKNOWLEDGEMENTS.contains(&word.as_str())))
}

/// Marks everyone in a conversation as having a changed digest after a
/// message write, unless the write cannot matter to a digest.
pub async fn note_message<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    event_type: &str,
    message: &MessageSnapshot,
) -> Result<(), sqlx_core::Error> {
    if crate::pip::service_account_id() == Some(message.sender_account_id.as_str()) {
        return Ok(());
    }
    let deleted = event_type == "message.deleted" || message.deleted_at.is_some();
    if !deleted {
        let generating = message
            .generation_status
            .as_deref()
            .is_some_and(|status| !matches!(status, "complete" | "completed"));
        if generating || is_trivial(&message.content) {
            return Ok(());
        }
    }
    mark_conversation(executor, message.conversation_id).await
}

/// Digest rows are locked in account order before they are marked. A message
/// send marks its members inside the send's transaction, so two sends into
/// chats that share members would otherwise lock the same rows in opposite
/// orders and deadlock.
pub async fn mark_conversation<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    conversation_id: Uuid,
) -> Result<(), sqlx_core::Error> {
    query(
        "WITH marked AS (
             SELECT digest.account_id FROM cloud_account_digests digest
             JOIN cloud_chat_conversation_members member
               ON member.account_id = digest.account_id
             WHERE member.conversation_id = $1 AND member.membership_state = 'active'
             ORDER BY digest.account_id
             FOR UPDATE OF digest
         )
         UPDATE cloud_account_digests digest
         SET dirty_since = COALESCE(digest.dirty_since, now()), last_change_at = now()
         FROM marked WHERE digest.account_id = marked.account_id",
    )
    .bind(conversation_id)
    .execute(executor)
    .await?;
    Ok(())
}

pub async fn mark_accounts<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    account_ids: &[String],
) -> Result<(), sqlx_core::Error> {
    if account_ids.is_empty() {
        return Ok(());
    }
    query(
        "WITH marked AS (
             SELECT account_id FROM cloud_account_digests
             WHERE account_id = ANY($1)
             ORDER BY account_id
             FOR UPDATE
         )
         UPDATE cloud_account_digests digest
         SET dirty_since = COALESCE(digest.dirty_since, now()), last_change_at = now()
         FROM marked WHERE digest.account_id = marked.account_id",
    )
    .bind(account_ids)
    .execute(executor)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(value: &str) -> Value {
        json!({"blocks": [{"type": "text", "text": value}]})
    }

    #[test]
    fn acknowledgements_and_emoji_are_trivial() {
        assert!(is_trivial(&text("ok")));
        assert!(is_trivial(&text("lol thanks")));
        assert!(is_trivial(&text("\u{1f44d}\u{1f602}")));
        assert!(is_trivial(&json!({"blocks": []})));
    }

    #[test]
    fn real_messages_are_not_trivial() {
        assert!(!is_trivial(&text("yes")));
        assert!(!is_trivial(&text("I'll send the report by Friday")));
        assert!(!is_trivial(&text("ok see you at 7")));
    }
}
