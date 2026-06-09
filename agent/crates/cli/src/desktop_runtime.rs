use anyhow::{Result, anyhow, bail};
use chrono::{DateTime, Utc};
use kordi_core::agent_session::ThinkingLevel;
use kordi_core::settings::Settings;
use kordi_core::types::{ContentBlock, EntryBase, EntryId, SessionEntry};
use kordi_provider::registry::Model;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tokio::sync::mpsc;

use crate::login;
use crate::session_bootstrap::{
    SessionAuthChoiceOverride, SessionBootstrapOptions, SessionRuntimeSetup,
    prepare_session_runtime_for_cwd,
};
use crate::turn_runner::{self, TurnConfig, TurnEvent, run_turn};
mod attachments;
mod model_options;
mod session_catalog;
mod session_detail;
mod transcript;

use attachments::{
    append_attachment_context_message, attachment_is_image, attachment_metadata_from_path,
    attachment_summary_from_metadata, expand_prompt_with_attachment_paths, load_images_from_paths,
};

pub use model_options::{
    authenticated_model_options, clear_desktop_model_options_cache,
    desktop_thinking_levels_for_model, desktop_thinking_levels_for_model_id,
};

use model_options::{
    effective_thinking_for_model, normalize_setup_thinking, request_thinking_for_model,
    resolve_auth_choice_override_for_model, resolve_model_candidate,
};
use session_catalog::{
    load_project_info, open_sessions_db, project_group_id, repair_session_title_from_history,
    runtime_cwd_for_session, session_activity_label, session_row_display_name,
    session_title_from_messages, session_title_from_seed, truncate_chars,
};
use session_detail::{
    build_agent_profile_from_setup, build_detail_from_setup, build_summary_from_setup,
};
pub(crate) use session_detail::{format_message_timestamp, format_utc_timestamp, thinking_label};
use transcript::load_session_messages;

