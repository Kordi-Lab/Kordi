use anyhow::{Result, anyhow, bail};
use chrono::{DateTime, Utc};
use kordi_core::agent_session::ThinkingLevel;
use kordi_core::settings::Settings;
use kordi_core::types::{ContentBlock, EntryBase, EntryId, SessionEntry};
use kordi_provider::registry::Model;
use std::collections::HashSet;
use std::path::PathBuf;

use crate::login;
use crate::session_bootstrap::{
    SessionAuthChoiceOverride, SessionBootstrapOptions, SessionRuntimeSetup,
    prepare_session_runtime_for_cwd,
};
use crate::tool_registry::ToolSelectionPreference;
mod attachments;
mod background_sessions;
mod model_options;
mod models;
mod session_catalog;
mod session_detail;
mod transcript;
mod turn_execution;

#[cfg(test)]
use attachments::attachment_metadata_from_path;
use attachments::attachment_summary_from_metadata;

pub use background_sessions::{
    background_session_for_parent_message, create_background_session, session_exists,
};
pub use model_options::{
    authenticated_model_options, clear_desktop_model_options_cache,
    desktop_thinking_levels_for_model, desktop_thinking_levels_for_model_id,
};
pub use models::{
    DesktopChatAgentProfile, DesktopChatAttachment, DesktopChatContextMessage,
    DesktopChatContextWindowStatus, DesktopChatMessage, DesktopChatModelOption,
    DesktopChatProjectGroup, DesktopChatProjectInfo, DesktopChatProjectSource,
    DesktopChatSessionDetail, DesktopChatSessionSummary, DesktopChatSlashCommand,
    DesktopChatStoredTool, DesktopForkSessionOutcome, DesktopSessionArtifact,
    DesktopVisibleTaskRecord,
};

use model_options::{
    effective_thinking_for_model_with_auth, normalize_setup_thinking,
    resolve_auth_choice_override_for_model, resolve_model_candidate,
};
use session_catalog::{
    fallback_session_display_title, load_project_info, open_sessions_db, project_group_id,
    repair_session_title_from_history, runtime_cwd_for_session, session_activity_label,
    session_title_from_messages, session_title_from_seed, truncate_chars,
};
use session_detail::{
    build_agent_profile_from_setup, build_detail_from_setup, build_summary_from_setup,
};
pub(crate) use session_detail::{format_message_timestamp, format_utc_timestamp, thinking_label};
use transcript::load_session_messages;

pub use session_catalog::{list_project_groups, list_session_summaries, register_project};
pub use turn_execution::{DesktopRuntimeTurn, DesktopRuntimeTurnResult};

const ATTACHMENT_CONTEXT_CUSTOM_TYPE: &str = "desktop_attachment_context";
const CLOUD_AGENT_CONTEXT_CUSTOM_TYPE: &str = "cloud_agent_context_message";
const DESKTOP_SESSION_CONTEXT_START: &str = "\n\n<desktop_session_context>";
const DESKTOP_SESSION_CONTEXT_END: &str = "</desktop_session_context>";
const LEGACY_DESKTOP_BRIDGE_CONTEXT_START: &str = "\n\n<desktop_bridge_outreach_context>";
const LEGACY_DESKTOP_BRIDGE_CONTEXT_END: &str = "</desktop_bridge_outreach_context>";

fn visible_task_record_status_for_store(status: &str) -> String {
    match status.trim().to_ascii_lowercase().as_str() {
        "closed" | "complete" | "completed" => "closed".to_string(),
        "failed" => "failed".to_string(),
        _ => "open".to_string(),
    }
}
pub struct DesktopRuntimeSession {
    setup: SessionRuntimeSetup,
}

/// A constrained runtime profile for purpose-built desktop sessions.
///
/// Unlike the normal desktop chat runtime, profiled sessions may use a fixed
/// system prompt, a small tool allowlist, and explicit skill roots. This keeps
/// specialized workflows persistent without inheriting unrelated project
/// tools or the display model configured on a cloud agent record.
#[derive(Clone, Debug, Default)]
pub struct DesktopRuntimeProfile {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub system_prompt: Option<String>,
    pub tool_names: Option<Vec<String>>,
    pub skill_names: Option<Vec<String>>,
    pub skill_paths: Vec<PathBuf>,
    pub execution_policy: Option<kordi_tools::ExecutionPolicy>,
}

