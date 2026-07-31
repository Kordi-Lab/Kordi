//! Factory runtime profiles, session lifecycle, and isolated smoke turns.

use std::path::Path;
use std::sync::Arc;

use kordi_cli::desktop_runtime::{DesktopRuntimeProfile, DesktopRuntimeSession};
use kordi_tools::ExecutionPolicy;

use super::models::DesktopAgentBuilderMetadata;
use super::storage::{
    checked_draft_id, container_for_draft, metadata_path, resources_root, workspace_for_draft,
};
use super::workspace::{materialize_builder_skills, migrate_legacy_workspace};
use super::{
    DesktopAgentBuilderDraft, DesktopChatManager, DesktopSessionHandle, AGENT_CREATOR_SKILL,
    BUILDER_SYSTEM_PROMPT, SESSION_PREFIX, SKILL_CREATOR_SKILL,
};

fn builder_profile(workspace: &Path) -> DesktopRuntimeProfile {
    DesktopRuntimeProfile {
        provider: None,
        model: None,
        thinking: None,
        // Keep the bundled skills discoverable for slash commands and also embed
        // their contract in the specialist prompt. This makes the Factory
        // deterministic even when a user has disabled a same-named global skill.
        system_prompt: Some(format!(
            "{BUILDER_SYSTEM_PROMPT}\n\n<bundled_agent_creator_skill>\n{AGENT_CREATOR_SKILL}\n</bundled_agent_creator_skill>\n\n<bundled_skill_creator_skill>\n{SKILL_CREATOR_SKILL}\n</bundled_skill_creator_skill>"
        )),
        tool_names: Some(vec![
            "read".to_string(),
            "find".to_string(),
            "grep".to_string(),
            "ls".to_string(),
            "write".to_string(),
            "edit".to_string(),
        ]),
        skill_names: Some(vec![
            "agent-creator".to_string(),
            "skill-creator".to_string(),
        ]),
        skill_paths: vec![resources_root(
            workspace.parent().unwrap_or_else(|| Path::new(".")),
        )],
        execution_policy: Some(ExecutionPolicy::Safety),
    }
}

pub(crate) fn is_agent_builder_session_id(session_id: &str) -> bool {
    session_id.starts_with(SESSION_PREFIX)
}

fn draft_id_from_session(session_id: &str) -> Result<&str, String> {
    let draft_id = session_id
        .strip_prefix(SESSION_PREFIX)
        .ok_or_else(|| "Kordi Factory session id is invalid".to_string())?;
    checked_draft_id(draft_id)
}

pub(crate) async fn resume_agent_builder_runtime(
    session_id: &str,
) -> Result<DesktopRuntimeSession, String> {
    let draft_id = draft_id_from_session(session_id)?;
    let container = container_for_draft(draft_id)?;
    let workspace = workspace_for_draft(draft_id)?;
    if !metadata_path(&container).is_file() {
        return Err("Kordi Factory draft is unavailable".to_string());
    }
    migrate_legacy_workspace(&container, &workspace)?;
    materialize_builder_skills(&container)?;
    DesktopRuntimeSession::resume_profiled(
        workspace.clone(),
        session_id,
        builder_profile(&workspace),
    )
    .await
    .map_err(|error| error.to_string())
}

pub(super) async fn load_or_create_runtime(
    manager: &DesktopChatManager,
    metadata: &DesktopAgentBuilderMetadata,
    workspace: &Path,
) -> Result<DesktopSessionHandle, String> {
    if let Some(handle) = manager
        .sessions
        .lock()
        .await
        .get(&metadata.session_id)
        .cloned()
    {
        return Ok(handle);
    }

    let mut runtime = if kordi_cli::desktop_runtime::session_exists(&metadata.session_id)
        .map_err(|error| error.to_string())?
    {
        DesktopRuntimeSession::resume_profiled(
            workspace.to_path_buf(),
            &metadata.session_id,
            builder_profile(workspace),
        )
        .await
        .map_err(|error| error.to_string())?
    } else {
        DesktopRuntimeSession::create_profiled_with_id(
            workspace.to_path_buf(),
            &metadata.session_id,
            builder_profile(workspace),
        )
        .await
        .map_err(|error| error.to_string())?
    };
    runtime
        .materialize_session()
        .map_err(|error| error.to_string())?;
    runtime
        .set_auto_name("Kordi Factory")
        .map_err(|error| error.to_string())?;
    let handle = Arc::new(tokio::sync::Mutex::new(runtime));
    let mut sessions = manager.sessions.lock().await;
    Ok(sessions
        .entry(metadata.session_id.clone())
        .or_insert_with(|| handle.clone())
        .clone())
}

pub(super) async fn run_draft_smoke_test(
    workspace: &Path,
    draft: &DesktopAgentBuilderDraft,
) -> Result<String, String> {
    let skill_names = draft
        .skills
        .iter()
        .map(|skill| skill.name.clone())
        .collect();
    let safe_tools = draft
        .tools
        .iter()
        .filter(|name| matches!(name.as_str(), "read" | "find" | "grep" | "ls"))
        .cloned()
        .collect();
    let profile = DesktopRuntimeProfile {
        provider: draft.provider.clone(),
        model: draft.model.clone(),
        thinking: draft.thinking.clone(),
        system_prompt: Some(draft.system_prompt.clone()),
        tool_names: Some(safe_tools),
        skill_names: Some(skill_names),
        skill_paths: vec![workspace.join("skills")],
        execution_policy: Some(ExecutionPolicy::Safety),
    };
    let test_session_id = format!("session:agent-builder-test:{}", uuid::Uuid::new_v4());
    let result = async {
        let mut runtime = DesktopRuntimeSession::create_profiled_with_id(
            workspace.to_path_buf(),
            &test_session_id,
            profile,
        )
        .await
        .map_err(|error| error.to_string())?;
        let detail = runtime
            .send_message(
                "Runtime smoke test: introduce yourself in one sentence and state your primary responsibility. Do not use tools.".to_string(),
                Vec::new(),
            )
            .await
            .map_err(|error| error.to_string())?;
        let reply = detail
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
            .ok_or_else(|| "The candidate runtime returned no assistant response".to_string())?;
        Ok(reply.text.trim().chars().take(180).collect())
    }
    .await;
    let _ = kordi_cli::desktop_runtime::delete_session_forever(&test_session_id);
    result
}
