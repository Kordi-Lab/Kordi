//! Runtime profiles of purpose-built desktop sessions, such as background
//! sessions, and how they shape a session's bootstrap.

use std::collections::HashSet;
use std::path::PathBuf;

use crate::session_bootstrap::{SessionBootstrapOptions, SessionRuntimeSetup};
use crate::tool_registry::ToolSelectionPreference;

/// A constrained runtime profile for purpose-built desktop sessions.
///
/// Unlike the normal desktop chat runtime, profiled sessions may use a fixed
/// system prompt, a small tool allowlist, and explicit skill roots. This keeps
/// specialized workflows persistent without inheriting unrelated project
/// tools or the display model configured on a cloud agent record.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct DesktopRuntimeProfile {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub system_prompt: Option<String>,
    pub tool_names: Option<Vec<String>>,
    pub skill_names: Option<Vec<String>>,
    pub skill_paths: Vec<PathBuf>,
    #[serde(skip)]
    pub execution_policy: Option<kordi_tools::ExecutionPolicy>,
    /// A subsession of an approved proactive run follows the run's prompt rules.
    #[serde(default)]
    pub proactive_run: bool,
    /// The request route the parent turn ran with: its model and the account
    /// that pays for it. `provider` above is the model namespace only (a
    /// ChatGPT sign-in and an OpenAI key share `openai`), so a background
    /// session that resumes later needs this route to run on the same account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_route: Option<DesktopRuntimeTurnRoute>,
}

/// A request route remembered for a background session. It names a model and
/// an account choice, never a credential.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeTurnRoute {
    pub model: Option<String>,
    pub auth_provider: Option<String>,
    pub auth_choice: Option<String>,
    pub thinking: Option<String>,
}

pub(super) fn profile_bootstrap_options(
    profile: &DesktopRuntimeProfile,
    session: Option<String>,
) -> SessionBootstrapOptions {
    SessionBootstrapOptions {
        provider: profile.provider.clone(),
        model: profile.model.clone(),
        thinking: profile.thinking.clone(),
        system_prompt: profile.system_prompt.clone(),
        tool_selection: match &profile.tool_names {
            Some(names) => ToolSelectionPreference::Only(names.clone()),
            None => ToolSelectionPreference::UseSettings,
        },
        skill_names: profile.skill_names.clone(),
        skill_paths: profile.skill_paths.clone(),
        isolate_extensions: true,
        proactive_run: profile.proactive_run,
        session,
        prompt_label: "desktop-profile".to_string(),
        ..SessionBootstrapOptions::default()
    }
}

pub(super) fn apply_runtime_profile(setup: &mut SessionRuntimeSetup, profile: &DesktopRuntimeProfile) {
    if let Some(execution_policy) = profile.execution_policy {
        setup.tool_ctx.execution_policy = execution_policy;
    }

    if let Some(tool_names) = &profile.tool_names {
        let enabled = tool_names
            .iter()
            .map(|name| name.trim().to_ascii_lowercase())
            .collect::<HashSet<_>>();
        if !enabled.contains("web_search") && !enabled.contains("web_fetch") {
            setup.tool_ctx.web_search = None;
        }
        if !enabled.contains("reach_out") {
            setup.tool_ctx.reach_out = None;
        }
        if !enabled.contains("search_sessions") && !enabled.contains("read_session") {
            setup.tool_ctx.session_observation = None;
        }
        if !enabled.contains("task_operator") {
            setup.tool_ctx.task_operator = None;
        }
        if !enabled.contains("schedule_task") {
            setup.tool_ctx.schedule_task = None;
        }
    }
}