impl DesktopRuntimeSession {
    pub async fn create_new(cwd: std::path::PathBuf) -> Result<Self> {
        let (_runtime_host, _ui, mut setup) =
            prepare_session_runtime_for_cwd(cwd, SessionBootstrapOptions::default()).await?;
        normalize_setup_thinking(&mut setup);
        Ok(Self { setup })
    }

    pub async fn create_with_id(cwd: std::path::PathBuf, session_id: &str) -> Result<Self> {
        let (_runtime_host, _ui, mut setup) =
            prepare_session_runtime_for_cwd(cwd, SessionBootstrapOptions::default()).await?;
        retarget_runtime_setup_session(&mut setup, session_id)?;
        normalize_setup_thinking(&mut setup);
        Ok(Self { setup })
    }

    pub async fn resume(cwd: std::path::PathBuf, session_id: &str) -> Result<Self> {
        let runtime_cwd = runtime_cwd_for_session(cwd, session_id)?;
        let entry = SessionBootstrapOptions {
            session: Some(session_id.to_string()),
            ..SessionBootstrapOptions::default()
        };
        let (_runtime_host, _ui, mut setup) =
            prepare_session_runtime_for_cwd(runtime_cwd, entry).await?;
        normalize_setup_thinking(&mut setup);
        Ok(Self { setup })
    }

    pub async fn create_profiled_with_id(
        cwd: PathBuf,
        session_id: &str,
        profile: DesktopRuntimeProfile,
    ) -> Result<Self> {
        let options = profile_bootstrap_options(&profile, None);
        let (_runtime_host, _ui, mut setup) = prepare_session_runtime_for_cwd(cwd, options).await?;
        retarget_runtime_setup_session(&mut setup, session_id)?;
        apply_runtime_profile(&mut setup, &profile);
        normalize_setup_thinking(&mut setup);
        Ok(Self { setup })
    }

    pub async fn resume_profiled(
        cwd: PathBuf,
        session_id: &str,
        profile: DesktopRuntimeProfile,
    ) -> Result<Self> {
        let options = profile_bootstrap_options(&profile, Some(session_id.to_string()));
        let (_runtime_host, _ui, mut setup) = prepare_session_runtime_for_cwd(cwd, options).await?;
        apply_runtime_profile(&mut setup, &profile);
        normalize_setup_thinking(&mut setup);
        Ok(Self { setup })
    }

    pub fn session_id(&self) -> &str {
        &self.setup.session_id
    }

    pub fn slash_commands(&self) -> Vec<DesktopChatSlashCommand> {
        self.setup
            .slash_command_items
            .iter()
            .map(|item| DesktopChatSlashCommand {
                label: item.label.clone(),
                detail: item.detail.clone(),
                value: item.value.clone(),
            })
            .collect()
    }

    pub async fn reload_resources(&mut self) -> Result<()> {
        let cwd = self.setup.tool_ctx.cwd.clone();
        let session_id = self.setup.session_id.clone();
        let entry = SessionBootstrapOptions {
            session: Some(session_id),
            ..SessionBootstrapOptions::default()
        };
        let (_runtime_host, _ui, setup) = prepare_session_runtime_for_cwd(cwd, entry).await?;
        self.setup = setup;
        Ok(())
    }

