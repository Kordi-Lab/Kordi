use anyhow::Result;
use kordi_core::types::{EntryId, SessionEntry};
use rusqlite::Connection;
use std::collections::HashSet;

use super::{
    ForkSessionResult, append_entry, create_session_with_parent_and_message, get_entries,
    get_entry, parse_entry, set_leaf,
};

pub(super) fn copy_branch_to_session(
    conn: &Connection,
    source_session_id: &str,
    target_session_id: &str,
    leaf_id: &str,
) -> Result<()> {
    let path_rows = crate::tree::walk_to_root(conn, source_session_id, leaf_id)?;
    let mut copied_entry_ids = HashSet::new();
    let mut last_path_id: Option<String> = None;

    for row in &path_rows {
        let entry = parse_entry(row)?;
        copied_entry_ids.insert(row.entry_id.clone());
        last_path_id = Some(row.entry_id.clone());
        append_entry(conn, target_session_id, &entry)?;
    }

    let all_rows = get_entries(conn, source_session_id)?;
    let mut label_entries: Vec<SessionEntry> = all_rows
        .iter()
        .filter_map(|row| {
            let entry = parse_entry(row).ok()?;
            match entry {
                SessionEntry::Label {
                    base,
                    target_id,
                    label,
                } if copied_entry_ids.contains(target_id.as_str()) => Some(SessionEntry::Label {
                    base: kordi_core::types::EntryBase {
                        id: base.id,
                        parent_id: last_path_id.clone().map(EntryId),
                        timestamp: base.timestamp,
                    },
                    target_id,
                    label,
                }),
                _ => None,
            }
        })
        .collect();

    label_entries.sort_by_key(|entry| entry.base().timestamp);
    let mut label_parent_id = last_path_id.clone();
    for entry in label_entries {
        let entry = match entry {
            SessionEntry::Label {
                base,
                target_id,
                label,
            } => SessionEntry::Label {
                base: kordi_core::types::EntryBase {
                    id: base.id,
                    parent_id: label_parent_id.clone().map(EntryId),
                    timestamp: base.timestamp,
                },
                target_id,
                label,
            },
            other => other,
        };
        label_parent_id = Some(entry.base().id.0.clone());
        append_entry(conn, target_session_id, &entry)?;
    }

    if let Some(last_path_id) = last_path_id {
        set_leaf(conn, target_session_id, Some(&last_path_id))?;
    }

    Ok(())
}

pub(super) fn fork_session_from_entry(
    conn: &Connection,
    source_session_id: &str,
    entry_id: &str,
    cwd: &str,
) -> Result<ForkSessionResult> {
    // Fork-AT semantics: the new session contains every entry on the
    // path from root → clicked entry, *including* the clicked entry.
    // The clicked entry becomes the new session's leaf so the user can
    // continue the conversation immediately from where they branched.
    let row = get_entry(conn, source_session_id, entry_id)?
        .ok_or_else(|| anyhow::anyhow!("Entry not found: {entry_id}"))?;

    let new_session_id =
        create_session_with_parent_and_message(conn, cwd, Some(source_session_id), Some(entry_id))?;
    copy_branch_to_session(conn, source_session_id, &new_session_id, entry_id)?;

    let _ = row; // existence verified above; payload no longer needed

    Ok(ForkSessionResult {
        session_id: new_session_id,
        selected_text: String::new(),
        branch_leaf_id: Some(entry_id.to_string()),
        source_session_id: source_session_id.to_string(),
        source_entry_id: entry_id.to_string(),
    })
}
