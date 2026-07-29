use anyhow::Result;
use kordi_core::types::{SessionContext, SessionEntry, ThinkingLevel};
use rusqlite::Connection;

use crate::store::{self, EntryRow};
use crate::tree;

mod assembly;
mod formatting;
#[cfg(test)]
mod tests;

/// Context information derived from one active session path.
///
/// This keeps desktop and terminal presentation layers aligned on when
/// persisted usage is trustworthy after compaction.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ActivePathContextState {
    pub estimated_tokens: Option<u64>,
    pub has_contextful_entries: bool,
    pub latest_entry_is_compaction: bool,
}

/// Derive context state from a pre-computed active path.
///
/// Assistant usage recorded before the latest compaction must not be reused.
/// Until a successful assistant response records fresh usage after that
/// boundary, token usage remains unknown.
pub fn active_path_context_state(path: &[EntryRow]) -> ActivePathContextState {
    let latest_compaction_index = path.iter().rposition(|row| row.entry_type == "compaction");
    let has_fresh_post_compaction_usage = latest_compaction_index.is_none_or(|compaction_index| {
        path.iter().skip(compaction_index + 1).rev().any(|row| {
            let Ok(entry) = store::parse_entry(row) else {
                return false;
            };
            match entry {
                SessionEntry::Message {
                    message: kordi_core::types::AgentMessage::Assistant(assistant),
                    ..
                } => {
                    assistant.stop_reason != kordi_core::types::StopReason::Aborted
                        && assistant.stop_reason != kordi_core::types::StopReason::Error
                        && crate::compaction::calculate_context_tokens(&assistant.usage) > 0
                }
                _ => false,
            }
        })
    });

    let estimated_tokens = if has_fresh_post_compaction_usage {
        build_context_from_path(path)
            .ok()
            .map(|context| crate::compaction::estimate_context_tokens(&context.messages).tokens)
    } else {
        None
    };

    ActivePathContextState {
        estimated_tokens,
        has_contextful_entries: path.iter().any(|row| row.entry_type == "message"),
        latest_entry_is_compaction: path
            .last()
            .is_some_and(|row| row.entry_type == "compaction"),
    }
}

/// Build the session context (what gets sent to the LLM).
///
/// Walks root → leaf, applies compaction boundary, returns messages.
pub fn build_context(conn: &Connection, session_id: &str) -> Result<SessionContext> {
    let path = tree::active_path(conn, session_id)?;
    build_context_from_path(&path)
}

/// Return the latest explicitly recorded thinking level on the active path, if any.
///
/// This scans the full active path without applying compaction boundaries so resume
/// logic can distinguish an actual persisted `off` from "no explicit thinking level
/// was ever recorded for this session".
pub fn active_path_explicit_thinking_level(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<ThinkingLevel>> {
    let path = tree::active_path(conn, session_id)?;
    explicit_thinking_level_from_path(&path)
}

/// Return the latest explicitly recorded thinking level on a path, if any.
pub fn explicit_thinking_level_from_path(path: &[EntryRow]) -> Result<Option<ThinkingLevel>> {
    for row in path.iter().rev() {
        if let SessionEntry::ThinkingLevelChange { thinking_level, .. } = store::parse_entry(row)? {
            return Ok(Some(thinking_level));
        }
    }
    Ok(None)
}

/// Build context from a pre-computed path (for testing / reuse).
pub fn build_context_from_path(path: &[EntryRow]) -> Result<SessionContext> {
    if path.is_empty() {
        return Ok(SessionContext {
            messages: Vec::new(),
            thinking_level: kordi_core::types::ThinkingLevel::Off,
            model: None,
        });
    }

    let entries: Vec<SessionEntry> = path
        .iter()
        .map(store::parse_entry)
        .collect::<Result<Vec<_>>>()?;

    Ok(assembly::build_context_from_entries(&entries))
}