    pub async fn run_skill_command(&mut self, text: &str) -> Result<Option<String>> {
        let Some(action) = crate::slash::parse_skill_command(text) else {
            return Ok(None);
        };

        match action {
            crate::slash::SkillAdminAction::Help => Ok(Some(crate::slash::skill_help_text())),
            crate::slash::SkillAdminAction::List => {
                let loaded: Vec<String> = self
                    .setup
                    .slash_command_items
                    .iter()
                    .filter_map(|item| item.value.strip_prefix("/skill:").map(ToString::to_string))
                    .collect();
                let settings = Settings::load_merged(&self.setup.tool_ctx.cwd);
                let disabled: Vec<String> = settings
                    .disabled_skills
                    .iter()
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
                    .collect();

                let mut lines = Vec::new();
                lines.push("Loaded skills:".to_string());
                if loaded.is_empty() {
                    lines.push("  (none)".to_string());
                } else {
                    for name in &loaded {
                        lines.push(format!("  • {name}"));
                    }
                }
                lines.push(String::new());
                lines.push("Disabled skills (source kept on disk):".to_string());
                if disabled.is_empty() {
                    lines.push("  (none)".to_string());
                } else {
                    for name in &disabled {
                        lines.push(format!("  • {name}"));
                    }
                }
                Ok(Some(lines.join("\n")))
            }
            crate::slash::SkillAdminAction::Disable(name) => {
                let disable = true;
                let normalized = name.trim().to_string();
                if normalized.is_empty() {
                    return Ok(Some(
                        "Missing skill name. See /skill for usage.".to_string(),
                    ));
                }

                let mut settings = Settings::load_global();
                let already = settings
                    .disabled_skills
                    .iter()
                    .any(|entry| entry.trim().eq_ignore_ascii_case(&normalized));

                if disable {
                    if already {
                        return Ok(Some(format!("Skill '{normalized}' is already disabled.")));
                    }
                    settings.disabled_skills.push(normalized.clone());
                } else if !already {
                    return Ok(Some(format!("Skill '{normalized}' is not disabled.")));
                } else {
                    let normalized_lower = normalized.to_ascii_lowercase();
                    settings
                        .disabled_skills
                        .retain(|entry| !entry.trim().eq_ignore_ascii_case(&normalized_lower));
                }

                settings.save_global()?;

                self.reload_resources().await?;

                Ok(Some(if disable {
                    format!("Disabled skill: {normalized}")
                } else {
                    format!("Enabled skill: {normalized}")
                }))
            }
            crate::slash::SkillAdminAction::Enable(name) => {
                let disable = false;
                let normalized = name.trim().to_string();
                if normalized.is_empty() {
                    return Ok(Some(
                        "Missing skill name. See /skill for usage.".to_string(),
                    ));
                }

                let mut settings = Settings::load_global();
                let already = settings
                    .disabled_skills
                    .iter()
                    .any(|entry| entry.trim().eq_ignore_ascii_case(&normalized));

                if disable {
                    if already {
                        return Ok(Some(format!("Skill '{normalized}' is already disabled.")));
                    }
                    settings.disabled_skills.push(normalized.clone());
                } else if !already {
                    return Ok(Some(format!("Skill '{normalized}' is not disabled.")));
                } else {
                    let normalized_lower = normalized.to_ascii_lowercase();
                    settings
                        .disabled_skills
                        .retain(|entry| !entry.trim().eq_ignore_ascii_case(&normalized_lower));
                }

                settings.save_global()?;

                self.reload_resources().await?;

                Ok(Some(if disable {
                    format!("Disabled skill: {normalized}")
                } else {
                    format!("Enabled skill: {normalized}")
                }))
            }
        }
    }

    pub fn summary(&self) -> Result<DesktopChatSessionSummary> {
        build_summary_from_setup(&self.setup)
    }

    pub fn detail(&self) -> Result<DesktopChatSessionDetail> {
        build_detail_from_setup(&self.setup)
    }

    pub fn agent_profile(&self) -> DesktopChatAgentProfile {
        build_agent_profile_from_setup(&self.setup)
    }

    fn apply_model(&mut self, requested_model: &str) -> Result<ThinkingLevel> {
        let settings = Settings::load_merged(&self.setup.tool_ctx.cwd);
        let model =
            resolve_model_candidate(&settings, requested_model, Some(&self.setup.model.provider))?;
        self.setup.model = model;
        let requested_thinking =
            ThinkingLevel::parse(&self.setup.thinking_level).unwrap_or(ThinkingLevel::Off);
        refresh_provider_runtime_fields(&mut self.setup);
        let effective_thinking = effective_thinking_for_model_with_auth(
            requested_thinking,
            &self.setup.model,
            self.setup.auth.as_ref().map(|auth| auth.method),
        );
        self.setup.thinking_level = effective_thinking.as_str().to_string();
        Ok(effective_thinking)
    }

