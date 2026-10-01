//! Removes deleted, hidden, and edited messages from stored digests.
//!
//! The read route already hides a digest that cites a source the viewer can
//! no longer read. This module removes the stored copies: digest items that
//! cite the source, the source text kept as evidence, and the input of a run
//! in progress, which is stopped. The digest is marked changed and rebuilds at
//! its next refresh without a model provider being involved here.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// Whose digests a scrub examines.
#[derive(Clone, Copy, Debug)]
pub enum ScrubScope<'a> {
    /// Every account with a membership row of any state in the conversation.
    Conversation(Uuid),
    /// One account's digest.
    Account(&'a str),
}

/// The generated item lists of a digest snapshot.
const ITEM_LISTS: [&str; 4] = ["claims", "commitments", "suggestions", "calendarCandidates"];
/// How often a scrub retries when the digest's active run changes under it.
const MAX_RUN_CHANGES: usize = 3;

/// Removes `source_ids` from the stored digests in `scope`. Returns the number
/// of digests that changed. Each changed digest gets a `digest.updated` hint.
pub async fn scrub_sources(
    pool: &PgPool,
    scope: ScrubScope<'_>,
    source_ids: &[String],
) -> Result<u32> {
    let ids = source_ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
        .collect::<BTreeSet<_>>();
    if ids.is_empty() {
        return Ok(0);
    }
    let patterns = ids.iter().map(|id| like_pattern(id)).collect::<Vec<_>>();
    const MENTIONS: &str = "(digest.snapshot_json::text LIKE ANY($2) \
         OR digest.snapshot_input_json::text LIKE ANY($2) \
         OR digest.input_json::text LIKE ANY($2))";
    let accounts: Vec<(String,)> = match scope {
        ScrubScope::Conversation(conversation_id) => {
            query_as(&format!(
                "SELECT digest.account_id FROM cloud_account_digests digest \
                 WHERE digest.account_id IN (SELECT account_id FROM cloud_chat_conversation_members \
                                             WHERE conversation_id = $1) \
                   AND {MENTIONS} ORDER BY digest.account_id"
            ))
            .bind(conversation_id)
            .bind(&patterns)
            .fetch_all(pool)
            .await?
        }
        ScrubScope::Account(account_id) => {
            query_as(&format!(
                "SELECT digest.account_id FROM cloud_account_digests digest \
                 WHERE digest.account_id = $1 AND {MENTIONS}"
            ))
            .bind(account_id)
            .bind(&patterns)
            .fetch_all(pool)
            .await?
        }
    };
    let mut changed = 0;
    for (account_id,) in accounts {
        if scrub_account(pool, &account_id, &ids).await? {
            changed += 1;
            // A separate transaction after the digest commit, so a scrub never
            // holds a digest row while it waits for the account's stream head.
            publish_digest_hint(pool, &account_id).await;
        }
    }
    Ok(changed)
}

