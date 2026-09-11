//! Owner workspace binding is persisted independently from the agent's identity.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use kordi_core::types::{EntryBase, EntryId, SessionEntry};
use kordi_tools::ExecutionPolicy;
use rusqlite::OptionalExtension;

use super::{
    DesktopChatSessionDetail, DesktopRuntimeSession, build_detail_from_setup,
    ensure_session_row_created, load_project_info,
};

#[path = "workspace_references.rs"]
mod references;
pub(super) use references::referenced_workspace;

const WORKSPACE_ENTRY: &str = "desktop_execution_workspace";

impl DesktopRuntimeSession {
    pub fn detail(&self) -> Result<DesktopChatSessionDetail> {
        let mut detail = build_detail_from_setup(&self.setup)?;
        if let Some(workspace) = self.saved_execution_workspace()? {
            detail.cwd = workspace.display().to_string();
            detail.project = load_project_info(&workspace);
        }
        Ok(detail)
    }

    pub(super) fn saved_execution_workspace(&self) -> Result<Option<PathBuf>> {
        if self.turn_execution_policy()? == ExecutionPolicy::Shared || !self.owner_persona_enabled {
            return Ok(None);
        }
        let saved: Option<String> = self.setup.conn.query_row(
            "SELECT json_extract(payload,'$.data.path') FROM entries WHERE session_id=?1 AND type='custom' AND json_extract(payload,'$.custom_type')=?2 ORDER BY seq DESC LIMIT 1",
            [&self.setup.session_id, WORKSPACE_ENTRY], |row| row.get(0),
        ).optional()?;
        Ok(saved.map(PathBuf::from))
    }

    pub(super) fn execution_workspace(
        &mut self,
        prompt: &str,
        policy: ExecutionPolicy,
    ) -> Result<PathBuf> {
        // Shared participants cannot probe paths, select an owner workspace, or
        // learn whether an owner directory exists.
        if policy == ExecutionPolicy::Shared || !self.owner_persona_enabled {
            return Ok(self.setup.tool_ctx.cwd.clone());
        }
        let previous = self
            .saved_execution_workspace()?
            .unwrap_or_else(|| self.setup.tool_ctx.cwd.clone());
        let selected = referenced_workspace(prompt, &previous);
        let workspace = selected.as_ref().unwrap_or(&previous);
        if !workspace.is_dir() {
            bail!(
                "The selected local workspace is unavailable. Select an existing folder on this Mac."
            );
        }
        let workspace =
            std::fs::canonicalize(workspace).context("Could not resolve local workspace")?;
        if policy == ExecutionPolicy::Safety {
            let allowed = std::fs::canonicalize(&self.setup.tool_ctx.cwd)?;
            if !workspace.starts_with(allowed) {
                bail!("The selected folder is outside this session's safety-mode workspace.");
            }
        }
        if selected.is_some() && workspace != previous {
            ensure_session_row_created(&mut self.setup)?;
            let parent_id =
                kordi_session::store::get_session(&self.setup.conn, &self.setup.session_id)?
                    .and_then(|row| row.leaf_id)
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
                    custom_type: WORKSPACE_ENTRY.into(),
                    data: Some(serde_json::json!({"path": workspace})),
                },
            )?;
        }
        Ok(workspace)
    }
}

pub(super) fn environment_prompt(
    base: &str,
    workspace: &Path,
    policy: ExecutionPolicy,
    has_history: bool,
) -> String {
    if policy == ExecutionPolicy::Shared {
        return format!(
            "{base}\n\nRuntime authority: non-owner shared request. Local files, shell commands and Mac applications are unavailable. Do not claim to have used them."
        );
    }
    let facts = serde_json::json!({
        "executionLocation": "local device",
        "platform": std::env::consts::OS,
        "workingDirectory": workspace,
        "homeDirectory": kordi_core::local_paths::home_directory(),
        "executionPolicy": policy.as_str(),
        "chatHistoryAvailable": has_history,
    });
    let permissions = if policy == ExecutionPolicy::Yolo {
        "The owner has enabled YOLO. Carry out the owner's requested file, command and app operations without asking for Kordi permission again. Operating-system permissions and missing credentials remain real boundaries; report the actual tool error."
    } else {
        "Safety mode is enabled. Respect the configured workspace and execution restrictions."
    };
    let instructions = crate::agents_md::load_agents_md(workspace)
        .map(|text| format!("\n\nInstructions applicable to the selected workspace (retain their directory scope):\n{text}"))
        .unwrap_or_default();
    format!(
        "{base}\n\n<local_execution_context>\n{facts}\n{permissions}\nThe model provider's location does not change tool execution: file and shell tools run on this device. Resolve relative paths against workingDirectory and ~ against homeDirectory. A folder reference selects that folder when unambiguous. Use history tools before asking the owner to repeat available chat context. For action requests, continue through tool execution and verification, or identify a concrete blocker. Never report an issue created, a file read, or an app inspected without supporting results. Use local_app for Mac application discovery and automation when available; browser_fetch uses a fresh headless profile and cannot access the owner's signed-in browser tabs.\n</local_execution_context>{instructions}"
    )
}