    pub fn set_model(&mut self, requested_model: &str) -> Result<()> {
        let previous_provider = self.setup.model.provider.clone();
        let previous_model = self.setup.model.id.clone();
        let previous_thinking = self.setup.thinking_level.clone();
        let effective_thinking = self.apply_model(requested_model)?;
        let changed =
            previous_provider != self.setup.model.provider || previous_model != self.setup.model.id;
        let thinking_changed = previous_thinking != self.setup.thinking_level;
        // Only record a model/thinking-level change as a transcript
        // entry once the session actually has visible content. Forks
        // resolve their default model at first activation; recording
        // that as a "Switched model to ..." chip on every fork creates
        // noise when nothing the user did caused the switch.
        let session_has_visible_history = self.setup.session_created
            && session_has_visible_message_entries(&self.setup.conn, &self.setup.session_id);
        if changed && session_has_visible_history {
            append_model_change_entry(&self.setup.conn, &self.setup.session_id, &self.setup.model)?;
        }
        if thinking_changed && session_has_visible_history {
            append_thinking_level_change_entry(
                &self.setup.conn,
                &self.setup.session_id,
                effective_thinking,
            )?;
        }
        Ok(())
    }

    pub fn set_explicit_config(
        &mut self,
        requested_model: Option<&str>,
        requested_thinking: Option<&str>,
    ) -> Result<()> {
        let previous_provider = self.setup.model.provider.clone();
        let previous_model = self.setup.model.id.clone();
        let previous_thinking = self.setup.thinking_level.clone();

        if let Some(model) = requested_model {
            self.apply_model(model)?;
        }
        if let Some(thinking) = requested_thinking {
            self.apply_thinking(thinking)?;
        }

        let model_changed =
            previous_provider != self.setup.model.provider || previous_model != self.setup.model.id;
        let thinking_changed = previous_thinking != self.setup.thinking_level;
        ensure_session_row_created(&mut self.setup)?;
        if model_changed {
            append_model_change_entry(&self.setup.conn, &self.setup.session_id, &self.setup.model)?;
        }
        if thinking_changed {
            let thinking = ThinkingLevel::parse(&self.setup.thinking_level)
                .ok_or_else(|| anyhow!("Unknown thinking level: {}", self.setup.thinking_level))?;
            append_thinking_level_change_entry(&self.setup.conn, &self.setup.session_id, thinking)?;
        }
        Ok(())
    }

    pub fn set_auth_choice(&mut self, provider: &str, choice: &str) -> Result<()> {
        let provider = provider.trim();
        let choice = choice.trim();
        if provider.is_empty() || choice.is_empty() {
            self.setup.auth_choice_override = None;
            refresh_provider_runtime_fields(&mut self.setup);
            normalize_setup_thinking(&mut self.setup);
            return Ok(());
        }

        let model_provider =
            login::normalize_provider_for_model_selection(&self.setup.model.provider);
        let auth_provider = login::normalize_provider_for_model_selection(provider);
        if model_provider != auth_provider {
            bail!(
                "Auth choice provider {provider} does not match selected model provider {}",
                self.setup.model.provider
            );
        }
        if login::resolve_provider_runtime_auth_choice(provider, choice).is_none() {
            bail!("Unknown auth choice for {provider}: {choice}");
        }

        self.setup.auth_choice_override = Some(SessionAuthChoiceOverride {
            provider: provider.to_string(),
            choice: choice.to_string(),
        });
        refresh_provider_runtime_fields(&mut self.setup);
        normalize_setup_thinking(&mut self.setup);
        Ok(())
    }

    fn apply_thinking(&mut self, requested_thinking: &str) -> Result<ThinkingLevel> {
        let requested = ThinkingLevel::parse(requested_thinking)
            .ok_or_else(|| anyhow!("Unknown thinking level: {requested_thinking}"))?;
        let thinking = effective_thinking_for_model_with_auth(
            requested,
            &self.setup.model,
            self.setup.auth.as_ref().map(|auth| auth.method),
        );
        self.setup.thinking_level = thinking.as_str().to_string();
        Ok(thinking)
    }