/// Stored digests that cite a message the account can no longer read in the
/// version they recorded: deleted, removed from the account's view, edited
/// since, or gone. Processes up to `limit` accounts after `after_account` and
/// returns the number of digests changed and the cursor for the next page.
pub async fn backfill(
    pool: &PgPool,
    after_account: Option<&str>,
    limit: i64,
) -> Result<(u32, Option<String>)> {
    let limit = limit.max(1);
    let rows: Vec<(String, Option<Value>, Option<Value>)> = query_as(
        "SELECT account_id, snapshot_json, snapshot_input_json FROM cloud_account_digests \
         WHERE ($1::text IS NULL OR account_id > $1) ORDER BY account_id LIMIT $2",
    )
    .bind(after_account)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    let next = (rows.len() as i64 == limit)
        .then(|| rows.last().map(|row| row.0.clone()))
        .flatten();
    let mut changed = 0;
    for (account_id, snapshot, saved_input) in rows {
        let cited = cited_sources(snapshot.as_ref(), saved_input.as_ref());
        if cited.is_empty() {
            continue;
        }
        let message_ids = cited
            .keys()
            .filter_map(|id| Uuid::parse_str(id).ok())
            .collect::<Vec<_>>();
        let current: Vec<(Uuid, i32, bool, bool)> = query_as(
            "SELECT message.message_id, message.version, message.deleted_at IS NOT NULL, \
                    EXISTS (SELECT 1 FROM cloud_chat_message_visibility hidden \
                            WHERE hidden.account_id = $2 AND hidden.message_id = message.message_id) \
             FROM cloud_chat_messages message WHERE message.message_id = ANY($1)",
        )
        .bind(&message_ids)
        .bind(&account_id)
        .fetch_all(pool)
        .await?;
        let current = current
            .into_iter()
            .map(|(id, version, deleted, hidden)| (id.to_string(), (version, deleted || hidden)))
            .collect::<BTreeMap<_, _>>();
        let stale = cited
            .iter()
            .filter(|(id, stored_version)| match current.get(id.as_str()) {
                None => true,
                Some((_, true)) => true,
                Some((version, false)) => stored_version.is_some_and(|stored| stored != *version),
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        if !stale.is_empty()
            && scrub_sources(pool, ScrubScope::Account(&account_id), &stale).await? > 0
        {
            changed += 1;
        }
    }
    Ok((changed, next))
}

/// Source ids a stored digest cites, with the message version recorded in its
/// saved evidence when there is one.
fn cited_sources(
    snapshot: Option<&Value>,
    saved_input: Option<&Value>,
) -> BTreeMap<String, Option<i32>> {
    let mut cited = BTreeMap::new();
    for list in ITEM_LISTS {
        for item in array(snapshot, list) {
            for id in array(Some(item), "sourceIds").filter_map(Value::as_str) {
                cited.entry(id.to_string()).or_insert(None);
            }
        }
    }
    for source in array(saved_input, "sources") {
        if let Some(id) = source.get("id").and_then(Value::as_str) {
            let version = source
                .get("version")
                .and_then(Value::as_i64)
                .and_then(|version| i32::try_from(version).ok());
            cited.insert(id.to_string(), version);
        }
    }
    cited
}

fn array<'a>(value: Option<&'a Value>, key: &str) -> impl Iterator<Item = &'a Value> {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// A `LIKE` pattern that matches the id as a JSON string anywhere in a
/// document's text.
fn like_pattern(id: &str) -> String {
    let quoted = serde_json::to_string(id).unwrap_or_default();
    let mut pattern = String::from("%");
    for character in quoted.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

/// Whether any string in `value` is one of `ids`.
pub(super) fn mentions_any(value: &Value, ids: &BTreeSet<String>) -> bool {
    match value {
        Value::String(text) => ids.contains(text),
        Value::Array(items) => items.iter().any(|item| mentions_any(item, ids)),
        Value::Object(fields) => fields.values().any(|field| mentions_any(field, ids)),
        _ => false,
    }
}

fn cites_any(item: &Value, ids: &BTreeSet<String>) -> bool {
    array(Some(item), "sourceIds")
        .filter_map(Value::as_str)
        .any(|id| ids.contains(id))
}

/// Removes generated items that cite any of `ids`, the same rule the next
/// generation applies to evidence that changed. Returns whether it changed.
pub(super) fn remove_citing_items(snapshot: &mut Value, ids: &BTreeSet<String>) -> bool {
    let mut changed = false;
    for list in ITEM_LISTS {
        if let Some(items) = snapshot.get_mut(list).and_then(Value::as_array_mut) {
            let before = items.len();
            items.retain(|item| !cites_any(item, ids));
            changed |= items.len() != before;
        }
    }
    changed
}

/// Removes the sources and calendar context that cite `ids` from saved digest
/// evidence, and drops the previous report and change set, which only a run
/// reads. Returns whether any copy of the ids was removed.
pub(super) fn scrub_saved_input(input: &mut Value, ids: &BTreeSet<String>) -> bool {
    let Some(fields) = input.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if let Some(sources) = fields.get_mut("sources").and_then(Value::as_array_mut) {
        let before = sources.len();
        sources.retain(|source| {
            !source
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| ids.contains(id))
        });
        changed |= sources.len() != before;
    }
    if let Some(events) = fields
        .get_mut("calendarEvents")
        .and_then(Value::as_array_mut)
    {
        let before = events.len();
        events.retain(|event| !cites_any(event, ids));
        changed |= events.len() != before;
    }
    for key in ["previous", "changes"] {
        if let Some(value) = fields.get_mut(key) {
            changed |= mentions_any(value, ids);
            *value = Value::Null;
        }
    }
    changed
}

/// Scrubs one account's digest. The run row is locked before the digest row,
/// the same order as digest completion and failure.
async fn scrub_account(pool: &PgPool, account_id: &str, ids: &BTreeSet<String>) -> Result<bool> {
    for _ in 0..MAX_RUN_CHANGES {
        let observed: Option<(Option<String>,)> =
            query_as("SELECT active_run_id FROM cloud_account_digests WHERE account_id = $1")
                .bind(account_id)
                .fetch_optional(pool)
                .await?;
        let Some((observed_run,)) = observed else {
            return Ok(false);
        };
        let mut transaction = pool.begin().await?;
        if let Some(run_id) = &observed_run {
            query("SELECT 1 FROM cloud_agent_fallback_runs WHERE run_id = $1 FOR UPDATE")
                .bind(run_id)
                .execute(&mut *transaction)
                .await?;
        }
        type DigestRow = (Option<String>, Option<Value>, Option<Value>, Value);
        let row: Option<DigestRow> = query_as(
            "SELECT active_run_id, snapshot_json, snapshot_input_json, input_json \
             FROM cloud_account_digests WHERE account_id = $1 FOR UPDATE",
        )
        .bind(account_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some((active_run, mut snapshot, mut saved_input, input)) = row else {
            return Ok(false);
        };
        if active_run != observed_run {
            transaction.rollback().await?;
            continue;
        }
        let input_mentions = mentions_any(&input, ids);
        let mut changed = false;
        let mut run_remains = active_run.is_some();
        if let (Some(run_id), true) = (&active_run, input_mentions) {
            // The run in progress read the removed text: stop it the way a
            // source change stops it, and let the digest retry at once.
            query(
                "UPDATE cloud_agent_fallback_runs SET status = 'failed', \
                     error_code = 'sources_changed', error_message = 'Digest update failed.', \
                     prompt = '', updated_at = $2 \
                 WHERE run_id = $1 AND status IN ('queued', 'leased', 'running')",
            )
            .bind(run_id)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(&mut *transaction)
            .await?;
            query(
                "UPDATE cloud_account_digests SET active_run_id = NULL, \
                     error_code = 'sources_changed', input_hash = '', \
                     retry_after = now() + interval '1 second' \
                 WHERE account_id = $1",
            )
            .bind(account_id)
            .execute(&mut *transaction)
            .await?;
            run_remains = false;
            changed = true;
        }
        if let Some(snapshot) = snapshot.as_mut() {
            changed |= remove_citing_items(snapshot, ids);
        }
        if let Some(saved_input) = saved_input.as_mut() {
            changed |= scrub_saved_input(saved_input, ids);
        }
        changed |= input_mentions && !run_remains;
        if !changed {
            transaction.rollback().await?;
            return Ok(false);
        }
        query(
            "UPDATE cloud_account_digests SET snapshot_json = $2, snapshot_input_json = $3, \
                 input_json = CASE WHEN $4 THEN '{}'::jsonb ELSE input_json END, \
                 input_hash = '', dirty_since = COALESCE(dirty_since, now()), \
                 last_change_at = now(), revision = revision + 1, updated_at = now() \
             WHERE account_id = $1",
        )
        .bind(account_id)
        .bind(snapshot)
        .bind(saved_input)
        .bind(!run_remains)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        return Ok(true);
    }
    Err(sqlx_core::Error::Protocol(
        "digest run changed during content removal".into(),
    ))
}

/// Tells the account's devices to reload the digest. Best effort: the digest
/// is already saved, and devices also reload it when it is opened.
async fn publish_digest_hint(pool: &PgPool, account_id: &str) {
    let published = async {
        let mut transaction = pool.begin().await?;
        crate::chat_sync::store::append_account_hint(
            &mut transaction,
            account_id,
            "digest.updated",
            &json!({ "updated": true }),
        )
        .await
        .map_err(|_| sqlx_core::Error::Protocol("digest hint".into()))?;
        transaction.commit().await
    }
    .await;
    if published.is_err() {
        eprintln!("[content-removal] digest hint outcome=error:database_error");
    }
}

#[cfg(test)]
#[path = "redaction_tests.rs"]
mod tests;
