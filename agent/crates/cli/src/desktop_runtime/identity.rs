use anyhow::{Result, bail};
use kordi_core::types::{
    ContentBlock, EntryBase, EntryId, RUNTIME_IDENTITY_CUSTOM_TYPE, RuntimeIdentity, SessionEntry,
};
use rusqlite::OptionalExtension;

use super::{DesktopChatContextMessage, DesktopRuntimeSession, ensure_session_row_created};

impl DesktopRuntimeSession {
    /// Resolve authority from persisted application metadata, never participant text.
    pub(super) fn turn_execution_policy(&self) -> Result<kordi_tools::ExecutionPolicy> {
        if let Some(context) = self.runtime_identity_context()? {
            let identity: RuntimeIdentity = serde_json::from_str(&context.text)?;
            if !identity.owner_account_id.trim().is_empty()
                && identity.owner_account_id == identity.requester_account_id
            {
                return Ok(self.setup.tool_ctx.execution_policy);
            }
            return Ok(kordi_tools::ExecutionPolicy::Shared);
        }
        // A private Ask Agent chat may retrieve group context without becoming
        // a member-authored shared request. Shared admission requires identity.
        Ok(self.setup.tool_ctx.execution_policy)
    }

    pub(super) fn has_shared_observation_scope(&self) -> Result<bool> {
        Ok(self.setup.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')='group_observation_scope')",
            [&self.setup.session_id], |row| row.get(0),
        )?)
    }

    pub fn runtime_identity_context(&self) -> Result<Option<DesktopChatContextMessage>> {
        let raw: Option<String> = self.setup.conn.query_row(
            "SELECT json_extract(payload,'$.details') FROM entries WHERE session_id=?1 AND type='custom_message' AND json_extract(payload,'$.custom_type')=?2 ORDER BY seq DESC LIMIT 1",
            [&self.setup.session_id, RUNTIME_IDENTITY_CUSTOM_TYPE], |row| row.get(0),
        ).optional()?;
        Ok(raw.map(|text| DesktopChatContextMessage {
            id: RUNTIME_IDENTITY_CUSTOM_TYPE.into(),
            author_name: "Kordi runtime".into(),
            author_kind: "agent".into(),
            context_role: Some("runtimeIdentity".into()),
            text,
            created_at_ms: None,
        }))
    }

    pub(super) fn sync_runtime_identity(
        &mut self,
        messages: &[DesktopChatContextMessage],
    ) -> Result<()> {
        for message in messages
            .iter()
            .filter(|m| m.context_role.as_deref() == Some("runtimeIdentity"))
        {
            let identity: RuntimeIdentity = serde_json::from_str(&message.text)?;
            if [
                &identity.request_id,
                &identity.agent_id,
                &identity.owner_account_id,
                &identity.requester_account_id,
            ]
            .iter()
            .any(|id| id.trim().is_empty())
            {
                bail!("Runtime identity requires an Agent, owner, requester and request ID");
            }
            if let Some(previous) = self.runtime_identity_context()? {
                let previous: RuntimeIdentity = serde_json::from_str(&previous.text)?;
                if !previous.same_agent(&identity) {
                    bail!("Runtime Agent ownership cannot change within a session");
                }
            }
            let existing: Option<String> = self.setup.conn.query_row(
                "SELECT json_extract(payload,'$.details') FROM entries WHERE session_id=?1 AND type='custom_message' AND json_extract(payload,'$.custom_type')=?2 AND json_extract(payload,'$.details.requestId')=?3 LIMIT 1",
                [&self.setup.session_id, RUNTIME_IDENTITY_CUSTOM_TYPE, &identity.request_id], |row| row.get(0),
            ).optional()?;
            if let Some(existing) = existing {
                if serde_json::from_str::<RuntimeIdentity>(&existing)? != identity {
                    bail!("Admitted request identity is immutable");
                }
                continue;
            }
            ensure_session_row_created(&mut self.setup)?;
            let parent_id =
                kordi_session::store::get_session(&self.setup.conn, &self.setup.session_id)?
                    .and_then(|s| s.leaf_id)
                    .map(EntryId);
            let entry = SessionEntry::CustomMessage {
                base: EntryBase {
                    id: EntryId::generate(),
                    parent_id,
                    timestamp: chrono::Utc::now(),
                },
                custom_type: RUNTIME_IDENTITY_CUSTOM_TYPE.into(),
                display: false,
                content: vec![ContentBlock::Text {
                    text: identity.prompt(),
                }],
                details: Some(serde_json::to_value(identity)?),
            };
            kordi_session::store::append_entry(&self.setup.conn, &self.setup.session_id, &entry)?;
        }
        Ok(())
    }

    /// Freeze the full prepared header, not just its first few static lines.
    /// Existing sessions adopt it without rewriting any historical messages.
    pub(super) fn freeze_identity_prompt(&mut self) -> Result<()> {
        if self.runtime_identity_context()?.is_none() {
            return Ok(());
        }
        let saved: Option<String> = self.setup.conn.query_row(
            "SELECT json_extract(payload,'$.data.systemPrompt') FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')='runtime_identity_prompt' ORDER BY seq LIMIT 1",
            [&self.setup.session_id], |row| row.get(0),
        ).optional()?;
        if let Some(prompt) = saved {
            self.setup.system_prompt = prompt;
            return Ok(());
        }
        let parent_id =
            kordi_session::store::get_session(&self.setup.conn, &self.setup.session_id)?
                .and_then(|s| s.leaf_id)
                .map(EntryId);
        kordi_session::store::append_entry(
            &self.setup.conn,
            &self.setup.session_id,
            &SessionEntry::Custom {
                base: EntryBase {
                    id: EntryId::generate(),
                    parent_id,
                    timestamp: chrono::Utc::now(),
                },
                custom_type: "runtime_identity_prompt".into(),
                data: Some(serde_json::json!({"systemPrompt":self.setup.system_prompt})),
            },
        )?;
        Ok(())
    }
}
