//! "Don't let AI use my messages" for this Mac's own assistant.
//!
//! Members can ask that other people's AI leave out what they write in a
//! conversation. The server applies this to every agent it serves; this module
//! applies it when the signed-in person's private assistant searches or reads
//! a cloud-synced conversation from the local cache. Only the exclusions apply
//! here, not the group's "What agents can see" setting: a private assistant
//! reads with its owner's own view.
//!
//! The list comes from the `ai_access` field of the conversation snapshot the
//! server sent, stored in `chat_sync_conversations.snapshot_json`:
//! `excluded_account_ids` (everyone with the setting on, including members
//! who left, so their earlier messages stay out) together with
//! `excluded_member_ids` (the active members, all an older server sends). A
//! message is left out when a person on the list wrote it, unless that person
//! is the signed-in account. When the list is not empty, a message whose
//! author cannot be matched to an account is left out too.

use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde_json::Value;

/// The account signed in on this Mac, when there is one.
pub(super) fn signed_in_account() -> Option<String> {
    crate::cloud_session::cloud_session_load()
        .ok()
        .flatten()
        .map(|session| session.account_id.trim().to_string())
        .filter(|account_id| !account_id.is_empty())
}

/// Accounts whose messages the viewer's assistant must leave out of this
/// session. Without a known viewer, every stored snapshot of the session
/// counts and no one is exempt.
pub(super) fn excluded_accounts(
    conn: &Connection,
    session_id: &str,
    viewer: Option<&str>,
) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT snapshot_json FROM chat_sync_conversations
             WHERE client_session_id = ?1 AND (?2 IS NULL OR account_id = ?2)",
        )
        .map_err(|err| err.to_string())?;
    let snapshots = stmt
        .query_map(params![session_id, viewer], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;
    let mut excluded = HashSet::new();
    for snapshot in snapshots {
        let Ok(value) = serde_json::from_str::<Value>(&snapshot) else {
            continue;
        };
        let Some(access) = value.get("ai_access") else {
            continue;
        };
        for key in ["excluded_account_ids", "excluded_member_ids"] {
            excluded.extend(
                access
                    .get(key)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .map(ToString::to_string),
            );
        }
    }
    if let Some(viewer) = viewer {
        excluded.remove(viewer);
    }
    Ok(excluded)
}

/// Whether a stored message may reach the assistant. `sender_kind` and
/// `sender_account` describe the message's author identity, when known.
pub(super) fn admits(
    excluded: &HashSet<String>,
    sender_kind: Option<&str>,
    sender_account: Option<&str>,
) -> bool {
    if excluded.is_empty() {
        return true;
    }
    match (sender_kind, sender_account.map(str::trim)) {
        // Replies written by agents are not covered by the setting.
        (Some("agent"), _) => true,
        (Some("human"), Some(account)) if !account.is_empty() => !excluded.contains(account),
        // The author is unknown: leave the message out.
        _ => false,
    }
}

/// Ids of messages in this session that the viewer's assistant must leave out.
/// Empty when no one in the conversation turned the setting on.
pub(super) fn hidden_message_ids(
    conn: &Connection,
    session_id: &str,
    viewer: Option<&str>,
) -> Result<HashSet<String>, String> {
    let excluded = excluded_accounts(conn, session_id, viewer)?;
    if excluded.is_empty() {
        return Ok(HashSet::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT m.id, i.kind, i.human_id
             FROM session_messages m
             LEFT JOIN identities i ON i.id = m.sender_identity_id
             WHERE m.session_id = ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    let mut hidden = HashSet::new();
    for row in rows {
        let (id, kind, account) = row.map_err(|err| err.to_string())?;
        if !admits(&excluded, kind.as_deref(), account.as_deref()) {
            hidden.insert(id);
        }
    }
    Ok(hidden)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(values: &[&str]) -> HashSet<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn nothing_is_left_out_while_no_one_turned_the_setting_on() {
        assert!(admits(&set(&[]), None, None));
        assert!(admits(&set(&[]), Some("human"), Some("acct_c")));
    }

    #[test]
    fn people_on_the_list_are_left_out_but_agent_replies_are_not() {
        let excluded = set(&["acct_c"]);
        assert!(!admits(&excluded, Some("human"), Some("acct_c")));
        assert!(admits(&excluded, Some("human"), Some("acct_b")));
        assert!(admits(&excluded, Some("agent"), Some("acct_c")));
    }

    #[test]
    fn unknown_authors_are_left_out_once_someone_turned_it_on() {
        let excluded = set(&["acct_c"]);
        assert!(!admits(&excluded, None, None));
        assert!(!admits(&excluded, Some("human"), None));
        assert!(!admits(&excluded, Some("human"), Some("  ")));
        assert!(!admits(&excluded, Some("system"), Some("acct_b")));
    }
}
