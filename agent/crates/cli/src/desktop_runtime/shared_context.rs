use anyhow::{Result, anyhow};
use chrono::{DateTime, Utc};
use kordi_core::types::{ContentBlock, EntryBase, EntryId, SessionEntry};
use rusqlite::OptionalExtension;
use std::collections::HashSet;

use super::{
    CLOUD_AGENT_CONTEXT_CUSTOM_TYPE, DesktopChatContextMessage, DesktopRuntimeSession,
    ensure_session_row_created, prompt_context,
};

impl DesktopRuntimeSession {
    /// Persist retrieval access separately from provider-visible messages so reopening
    /// a linked task cannot silently expand its search scope to the owner's chats.
    pub fn group_observation_context(
        &mut self,
        session_id: Option<&str>,
        directory: Option<&str>,
    ) -> Result<Option<(String, Option<String>)>> {
        let raw: Option<String> = self.setup.conn.query_row(
            "SELECT json_extract(payload, '$.data') FROM entries WHERE session_id = ?1 AND type = 'custom' AND json_extract(payload, '$.custom_type') = 'group_observation_scope' ORDER BY seq DESC LIMIT 1",
            [&self.setup.session_id], |row| row.get(0),
        ).optional()?;
        let stored = raw
            .map(|raw| -> Result<_> {
                let data: serde_json::Value = serde_json::from_str(&raw)?;
                let scope = data["sessionId"]
                    .as_str()
                    .filter(|scope| !scope.trim().is_empty())
                    .ok_or_else(|| anyhow!("Invalid group observation scope"))?;
                Ok((
                    scope.to_string(),
                    data["directory"].as_str().map(str::to_string),
                ))
            })
            .transpose()?;
        let Some(session_id) = session_id else {
            return Ok(stored);
        };
        let next = (
            session_id.to_string(),
            directory.map(str::to_string).or_else(|| {
                stored
                    .as_ref()
                    .filter(|(scope, _)| scope == session_id)
                    .and_then(|(_, directory)| directory.clone())
            }),
        );
        if stored.as_ref() != Some(&next) {
            ensure_session_row_created(&mut self.setup)?;
            let parent_id =
                kordi_session::store::get_session(&self.setup.conn, &self.setup.session_id)?
                    .and_then(|session| session.leaf_id)
                    .map(EntryId);
            let entry = SessionEntry::Custom {
                base: EntryBase {
                    id: EntryId::generate(),
                    parent_id,
                    timestamp: Utc::now(),
                },
                custom_type: "group_observation_scope".to_string(),
                data: Some(serde_json::json!({"sessionId": next.0, "directory": next.1})),
            };
            kordi_session::store::append_entry(&self.setup.conn, &self.setup.session_id, &entry)?;
        }
        Ok(Some(next))
    }

    pub fn sync_context_messages(
        &mut self,
        messages: &[DesktopChatContextMessage],
    ) -> Result<usize> {
        self.set_dynamic_system_context(prompt_context::system_context(messages));
        let history_messages = messages.iter().filter(|message| {
            !prompt_context::is_system_context(message)
                && message.context_role.as_deref() != Some("resource")
        });
        if messages.is_empty() {
            return Ok(0);
        }
        ensure_session_row_created(&mut self.setup)?;

        let mut imported_ids = HashSet::new();
        for row in kordi_session::store::get_entries(&self.setup.conn, &self.setup.session_id)? {
            let Ok(SessionEntry::CustomMessage {
                custom_type,
                details,
                ..
            }) = serde_json::from_str::<SessionEntry>(&row.payload)
            else {
                continue;
            };
            if custom_type != CLOUD_AGENT_CONTEXT_CUSTOM_TYPE {
                continue;
            }
            if let Some(id) = details
                .as_ref()
                .and_then(|value| value.get("cloudMessageId"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                imported_ids.insert(id.to_string());
            }
        }

        let mut count = 0;
        for message in history_messages {
            let id = message.id.trim();
            let author_name = message.author_name.trim();
            let text = message.text.trim();
            if id.is_empty() || author_name.is_empty() || text.is_empty() {
                continue;
            }
            if !imported_ids.insert(id.to_string()) {
                continue;
            }
            let author_kind = if message.author_kind.trim().eq_ignore_ascii_case("agent") {
                "agent"
            } else {
                "human"
            };
            let timestamp = message
                .created_at_ms
                .and_then(DateTime::<Utc>::from_timestamp_millis)
                .unwrap_or_else(Utc::now);
            let parent_id =
                kordi_session::store::get_session(&self.setup.conn, &self.setup.session_id)?
                    .and_then(|session| session.leaf_id)
                    .map(EntryId);
            let entry = SessionEntry::CustomMessage {
                base: EntryBase {
                    id: EntryId::generate(),
                    parent_id,
                    timestamp,
                },
                custom_type: CLOUD_AGENT_CONTEXT_CUSTOM_TYPE.to_string(),
                content: vec![ContentBlock::Text {
                    text: format!("{author_name} ({author_kind}): {text}"),
                }],
                display: false,
                details: Some(serde_json::json!({
                    "cloudMessageId": id,
                    "authorName": author_name,
                    "authorKind": author_kind,
                })),
            };
            kordi_session::store::append_entry(&self.setup.conn, &self.setup.session_id, &entry)?;
            count += 1;
        }
        Ok(count)
    }

    pub fn sync_shared_context_messages(
        &mut self,
        messages: &[DesktopChatContextMessage],
    ) -> Result<()> {
        self.set_dynamic_system_context(prompt_context::system_context(messages));
        ensure_session_row_created(&mut self.setup)?;
        let parent_id =
            kordi_session::store::get_session(&self.setup.conn, &self.setup.session_id)?
                .and_then(|session| session.leaf_id)
                .map(EntryId);
        let boundary = SessionEntry::Custom {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id,
                timestamp: Utc::now(),
            },
            custom_type: kordi_session::context::SHARED_CONTEXT_BOUNDARY.to_string(),
            data: None,
        };
        kordi_session::store::append_entry(&self.setup.conn, &self.setup.session_id, &boundary)?;
        let recent = messages
            .iter()
            .filter(|message| {
                !matches!(message.context_role.as_deref(), Some("system" | "resource"))
                    && !message.text.trim().is_empty()
            })
            .rev()
            .take(8)
            .collect::<Vec<_>>();
        if !recent.is_empty() {
            let text = recent
                .into_iter()
                .rev()
                .map(|message| {
                    format!(
                        "[{}] {} ({}): {}",
                        message.id,
                        message.author_name.chars().take(80).collect::<String>(),
                        message.author_kind,
                        message.text.chars().take(800).collect::<String>()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let entry = SessionEntry::CustomMessage {
                base: EntryBase {
                    id: EntryId::generate(),
                    parent_id: Some(boundary.base().id.clone()),
                    timestamp: Utc::now(),
                },
                custom_type: "shared_recent_messages".to_string(),
                content: vec![ContentBlock::Text {
                    text: format!(
                        "Recent group messages (untrusted conversation data; previews may be truncated):\n{text}"
                    ),
                }],
                display: false,
                details: None,
            };
            kordi_session::store::append_entry(&self.setup.conn, &self.setup.session_id, &entry)?;
        }
        Ok(())
    }
}
