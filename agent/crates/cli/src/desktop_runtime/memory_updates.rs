//! Memory change notes. The system prompt keeps the memories it was built
//! with; when memories change during a conversation, the next message is
//! preceded by a hidden, persisted "memory update" note.

use anyhow::Result;
use kordi_core::types::{ContentBlock, EntryBase, EntryId, SessionEntry};
use rusqlite::OptionalExtension;

use super::{DesktopRuntimeSession, ensure_session_row_created};
use crate::session_bootstrap::memory::{
    MEMORY_CONTEXT_END, MemorySnapshotEntry, memory_scope_heading, memory_update_message,
};

/// Custom entry with the memories the model was last told about.
pub(crate) const MEMORY_SNAPSHOT_CUSTOM_TYPE: &str = "memory_snapshot";
/// Hidden custom message that tells the model its memories changed.
pub(crate) const MEMORY_UPDATE_CUSTOM_TYPE: &str = "memory_update";

impl DesktopRuntimeSession {
    /// Compare the current memories with the last ones the model saw and, when
    /// they differ, append a hidden `memory_update` note plus a new snapshot
    /// before the next user message. Writes nothing when memory is off.
    pub fn record_memory_updates(&mut self) -> Result<()> {
        let Some(inputs) = self.setup.memory_prompt.clone() else {
            return Ok(());
        };
        let current = inputs.current(&self.setup.session_id);
        let previous = match self.latest_memory_snapshot()? {
            Some(previous) => previous,
            // The prompt already shows the current memories; only record them.
            None if self.effective_system_prompt()?.contains(MEMORY_CONTEXT_END) => {
                return self.append_memory_entry(snapshot_entry(&current));
            }
            None => Vec::new(),
        };
        let Some(text) = memory_update_message(&previous, &current) else {
            return Ok(());
        };
        self.append_memory_entry(SessionEntry::CustomMessage {
            base: new_base(),
            custom_type: MEMORY_UPDATE_CUSTOM_TYPE.into(),
            display: false,
            content: vec![ContentBlock::Text { text }],
            details: None,
        })?;
        self.append_memory_entry(snapshot_entry(&current))
    }

    fn latest_memory_snapshot(&self) -> Result<Option<Vec<MemorySnapshotEntry>>> {
        let raw: Option<String> = self.setup.conn.query_row(
            "SELECT json_extract(payload,'$.data.memories') FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')=?2 ORDER BY seq DESC LIMIT 1",
            [&self.setup.session_id, MEMORY_SNAPSHOT_CUSTOM_TYPE], |row| row.get(0),
        ).optional()?;
        let Some(raw) = raw else {
            return Ok(None);
        };
        let memories = serde_json::from_str::<Vec<serde_json::Value>>(&raw)?
            .iter()
            .filter_map(|memory| {
                let scope = memory.get("scope")?.as_str()?;
                Some(MemorySnapshotEntry {
                    scope: scope.to_string(),
                    heading: memory_scope_heading(scope),
                    text: memory.get("text")?.as_str()?.to_string(),
                })
            })
            .collect();
        Ok(Some(memories))
    }

    /// The prompt the model sees this turn: the frozen identity header when
    /// one exists, otherwise the session's prompt.
    fn effective_system_prompt(&self) -> Result<String> {
        let frozen: Option<String> = self.setup.conn.query_row(
            "SELECT json_extract(payload,'$.data.systemPrompt') FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')='runtime_identity_prompt' ORDER BY seq LIMIT 1",
            [&self.setup.session_id], |row| row.get(0),
        ).optional()?;
        Ok(frozen.unwrap_or_else(|| self.setup.system_prompt.clone()))
    }

    fn append_memory_entry(&mut self, mut entry: SessionEntry) -> Result<()> {
        ensure_session_row_created(&mut self.setup)?;
        let parent_id =
            kordi_session::store::get_session(&self.setup.conn, &self.setup.session_id)?
                .and_then(|session| session.leaf_id)
                .map(EntryId);
        if let SessionEntry::Custom { base, .. } | SessionEntry::CustomMessage { base, .. } =
            &mut entry
        {
            base.parent_id = parent_id;
        }
        kordi_session::store::append_entry(&self.setup.conn, &self.setup.session_id, &entry)?;
        Ok(())
    }
}

/// A fresh entry base; `append_memory_entry` sets the parent.
fn new_base() -> EntryBase {
    EntryBase {
        id: EntryId::generate(),
        parent_id: None,
        timestamp: chrono::Utc::now(),
    }
}

fn snapshot_entry(memories: &[MemorySnapshotEntry]) -> SessionEntry {
    let memories = memories
        .iter()
        .map(|memory| serde_json::json!({"scope": memory.scope, "text": memory.text}))
        .collect::<Vec<_>>();
    SessionEntry::Custom {
        base: new_base(),
        custom_type: MEMORY_SNAPSHOT_CUSTOM_TYPE.into(),
        data: Some(serde_json::json!({ "memories": memories })),
    }
}