    pub fn set_thinking(&mut self, requested_thinking: &str) -> Result<()> {
        let previous_thinking = self.setup.thinking_level.clone();
        let thinking = self.apply_thinking(requested_thinking)?;
        let changed = previous_thinking != self.setup.thinking_level;
        if changed && self.setup.session_created {
            append_thinking_level_change_entry(&self.setup.conn, &self.setup.session_id, thinking)?;
        }
        Ok(())
    }

    pub fn set_reach_out_runtime(&mut self, runtime: Option<kordi_tools::ReachOutRuntime>) {
        self.setup.tool_ctx.reach_out = runtime;
    }

    pub fn set_scheduled_tasks_cloud_runtime(&mut self, api_base: String, token: String) {
        self.set_scheduled_tasks_cloud_runtime_for_session(
            api_base,
            token,
            self.setup.session_id.clone(),
        );
    }

    pub fn set_scheduled_tasks_cloud_runtime_for_session(
        &mut self,
        api_base: String,
        token: String,
        session_id: String,
    ) {
        self.setup.tool_ctx.schedule_task = Some(
            crate::scheduled_tasks_runtime::build_scheduled_tasks_runtime_for_session(
                api_base, token, session_id,
            ),
        );
    }

    pub fn set_session_observation_runtime(
        &mut self,
        runtime: Option<kordi_tools::SessionObservationRuntime>,
    ) {
        self.setup.tool_ctx.session_observation = runtime;
    }

    pub fn sync_context_messages(
        &mut self,
        messages: &[DesktopChatContextMessage],
    ) -> Result<usize> {
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
        for message in messages {
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

    pub fn sync_visible_task_records(
        &mut self,
        records: &[DesktopVisibleTaskRecord],
    ) -> Result<usize> {
        if records.is_empty() {
            return Ok(0);
        }
        ensure_session_row_created(&mut self.setup)?;
        let mut count = 0;
        for record in records {
            let task_id = record.task_id.trim();
            let title = record.title.trim();
            if task_id.is_empty() || title.is_empty() {
                continue;
            }
            kordi_session::tasks::upsert_task(
                &self.setup.conn,
                kordi_session::tasks::NewTask {
                    session_id: self.setup.session_id.clone(),
                    task_id: task_id.to_string(),
                    parent_task_id: record.parent_task_id.clone(),
                    title: title.to_string(),
                    summary: record.summary.clone(),
                    status: Some(visible_task_record_status_for_store(&record.status)),
                    involved_participants: record.involved_participants.clone(),
                },
            )?;
            count += 1;
        }
        Ok(count)
    }

    pub fn set_session_prompt_context(&mut self, context: Option<String>) {
        let base_prompt = strip_session_prompt_context(&self.setup.system_prompt);
        let Some(context) = context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            self.setup.system_prompt = base_prompt;
            return;
        };
        self.setup.system_prompt = format!(
            "{base_prompt}{DESKTOP_SESSION_CONTEXT_START}\n{context}\n{DESKTOP_SESSION_CONTEXT_END}"
        );
    }

    pub fn set_name(&mut self, requested_name: &str) -> Result<()> {
        let name = requested_name.trim();
        if name.is_empty() {
            bail!("Session name cannot be empty");
        }
        ensure_session_row_created(&mut self.setup)?;
        kordi_session::store::set_session_name(
            &self.setup.conn,
            &self.setup.session_id,
            Some(name),
        )?;
        Ok(())
    }

    pub fn set_auto_name(&mut self, requested_name: &str) -> Result<()> {
        let name = requested_name.trim();
        if name.is_empty() {
            return Ok(());
        }
        ensure_session_row_created(&mut self.setup)?;
        kordi_session::store::set_auto_session_name(
            &self.setup.conn,
            &self.setup.session_id,
            name,
            None,
        )?;
        Ok(())
    }

    pub fn materialize_session(&mut self) -> Result<()> {
        ensure_session_row_created(&mut self.setup)
    }
}

fn profile_bootstrap_options(
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
        session,
        prompt_label: "desktop-profile".to_string(),
        ..SessionBootstrapOptions::default()
    }
}

