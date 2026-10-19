//! When a digest needs to rerun.
//!
//! A digest used to rebuild its whole input every few seconds and rerun the
//! model after any change. Now only a change that can matter to a person's
//! digest marks it: a new message from someone else, or a calendar, task,
//! reminder or connector change. The person's own messages, their agents'
//! replies, reactions, and edits or deletions of messages already in the
//! digest do not; they reach the digest at its next run. The worker reruns a
//! marked digest once the person's chats have been quiet for a while (or a
//! maximum wait has passed), within hourly and daily caps. A slow safety
//! check still catches anything not marked here, such as task updates.

use serde_json::Value;
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_postgres::Postgres;

use super::incremental::Changes;
use super::models::Input;
use crate::chat_sync::models::MessageSnapshot;
use std::collections::HashSet;

/// Reruns wait until a person's chats have been quiet this long.
pub const QUIET_WINDOW_MINUTES: i64 = 5;
/// A marked digest never waits longer than this after its first change.
pub const MAX_WAIT_MINUTES: i64 = 30;
/// Unmarked digests are still checked this often.
pub const SAFETY_CHECK_MINUTES: i64 = 30;
/// Automatic runs per account. Pressing refresh is never capped.
pub const AUTOMATIC_RUNS_PER_HOUR: i64 = 4;
pub const AUTOMATIC_RUNS_PER_DAY: i64 = 30;
/// Opening the digest starts a run only for a snapshot at least this old,
/// and at most once per this interval however often clients poll.
pub const OPEN_REFRESH_MINUTES: i64 = 15;
/// A run whose sources changed before it ran waits this long to retry.
pub const SOURCES_CHANGED_RETRY_MINUTES: i64 = 2;

const ACKNOWLEDGEMENTS: &[&str] = &[
    "ok", "okay", "k", "kk", "lol", "lmao", "haha", "hahaha", "hehe", "thanks", "thank", "you",
    "thx", "ty", "nice", "cool", "wow", "yay", "great",
];

/// A message that cannot change a digest on its own: no readable text, or
/// only emoji, punctuation, and a short acknowledgement. Such messages still
/// reach the digest at its next run.
pub fn is_trivial(content: &Value) -> bool {
    super::source_reader::visible_text(content).is_none_or(|text| is_trivial_text(&text))
}

pub(super) fn is_trivial_text(text: &str) -> bool {
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

/// Whether the changes since the saved input can matter to the viewer's
/// digest. Without a saved input every change matters (a first build).
pub(super) fn relevant(saved: Option<&Input>, changes: Option<&Changes>, viewer: &str) -> bool {
    let (Some(saved), Some(changes)) = (saved, changes) else {
        return true;
    };
    let pip = crate::pip::service_account_id();
    let digested: HashSet<_> = saved.sources.iter().map(|source| &source.id).collect();
    changes.sources.iter().any(|source| {
        source.sender_account_id != viewer
            && pip != Some(source.sender_account_id.as_str())
            && !digested.contains(&source.id)
            && !is_trivial_text(&source.text)
    }) || !changes.calendar_events.is_empty()
        || !changes.removed_calendar_event_ids.is_empty()
        || !changes.existing_tasks.is_empty()
        || !changes.removed_task_ids.is_empty()
        || !changes.newly_due_reminder_ids.is_empty()
        || !changes.connector_events.is_empty()
        || changes.preferences_changed
}

/// After a message write, marks the digests of the other members of its
/// conversation when the write can matter to them, and records the sender's
/// activity. The sender's own digest is never marked: their own messages and
/// their agents' replies (sent under their account) are not news to them.
/// Edits and deletions mark only members whose digest never saw the message,
/// such as an agent reply that finished generating.
pub async fn note_message<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    event_type: &str,
    message: &MessageSnapshot,
) -> Result<(), sqlx_core::Error> {
    if crate::pip::service_account_id() == Some(message.sender_account_id.as_str()) {
        return Ok(());
    }
    let deleted = event_type == "message.deleted" || message.deleted_at.is_some();
    let generating = message
        .generation_status
        .as_deref()
        .is_some_and(|status| !matches!(status, "complete" | "completed"));
    if deleted || generating {
        return Ok(());
    }
    let news = !is_trivial(&message.content);
    // Digest rows are locked in account order before they are marked. A
    // message send marks its members inside the send's transaction, so two
    // sends into chats that share members would otherwise lock the same rows
    // in opposite orders and deadlock.
    query(
        "WITH marked AS (
             SELECT digest.account_id FROM cloud_account_digests digest
             JOIN cloud_chat_conversation_members member
               ON member.account_id = digest.account_id
             WHERE member.conversation_id = $1 AND member.membership_state = 'active'
             ORDER BY digest.account_id
             FOR UPDATE OF digest
         ), news AS (
             SELECT digest.account_id,
                 $3 AND digest.account_id <> $2
                 AND NOT COALESCE(digest.snapshot_input_json->'sources', '[]'::jsonb) @> $4 AS marks
             FROM cloud_account_digests digest JOIN marked USING (account_id)
         )
         UPDATE cloud_account_digests digest
         SET owner_active_at = CASE WHEN digest.account_id = $2 THEN now() ELSE digest.owner_active_at END,
             dirty_since = CASE WHEN news.marks THEN COALESCE(digest.dirty_since, now()) ELSE digest.dirty_since END,
             last_change_at = CASE WHEN news.marks THEN now() ELSE digest.last_change_at END
         FROM news WHERE digest.account_id = news.account_id
           AND (news.marks OR digest.account_id = $2)",
    )
    .bind(message.conversation_id)
    .bind(&message.sender_account_id)
    .bind(news)
    .bind(serde_json::json!([{ "id": message.id.to_string() }]))
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

    fn source(id: &str, sender: &str, text: &str) -> super::super::models::Source {
        let mut source = super::super::tests::input().sources.remove(0);
        source.id = id.into();
        source.sender_account_id = sender.into();
        source.text = text.into();
        source
    }

    #[test]
    fn only_new_messages_from_other_people_are_relevant() {
        let saved = super::super::tests::input();
        let relevant = |sources: Vec<_>| {
            let changes = Changes {
                sources,
                ..Default::default()
            };
            super::relevant(Some(&saved), Some(&changes), "viewer")
        };
        assert!(!relevant(vec![]));
        assert!(!relevant(vec![source(
            "own",
            "viewer",
            "I'll send it Friday"
        )]));
        assert!(!relevant(vec![source("m1", "author", "Edited text")]));
        assert!(!relevant(vec![source("ack", "author", "ok thanks")]));
        assert!(relevant(vec![source(
            "new",
            "author",
            "Can you join at 3pm?"
        )]));
        let calendar = Changes {
            removed_calendar_event_ids: vec!["event".into()],
            ..Default::default()
        };
        assert!(super::relevant(Some(&saved), Some(&calendar), "viewer"));
        assert!(super::relevant(None, None, "viewer"), "a first build");
    }

    #[test]
    fn real_messages_are_not_trivial() {
        assert!(!is_trivial(&text("yes")));
        assert!(!is_trivial(&text("I'll send the report by Friday")));
        assert!(!is_trivial(&text("ok see you at 7")));
    }
}
