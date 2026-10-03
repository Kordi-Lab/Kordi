use std::collections::BTreeSet;

use super::*;

// A removal is terminal for this viewer. Keep its marker even when bootstrap
// replaces the message cache, so an older page or later edit cannot restore it.
//
// The removed message's attachment ids are queued in a connection-scoped
// table that rolls back with the transaction. Call
// `evict_unused_cached_files` after the transaction ends to remove the cached
// files that no remaining message uses.
pub(in crate::canonical_sessions) fn mark_message_deleted(
    tx: &Transaction<'_>,
    account_id: &str,
    message_id: &str,
) -> Result<(), String> {
    mark_message_deleted_with(tx, account_id, message_id, |attachment_ids| {
        // Cache eviction is best effort: queueing never blocks the removal.
        let _ = queue_cache_eviction(tx, account_id, &attachment_ids);
    })
}

/// Records the removal and hands `collect` the attachment ids the removed
/// message used. Nothing is scanned or deleted on disk here.
pub(super) fn mark_message_deleted_with(
    tx: &Transaction<'_>,
    account_id: &str,
    message_id: &str,
    collect: impl FnOnce(BTreeSet<String>),
) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO chat_sync_message_deletions (account_id, message_id)
         VALUES (?1, ?2)",
        params![account_id, message_id],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "DELETE FROM chat_sync_pending_operations WHERE account_id = ?1 AND operation_id IN (
            SELECT client_message_id FROM chat_sync_messages WHERE account_id = ?1 AND message_id = ?2
        )", params![account_id, message_id],
    ).map_err(|error| error.to_string())?;
    // Cache eviction is best effort: a lookup failure never blocks the removal.
    let attachment_ids = stored_attachment_ids(tx, account_id, message_id).unwrap_or_default();
    tx.execute(
        "DELETE FROM chat_sync_messages WHERE account_id = ?1 AND message_id = ?2",
        params![account_id, message_id],
    )
    .map_err(|error| error.to_string())?;
    if !attachment_ids.is_empty() {
        collect(attachment_ids);
    }
    Ok(())
}

fn queue_cache_eviction(
    tx: &Transaction<'_>,
    account_id: &str,
    attachment_ids: &BTreeSet<String>,
) -> Result<(), String> {
    tx.execute_batch(
        "CREATE TEMP TABLE IF NOT EXISTS chat_sync_cache_eviction_candidates (
             account_id TEXT NOT NULL,
             attachment_id TEXT NOT NULL,
             PRIMARY KEY (account_id, attachment_id)
         )",
    )
    .map_err(|error| error.to_string())?;
    for attachment_id in attachment_ids {
        tx.execute(
            "INSERT OR IGNORE INTO temp.chat_sync_cache_eviction_candidates
             (account_id, attachment_id) VALUES (?1, ?2)",
            params![account_id, attachment_id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// After the transaction that removed messages has ended, removes the cached
/// files of queued attachment ids that no remaining message of the account
/// uses. It reads the account's messages once for all of them, and never
/// fails the caller.
pub(in crate::canonical_sessions) fn evict_unused_cached_files(
    conn: &Connection,
    account_id: &str,
) {
    evict_unused_cached_files_with(conn, account_id, |unused| {
        crate::chat::attachments::evict_cloud_attachment_cache(account_id, unused);
    });
}

pub(super) fn evict_unused_cached_files_with(
    conn: &Connection,
    account_id: &str,
    evict: impl FnOnce(&[String]),
) {
    let Ok(candidates) = take_cache_eviction_candidates(conn, account_id) else {
        return;
    };
    if candidates.is_empty() {
        return;
    }
    let unused = unreferenced_attachment_ids(conn, account_id, candidates).unwrap_or_default();
    if !unused.is_empty() {
        evict(&unused);
    }
}

fn take_cache_eviction_candidates(
    conn: &Connection,
    account_id: &str,
) -> Result<BTreeSet<String>, String> {
    let queued: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_temp_master
             WHERE type = 'table' AND name = 'chat_sync_cache_eviction_candidates')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !queued {
        return Ok(BTreeSet::new());
    }
    let candidates = {
        let mut statement = conn
            .prepare(
                "SELECT attachment_id FROM temp.chat_sync_cache_eviction_candidates
                 WHERE account_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([account_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<BTreeSet<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    conn.execute(
        "DELETE FROM temp.chat_sync_cache_eviction_candidates WHERE account_id = ?1",
        [account_id],
    )
    .map_err(|error| error.to_string())?;
    Ok(candidates)
}

/// Attachment ids in a message snapshot, including Live Photo companions.
pub(super) fn snapshot_attachment_ids(snapshot: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    let mut add = |value: Option<&Value>| {
        if let Some(id) = value.and_then(Value::as_str).map(str::trim) {
            if !id.is_empty() {
                ids.insert(id.to_string());
            }
        }
    };
    for value in snapshot
        .get("attachment_ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        add(Some(value));
    }
    for item in snapshot
        .pointer("/content/legacy_attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        add(item.get("attachmentId"));
        for key in ["video", "playback"] {
            add(item
                .get("livePhoto")
                .and_then(|live| live.get(key))
                .and_then(|resource| resource.get("attachmentId")));
        }
    }
    ids
}

fn stored_attachment_ids(
    tx: &Transaction<'_>,
    account_id: &str,
    message_id: &str,
) -> Result<BTreeSet<String>, String> {
    let snapshot = tx
        .query_row(
            "SELECT snapshot_json FROM chat_sync_messages WHERE account_id = ?1 AND message_id = ?2",
            params![account_id, message_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(snapshot
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .map(|value| snapshot_attachment_ids(&value))
        .unwrap_or_default())
}

// A remaining snapshot that mentions an id keeps its cached file. A false
// match only keeps a file longer, which is the safe direction for a cache.
// One pass over the account's messages checks every candidate.
pub(super) fn unreferenced_attachment_ids(
    conn: &Connection,
    account_id: &str,
    attachment_ids: BTreeSet<String>,
) -> Result<Vec<String>, String> {
    let mut remaining = attachment_ids
        .into_iter()
        .map(|id| serde_json::to_string(&id).map(|needle| (id, needle)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare("SELECT snapshot_json FROM chat_sync_messages WHERE account_id = ?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query([account_id])
        .map_err(|error| error.to_string())?;
    while !remaining.is_empty() {
        let Some(row) = rows.next().map_err(|error| error.to_string())? else {
            break;
        };
        let snapshot: String = row.get(0).map_err(|error| error.to_string())?;
        remaining.retain(|(_, needle)| !snapshot.contains(needle.as_str()));
    }
    Ok(remaining.into_iter().map(|(id, _)| id).collect())
}

pub(super) fn load_deleted_message_ids(
    conn: &Connection,
    account_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = conn
        .prepare("SELECT message_id FROM chat_sync_message_deletions WHERE account_id = ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([account_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_chat_sync_deleted_message_ids(
    account_id: String,
) -> Result<Vec<String>, String> {
    super::super::run_canonical_blocking(move || {
        let conn = open_account_db(account_id.trim())?;
        load_deleted_message_ids(&conn, account_id.trim())
    })
    .await
}