fn apply_runtime_profile(setup: &mut SessionRuntimeSetup, profile: &DesktopRuntimeProfile) {
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

fn strip_tagged_prompt_context(prompt: &str, start_tag: &str, end_tag: &str) -> String {
    let Some(start) = prompt.find(start_tag) else {
        return prompt.to_string();
    };
    let Some(end_relative) = prompt[start..].find(end_tag) else {
        return prompt.to_string();
    };
    let end = start + end_relative + end_tag.len();
    format!("{}{}", &prompt[..start], &prompt[end..])
        .trim_end()
        .to_string()
}

fn strip_session_prompt_context(prompt: &str) -> String {
    let without_current = strip_tagged_prompt_context(
        prompt,
        DESKTOP_SESSION_CONTEXT_START,
        DESKTOP_SESSION_CONTEXT_END,
    );
    strip_tagged_prompt_context(
        &without_current,
        LEGACY_DESKTOP_BRIDGE_CONTEXT_START,
        LEGACY_DESKTOP_BRIDGE_CONTEXT_END,
    )
}

pub fn fork_session_from_message(
    source_session_id: &str,
    source_entry_id: &str,
) -> Result<DesktopForkSessionOutcome> {
    let conn = open_sessions_db()?;
    let Some(source_row) = kordi_session::store::get_session(&conn, source_session_id)? else {
        bail!("Session not found: {source_session_id}");
    };
    if source_row.session_scope != "chat" && source_row.session_scope != "project" {
        bail!("Only local chat sessions can be forked");
    }
    let result = kordi_session::store::fork_session_from_entry(
        &conn,
        source_session_id,
        source_entry_id,
        &source_row.cwd,
    )?;
    Ok(DesktopForkSessionOutcome {
        session_id: result.session_id,
        source_session_id: result.source_session_id,
        source_entry_id: result.source_entry_id,
        selected_text: result.selected_text,
        branch_leaf_id: result.branch_leaf_id,
        cwd: source_row.cwd,
    })
}

pub fn hide_session(session_id: &str) -> Result<()> {
    let conn = open_sessions_db()?;
    let Some(row) = kordi_session::store::get_session(&conn, session_id)? else {
        bail!("Session not found: {session_id}");
    };
    kordi_session::store::update_session_scope(
        &conn,
        session_id,
        "hidden",
        &row.cwd,
        row.project_root.as_deref(),
    )
}

pub fn move_session_to_project(session_id: &str, project_root: &std::path::Path) -> Result<()> {
    let conn = open_sessions_db()?;
    let Some(_row) = kordi_session::store::get_session(&conn, session_id)? else {
        bail!("Session not found: {session_id}");
    };
    let project_root_str = project_root.display().to_string();
    let group_id = project_group_id(project_root);
    kordi_session::store::upsert_project(&conn, &group_id, &project_root_str, None)?;
    kordi_session::store::update_session_scope(
        &conn,
        session_id,
        "project",
        &project_root_str,
        Some(&project_root_str),
    )
}

pub fn delete_session_forever(session_id: &str) -> Result<()> {
    let conn = open_sessions_db()?;
    kordi_session::store::delete_session(&conn, session_id)
}

fn retarget_runtime_setup_session(setup: &mut SessionRuntimeSetup, session_id: &str) -> Result<()> {
    setup.session_id = session_id.to_string();
    setup.session_created = false;
    let sibling_conn = setup
        .sibling_conn
        .clone()
        .ok_or_else(|| anyhow!("Session DB connection is unavailable"))?;
    setup.tool_ctx.task_operator = Some(crate::task_operator::build_task_operator_runtime(
        setup.tool_ctx.cwd.clone(),
        setup.session_id.clone(),
        sibling_conn,
    ));
    Ok(())
}

fn refresh_provider_runtime_fields(setup: &mut SessionRuntimeSetup) {
    let settings = Settings::load_merged(&setup.tool_ctx.cwd);
    let auth_override = setup
        .auth_choice_override
        .as_ref()
        .and_then(|choice| resolve_auth_choice_override_for_model(&setup.model.provider, choice));
    let runtime = crate::runtime_model::build_runtime_config_with_settings(
        &setup.model,
        &settings,
        auth_override,
    );

    setup.provider = runtime.provider.clone();
    setup.auth = runtime.auth;
    setup.api_key = runtime.api_key.clone();
    setup.base_url = runtime.base_url.clone();
    setup.headers = runtime.headers.clone();
    setup.tool_ctx.web_search = Some(kordi_tools::WebSearchRuntime {
        provider: setup.provider.clone(),
        model: setup.model.clone(),
        api_key: setup.api_key.clone(),
        base_url: setup.base_url.clone(),
        headers: runtime.headers,
        enabled: true,
    });
}

fn ensure_session_row_created(setup: &mut SessionRuntimeSetup) -> Result<()> {
    if setup.session_created {
        return Ok(());
    }

    let cwd = setup.tool_ctx.cwd.display().to_string();
    kordi_session::store::create_session_with_id(&setup.conn, &setup.session_id, &cwd)?;
    // Do not persist the session's initial model/thinking defaults as transcript
    // entries. They are runtime defaults, not user-visible actions; only explicit
    // changes after the session exists should render as inline system chips.
    setup.session_created = true;
    Ok(())
}

fn session_has_visible_message_entries(conn: &rusqlite::Connection, session_id: &str) -> bool {
    // A "visible" entry is a User or Assistant message — the things a
    // person reads as transcript content. ModelChange / ThinkingLevel
    // / ContextSnapshot etc. are runtime metadata that shouldn't gate
    // whether the *next* model switch is worth recording.
    let result: rusqlite::Result<i64> = conn.query_row(
        "SELECT COUNT(*) FROM entries
         WHERE session_id = ?1 AND type = 'message'",
        rusqlite::params![session_id],
        |row| row.get(0),
    );
    matches!(result, Ok(count) if count > 0)
}

fn append_model_change_entry(
    conn: &rusqlite::Connection,
    session_id: &str,
    model: &Model,
) -> Result<()> {
    let entry = SessionEntry::ModelChange {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: crate::turn_runner::get_leaf_raw(conn, session_id),
            timestamp: Utc::now(),
        },
        provider: model.provider.clone(),
        model_id: model.id.clone(),
    };
    kordi_session::store::append_entry(conn, session_id, &entry)?;
    Ok(())
}

