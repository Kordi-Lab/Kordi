//! Factory runtime profiles, session lifecycle, and isolated smoke turns.

use std::path::Path;
use std::sync::Arc;

use super::super::hosted_provider_auth::{resolve_for_lease, route_uses_hosted_auth};
use super::super::message_route::apply_desktop_chat_message_route;
use super::super::DesktopChatMessageRoute;
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
        proactive_run: false,
        turn_route: None,
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
    run_id: Option<&str>,
    claim_id: Option<&str>,
) -> Result<String, String> {
    let route = draft_route(draft);
    let hosted = route_uses_hosted_auth(Some(&route));
    let hosted_auth = if hosted {
        let run_id = run_id
            .filter(|id| id.starts_with("factory_"))
            .ok_or("This hosted Factory test needs a new execution lease. Try the test again.")?;
        let claim_id = claim_id
            .filter(|id| !id.trim().is_empty())
            .ok_or("This hosted Factory test needs a new execution lease. Try the test again.")?;
        let session = crate::cloud_session::cloud_session_load()?
            .filter(|session| !session.token.is_empty())
            .ok_or("Sign in to Kordi to test this hosted provider account.")?;
        let lease = serde_json::from_value(serde_json::json!({
            "sessionId": format!("factory:{}", session.account_id),
            "runId": run_id, "claimId": claim_id, "ownerAccountId": session.account_id,
        }))
        .map_err(|error| error.to_string())?;
        let auth = resolve_for_lease(&route, &lease).await.map_err(|_| {
            "This provider account is unavailable for the Factory test. Open Settings > Providers, reconnect the selected account, then retry.".to_string()
        })?;
        Some((auth, lease))
    } else {
        None
    };
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
        provider: if hosted { None } else { draft.provider.clone() },
        model: if hosted { None } else { draft.model.clone() },
        thinking: draft.thinking.clone(),
        system_prompt: Some(draft.system_prompt.clone()),
        tool_names: Some(safe_tools),
        skill_names: Some(skill_names),
        skill_paths: vec![workspace.join("skills")],
        execution_policy: Some(ExecutionPolicy::Safety),
        proactive_run: false,
        turn_route: None,
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
        apply_desktop_chat_message_route(&mut runtime, Some(&route))?;
        let mut completion = None;
        if let Some((auth, lease)) = hosted_auth {
            completion = Some(lease);
            runtime.set_ephemeral_provider_auth_with_options(
                &auth.provider, auth.auth, auth.base_url, auth.api.as_deref(),
            ).map_err(|error| error.to_string())?;
        }
        let detail = tokio::time::timeout(std::time::Duration::from_secs(120), runtime
            .send_message(
                "Runtime smoke test: introduce yourself in one sentence and state your primary responsibility. Do not use tools.".to_string(),
                Vec::new(),
            ))
            .await
            .map_err(|_| "The Factory test timed out. Check the provider connection and retry.".to_string())?
            .map_err(|error| {
                let message = error.to_string();
                if message.contains("Selected provider has no resolved credential") {
                    "This provider has no connected account on this Mac. Open Settings > Providers, connect an account, then save the draft's model routing and test again.".to_string()
                } else { message }
            })?;
        let reply = detail
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
            .ok_or_else(|| "The candidate runtime returned no assistant response".to_string())?;
        let summary = reply.text.trim().chars().take(180).collect();
        if let Some(lease) = completion {
            super::hosted_test::complete(&lease).await?;
        }
        Ok(summary)
    }
    .await;
    let _ = kordi_cli::desktop_runtime::delete_session_forever(&test_session_id);
    result
}

fn draft_route(draft: &DesktopAgentBuilderDraft) -> DesktopChatMessageRoute {
    DesktopChatMessageRoute {
        model: draft.model.clone(),
        thinking: draft.thinking.clone(),
        auth_provider: draft.provider.clone(),
        auth_choice: draft.auth_choice.clone(),
    }
}