pub use session_catalog::{list_project_groups, list_session_summaries, register_project};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatModelOption {
    pub provider: String,
    pub provider_label: String,
    pub value: String,
    pub label: String,
    pub detail: String,
    pub thinking_levels: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatSlashCommand {
    pub label: String,
    pub detail: Option<String>,
    pub value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopVisibleTaskRecord {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub involved_participants: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatContextMessage {
    pub id: String,
    pub author_name: String,
    pub author_kind: String,
    pub text: String,
    pub created_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatStoredTool {
    pub id: String,
    pub name: String,
    pub status: String,
    pub arguments: String,
    pub live_output: String,
    pub result_text: Option<String>,
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_layer: Option<String>,
    pub is_error: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

const ATTACHMENT_CONTEXT_CUSTOM_TYPE: &str = "desktop_attachment_context";
const CLOUD_AGENT_CONTEXT_CUSTOM_TYPE: &str = "cloud_agent_context_message";
const DESKTOP_BRIDGE_OUTREACH_CONTEXT_START: &str = "\n\n<desktop_bridge_outreach_context>";

fn visible_task_record_status_for_store(status: &str) -> String {
    match status.trim().to_ascii_lowercase().as_str() {
        "closed" | "complete" | "completed" => "closed".to_string(),
        "failed" => "failed".to_string(),
        _ => "open".to_string(),
    }
}
const DESKTOP_BRIDGE_OUTREACH_CONTEXT_END: &str = "</desktop_bridge_outreach_context>";
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatAttachment {
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSessionArtifact {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub summary: String,
    pub time_label: Option<String>,
    pub pinned: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatMessage {
    pub role: String,
    pub sender: Option<String>,
    pub text: String,
    pub detail: Option<String>,
    pub time_label: String,
    pub timestamp_ms: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub failed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<DesktopChatAttachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<DesktopChatStoredTool>,
    /// Stable id of the underlying session entry. Present for messages
    /// that map 1:1 to a `SessionEntry` (e.g., user messages); `None`
    /// for synthesized rows like assistant turn aggregations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatSessionSummary {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub updated_at_label: String,
    pub message_count: usize,
    pub draft: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_message_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatProjectGroup {
    pub id: String,
    pub name: String,
    pub root: String,
    pub summary: String,
    pub background_system: Option<String>,
    pub shared_sources: Vec<DesktopChatProjectSource>,
    pub sessions: Vec<DesktopChatSessionSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatContextWindowStatus {
    pub context_window: u64,
    pub used_tokens: Option<u64>,
    pub used_percent: Option<f64>,
    pub auto_compaction: bool,
    pub compaction_threshold_percent: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatProjectSource {
    pub label: String,
    pub path: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatProjectInfo {
    pub name: String,
    pub root: String,
    pub shared_context: Option<String>,
    pub background_system: Option<String>,
    pub shared_sources: Vec<DesktopChatProjectSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatAgentProfile {
    pub label: String,
    pub system_prompt: String,
    pub loaded_skills: Vec<String>,
    pub loaded_tools: Vec<String>,
    pub loaded_plugins: Vec<String>,
    pub identity_files: Vec<String>,
    pub default_provider: String,
    pub default_model: String,
    pub workspace_root: String,
    pub last_activities: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatSessionDetail {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub provider: String,
    pub provider_label: String,
    pub model: String,
    pub model_label: String,
    pub thinking: String,
    pub thinking_label: String,
    pub thinking_levels: Vec<String>,
    pub updated_at_label: String,
    pub message_count: usize,
    pub draft: bool,
    pub cache_monitor_text: Option<String>,
    pub context_window_text: String,
    pub context_window_status: DesktopChatContextWindowStatus,
    pub project: Option<DesktopChatProjectInfo>,
    pub reflection_lesson_artifacts: Vec<DesktopSessionArtifact>,
    pub messages: Vec<DesktopChatMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from_message_id: Option<String>,
}

pub struct DesktopRuntimeSession {
    setup: SessionRuntimeSetup,
}

pub struct DesktopRuntimeTurn {
    event_rx: mpsc::UnboundedReceiver<TurnEvent>,
    handle: tokio::task::JoinHandle<(TurnConfig, Result<()>)>,
}

pub struct DesktopRuntimeTurnResult {
    returned_config: TurnConfig,
    turn_result: Result<()>,
    turn_error: Option<String>,
}

impl DesktopRuntimeTurn {
    pub async fn run<F>(mut self, mut on_event: F) -> Result<DesktopRuntimeTurnResult>
    where
        F: FnMut(&TurnEvent),
    {
        let mut turn_error: Option<String> = None;
        while let Some(event) = self.event_rx.recv().await {
            on_event(&event);
            match &event {
                TurnEvent::ContextOverflow { message } => turn_error = Some(message.clone()),
                TurnEvent::Error(message) => turn_error = Some(message.clone()),
                _ => {}
            }
        }

        let (returned_config, turn_result) = self
            .handle
            .await
            .map_err(|err| anyhow!("turn task failed: {err}"))?;
        Ok(DesktopRuntimeTurnResult {
            returned_config,
            turn_result,
            turn_error,
        })
    }
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

                let cwd = self.setup.tool_ctx.cwd.clone();
                let session_id = self.setup.session_id.clone();
                let entry = SessionBootstrapOptions {
                    session: Some(session_id),
                    ..SessionBootstrapOptions::default()
                };
                let (_runtime_host, _ui, setup) =
                    prepare_session_runtime_for_cwd(cwd, entry).await?;
                self.setup = setup;

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

                let cwd = self.setup.tool_ctx.cwd.clone();
                let session_id = self.setup.session_id.clone();
                let entry = SessionBootstrapOptions {
                    session: Some(session_id),
                    ..SessionBootstrapOptions::default()
                };
                let (_runtime_host, _ui, setup) =
                    prepare_session_runtime_for_cwd(cwd, entry).await?;
                self.setup = setup;

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

    pub fn set_model(&mut self, requested_model: &str) -> Result<()> {
        let settings = Settings::load_merged(&self.setup.tool_ctx.cwd);
        let model =
            resolve_model_candidate(&settings, requested_model, Some(&self.setup.model.provider))?;
        let changed =
            self.setup.model.provider != model.provider || self.setup.model.id != model.id;
        self.setup.model = model;
        let requested_thinking =
            ThinkingLevel::parse(&self.setup.thinking_level).unwrap_or(ThinkingLevel::Off);
        let effective_thinking =
            effective_thinking_for_model(requested_thinking, &self.setup.model);
        let thinking_changed = self.setup.thinking_level != effective_thinking.as_str();
        if thinking_changed {
            self.setup.thinking_level = effective_thinking.as_str().to_string();
        }
        refresh_provider_runtime_fields(&mut self.setup);
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

    pub fn set_auth_choice(&mut self, provider: &str, choice: &str) -> Result<()> {
        let provider = provider.trim();
        let choice = choice.trim();
        if provider.is_empty() || choice.is_empty() {
            self.setup.auth_choice_override = None;
            refresh_provider_runtime_fields(&mut self.setup);
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
        if login::resolve_provider_auth_choice(provider, choice).is_none() {
            bail!("Unknown auth choice for {provider}: {choice}");
        }

        self.setup.auth_choice_override = Some(SessionAuthChoiceOverride {
            provider: provider.to_string(),
            choice: choice.to_string(),
        });
        refresh_provider_runtime_fields(&mut self.setup);
        Ok(())
    }

    pub fn set_thinking(&mut self, requested_thinking: &str) -> Result<()> {
        let requested = ThinkingLevel::parse(requested_thinking)
            .ok_or_else(|| anyhow!("Unknown thinking level: {requested_thinking}"))?;
        let thinking = effective_thinking_for_model(requested, &self.setup.model);
        let changed = self.setup.thinking_level != thinking.as_str();
        self.setup.thinking_level = thinking.as_str().to_string();
        if changed && self.setup.session_created {
            append_thinking_level_change_entry(&self.setup.conn, &self.setup.session_id, thinking)?;
        }
        Ok(())
    }

    pub fn set_reach_out_runtime(&mut self, runtime: Option<kordi_tools::ReachOutRuntime>) {
        self.setup.tool_ctx.reach_out = runtime;
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

    pub fn set_bridge_outreach_prompt_context(&mut self, context: Option<String>) {
        let base_prompt = strip_bridge_outreach_prompt_context(&self.setup.system_prompt);
        let Some(context) = context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            self.setup.system_prompt = base_prompt;
            return;
        };
        self.setup.system_prompt = format!(
            "{base_prompt}{DESKTOP_BRIDGE_OUTREACH_CONTEXT_START}\n{context}\n{DESKTOP_BRIDGE_OUTREACH_CONTEXT_END}"
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

    pub fn materialize_session(&mut self) -> Result<()> {
        ensure_session_row_created(&mut self.setup)
    }

    pub async fn send_message(
        &mut self,
        prompt: String,
        attachment_paths: Vec<String>,
    ) -> Result<DesktopChatSessionDetail> {
        self.send_message_streaming(
            prompt,
            attachment_paths,
            tokio_util::sync::CancellationToken::new(),
            |_| {},
        )
        .await
    }

    pub async fn begin_message_streaming(
        &mut self,
        prompt: String,
        attachment_paths: Vec<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<DesktopRuntimeTurn> {
        let prompt = prompt.trim().to_string();
        if prompt.is_empty() && attachment_paths.is_empty() {
            bail!("Message cannot be empty");
        }

        let expanded = expand_prompt_with_attachment_paths(
            &prompt,
            &attachment_paths,
            &self.setup.tool_ctx.cwd,
        );
        let prompt_text = expanded.text.trim().to_string();
        if prompt_text.is_empty() && expanded.image_paths.is_empty() {
            bail!("Message cannot be empty");
        }
        let image_attachment_paths = attachment_paths
            .iter()
            .filter(|path| attachment_is_image(path))
            .cloned()
            .collect::<Vec<_>>();
        let non_image_attachment_paths = attachment_paths
            .iter()
            .filter(|path| !attachment_is_image(path))
            .cloned()
            .collect::<Vec<_>>();
        let images = load_images_from_paths(
            &image_attachment_paths
                .iter()
                .map(std::path::PathBuf::from)
                .collect::<Vec<_>>(),
        )?;
        let attachment_metadata = attachment_paths
            .iter()
            .map(|path| attachment_metadata_from_path(path))
            .collect::<Vec<_>>();
        let attachment_context_text = if non_image_attachment_paths.is_empty() {
            String::new()
        } else {
            expand_prompt_with_attachment_paths(
                "",
                &non_image_attachment_paths,
                &self.setup.tool_ctx.cwd,
            )
            .text
            .trim()
            .to_string()
        };

        ensure_session_row_created(&mut self.setup)?;
        let session_title_seed = if prompt.is_empty() {
            attachment_summary_from_metadata(&attachment_metadata)
                .unwrap_or_else(|| prompt_text.clone())
        } else {
            prompt.clone()
        };
        maybe_name_session_from_prompt(
            &self.setup.conn,
            &self.setup.session_id,
            &session_title_seed,
        )?;
        let sibling_conn = self
            .setup
            .sibling_conn
            .clone()
            .ok_or_else(|| anyhow!("Session DB connection is unavailable"))?;
        turn_runner::append_interrupted_unanswered_request_if_needed(
            &sibling_conn,
            &self.setup.session_id,
            &self.setup.model,
        )
        .await?;
        turn_runner::append_user_message_with_images(
            &sibling_conn,
            &self.setup.session_id,
            &prompt,
            &images,
        )
        .await?;
        append_attachment_context_message(
            &sibling_conn,
            &self.setup.session_id,
            &attachment_context_text,
            &attachment_metadata,
        )
        .await?;
        refresh_provider_runtime_fields(&mut self.setup);

        let turn_config = build_turn_config(&mut self.setup, cancel)?;
        let (turn_event_tx, turn_event_rx) = mpsc::unbounded_channel::<TurnEvent>();
        let handle =
            tokio::spawn(async move { run_turn(turn_config, turn_event_tx, prompt_text).await });

        Ok(DesktopRuntimeTurn {
            event_rx: turn_event_rx,
            handle,
        })
    }

    pub fn finish_message_streaming(
        &mut self,
        result: DesktopRuntimeTurnResult,
    ) -> Result<DesktopChatSessionDetail> {
        self.setup.tool_registry = result.returned_config.tool_registry;

        result.turn_result?;
        if let Some(message) = result.turn_error {
            bail!(message);
        }

        self.detail()
    }

    pub async fn send_message_streaming<F>(
        &mut self,
        prompt: String,
        attachment_paths: Vec<String>,
        cancel: tokio_util::sync::CancellationToken,
        on_event: F,
    ) -> Result<DesktopChatSessionDetail>
    where
        F: FnMut(&TurnEvent),
    {
        let turn = self
            .begin_message_streaming(prompt, attachment_paths, cancel)
            .await?;
        let result = turn.run(on_event).await?;
        self.finish_message_streaming(result)
    }
}

fn strip_bridge_outreach_prompt_context(prompt: &str) -> String {
    let Some(start) = prompt.find(DESKTOP_BRIDGE_OUTREACH_CONTEXT_START) else {
        return prompt.to_string();
    };
    let Some(end_relative) = prompt[start..].find(DESKTOP_BRIDGE_OUTREACH_CONTEXT_END) else {
        return prompt.to_string();
    };
    let end = start + end_relative + DESKTOP_BRIDGE_OUTREACH_CONTEXT_END.len();
    format!("{}{}", &prompt[..start], &prompt[end..])
        .trim_end()
        .to_string()
}

pub fn session_exists(session_id: &str) -> Result<bool> {
    let conn = open_sessions_db()?;
    Ok(kordi_session::store::get_session(&conn, session_id)?.is_some())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopForkSessionOutcome {
    pub session_id: String,
    pub source_session_id: String,
    pub source_entry_id: String,
    pub selected_text: String,
    pub branch_leaf_id: Option<String>,
    pub cwd: String,
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
    if session_row_display_name(&row).is_some() {
        return Ok(());
    }

    let Some(title) = session_title_from_seed(prompt) else {
        return Ok(());
    };
    kordi_session::store::set_session_name(conn, session_id, Some(&title))?;
    Ok(())
}

fn build_turn_config(
    setup: &mut SessionRuntimeSetup,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<TurnConfig> {
    let sibling_conn = if let Some(conn) = setup.sibling_conn.clone() {
        conn
    } else {
        let conn = turn_runner::open_sibling_conn(&setup.conn)?;
        setup.sibling_conn = Some(conn.clone());
        conn
    };
    let tool_registry = std::mem::take(&mut setup.tool_registry);

    let request_thinking = request_thinking_for_model(&setup.thinking_level, &setup.model);

    Ok(TurnConfig {
        conn: sibling_conn,
        session_id: setup.session_id.clone(),
        system_prompt: setup.system_prompt.clone(),
        model: setup.model.clone(),
        provider: setup.provider.clone(),
        auth: setup.auth.clone(),
        api_key: setup.api_key.clone(),
        base_url: setup.base_url.clone(),
        headers: setup.headers.clone(),
        compaction_settings: kordi_core::types::CompactionSettings {
            enabled: setup.compaction_enabled,
            reserve_tokens: setup.compaction_reserve_tokens,
            keep_recent_tokens: setup.compaction_keep_recent_tokens,
        },
        tool_registry,
        tool_ctx: kordi_tools::ToolContext {
            cwd: setup.tool_ctx.cwd.clone(),
            artifacts_dir: setup.tool_ctx.artifacts_dir.clone(),
            model: None,
            execution_policy: setup.tool_ctx.execution_policy,
            on_output: None,
            web_search: setup.tool_ctx.web_search.clone(),
            reach_out: setup.tool_ctx.reach_out.clone(),
            reflection: setup.tool_ctx.reflection.clone(),
            session_observation: setup.tool_ctx.session_observation.clone(),
            task_operator: setup.tool_ctx.task_operator.clone(),
            execution_mode: setup.tool_ctx.execution_mode,
            request_approval: setup.tool_ctx.request_approval.clone(),
        },
        thinking: request_thinking,
        retry_enabled: setup.retry_enabled,
        retry_max_retries: setup.retry_max_retries,
        retry_base_delay_ms: setup.retry_base_delay_ms,
        retry_max_delay_ms: setup.retry_max_delay_ms,
        cancel,
        extensions: setup.extension_commands.clone(),
        request_metrics_tracker: setup.request_metrics_tracker.clone(),
        request_metrics_log_path: setup.request_metrics_log_path.clone(),
    })
}

#[cfg(test)]
mod tests;