fn append_thinking_level_change_entry(
    conn: &rusqlite::Connection,
    session_id: &str,
    thinking_level: ThinkingLevel,
) -> Result<()> {
    let entry = SessionEntry::ThinkingLevelChange {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: crate::turn_runner::get_leaf_raw(conn, session_id),
            timestamp: Utc::now(),
        },
        thinking_level,
    };
    kordi_session::store::append_entry(conn, session_id, &entry)?;
    Ok(())
}

fn maybe_name_session_from_prompt(
    conn: &rusqlite::Connection,
    session_id: &str,
    prompt: &str,
) -> Result<()> {
    let Some(row) = kordi_session::store::get_session(conn, session_id)? else {
        return Ok(());
    };
    let can_backfill_legacy = row.title_source == kordi_session::store::SessionTitleSource::Legacy
        && row
            .name
            .as_deref()
            .is_some_and(kordi_session::naming::is_known_legacy_auto_title);
    if (!matches!(
        row.title_source,
        kordi_session::store::SessionTitleSource::Placeholder
            | kordi_session::store::SessionTitleSource::Auto
    ) && !can_backfill_legacy)
        || (row.title_source == kordi_session::store::SessionTitleSource::Auto
            && row.title_revision >= 2)
    {
        return Ok(());
    }

    let Some(title) = session_title_from_seed(prompt) else {
        return Ok(());
    };
    kordi_session::store::set_auto_session_name(conn, session_id, &title, None)?;
    Ok(())
}

#[cfg(test)]
mod tests;
