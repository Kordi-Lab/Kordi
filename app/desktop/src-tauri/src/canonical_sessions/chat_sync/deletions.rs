use std::collections::BTreeSet;

use super::*;

// A removal is terminal for this viewer. Keep its marker even when bootstrap
// replaces the message cache, so an older page or later edit cannot restore it.
pub(in crate::canonical_sessions) fn mark_message_deleted(
    tx: &Transaction<'_>,
    account_id: &str,
    message_id: &str,
) -> Result<(), String> {
    mark_message_deleted_with(tx, account_id, message_id, |attachment_ids| {
        crate::chat::attachments::evict_cloud_attachment_cache(account_id, attachment_ids);
    })
}

/// Records the removal, then hands `evict` the attachment ids that no remaining
/// message of this account uses, so their cached files can be removed.
pub(super) fn mark_message_deleted_with(
    tx: &Transaction<'_>,
    account_id: &str,
    message_id: &str,
    evict: impl FnOnce(&[String]),
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
    let unused = unreferenced_attachment_ids(tx, account_id, attachment_ids).unwrap_or_default();
    if !unused.is_empty() {
        evict(&unused);
    }
    Ok(())
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

// A remaining snapshot that mentions the id keeps the cached file. A false
// match only keeps a file longer, which is the safe direction for a cache.
fn unreferenced_attachment_ids(
    tx: &Transaction<'_>,
    account_id: &str,
    attachment_ids: BTreeSet<String>,
) -> Result<Vec<String>, String> {
    let mut unused = Vec::new();
    for attachment_id in attachment_ids {
        let needle = serde_json::to_string(&attachment_id).map_err(|error| error.to_string())?;
        let referenced: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_sync_messages
                 WHERE account_id = ?1 AND instr(snapshot_json, ?2) > 0)",
                params![account_id, needle],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !referenced {
            unused.push(attachment_id);
        }
    }
    Ok(unused)
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
