use anyhow::{Result, anyhow, bail};
use chrono::{Local, TimeZone, Utc};
use kordi_core::agent_session::ThinkingLevel;
use kordi_core::settings::Settings;
use kordi_core::types::{EntryBase, EntryId, SessionEntry};
use kordi_monitor::{
    CacheMonitorTextInput, ContextResolutionInput, ContextWindowStatus, RequestCacheMetrics,
    SessionCacheMetricsSource, latest_request_metrics_for_session, render_cache_monitor_text,
    render_context_window_status, resolve_context_window_status,
};
use kordi_provider::registry::Model;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::login;
use crate::session_bootstrap::{
    SessionAuthChoiceOverride, SessionBootstrapOptions, SessionRuntimeSetup,
    prepare_session_runtime_for_cwd,
};
use crate::session_info::collect_session_info_summary;
use crate::turn_runner::{self, TurnConfig, TurnEvent, run_turn};
mod attachments;
mod model_options;
mod session_catalog;
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
    pub is_error: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

const ATTACHMENT_CONTEXT_CUSTOM_TYPE: &str = "desktop_attachment_context";
const DESKTOP_BRIDGE_OUTREACH_CONTEXT_START: &str = "\n\n<desktop_bridge_outreach_context>";
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
    pub messages: Vec<DesktopChatMessage>,
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
        setup.session_id = session_id.to_string();
        setup.session_created = false;
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
        if changed && self.setup.session_created {
            append_model_change_entry(&self.setup.conn, &self.setup.session_id, &self.setup.model)?;
        }
        if thinking_changed && self.setup.session_created {
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
            execution_policy: setup.tool_ctx.execution_policy,
            on_output: None,
            web_search: setup.tool_ctx.web_search.clone(),
            reach_out: setup.tool_ctx.reach_out.clone(),
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

fn discover_workspace_root(cwd: &std::path::Path) -> std::path::PathBuf {
    let mut dir = cwd.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return dir;
        }
        if !dir.pop() {
            return cwd.to_path_buf();
        }
    }
}

fn repo_relative_display_path(root: &std::path::Path, path: &std::path::Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|relative| relative.display().to_string())
}

fn infer_agent_label(_cwd: &std::path::Path) -> String {
    // The desktop runtime's built-in local agent has a stable product identity.
    // Project names describe workspace grouping, not the agent itself; bridge
    // agents can still provide custom labels through bridge configuration.
    "Kordi".to_string()
}

fn collect_agent_identity_files(cwd: &std::path::Path) -> Vec<String> {
    let workspace_root = discover_workspace_root(cwd);
    let mut files = Vec::new();

    let project_settings = kordi_core::config::project_settings_path(cwd);
    if project_settings.exists() {
        if let Some(relative) = repo_relative_display_path(&workspace_root, &project_settings) {
            files.push(relative);
        }
    }

    let mut dir = cwd.to_path_buf();
    let mut scanned = Vec::new();
    loop {
        let agents = dir.join("AGENTS.md");
        if agents.exists() {
            scanned.push(agents);
        } else {
            let claude = dir.join("CLAUDE.md");
            if claude.exists() {
                scanned.push(claude);
            }
        }

        if dir == workspace_root {
            break;
        }
        if !dir.pop() {
            break;
        }
    }

    scanned.reverse();
    files.extend(
        scanned
            .into_iter()
            .filter_map(|path| repo_relative_display_path(&workspace_root, &path)),
    );
    files.dedup();
    files
}

fn build_agent_profile_from_setup(setup: &SessionRuntimeSetup) -> DesktopChatAgentProfile {
    let loaded_skills = setup
        .slash_command_items
        .iter()
        .filter_map(|item| item.value.strip_prefix("/skill:").map(ToString::to_string))
        .collect::<Vec<_>>();
    let loaded_tools = setup
        .tool_registry
        .active_tools()
        .iter()
        .map(|tool| tool.name().to_string())
        .collect::<Vec<_>>();
    let loaded_plugins = setup
        .extension_bootstrap
        .package_sources
        .iter()
        .cloned()
        .chain(
            setup
                .extension_bootstrap
                .paths
                .iter()
                .map(|path| path.display().to_string()),
        )
        .collect::<Vec<_>>();

    DesktopChatAgentProfile {
        label: infer_agent_label(&setup.tool_ctx.cwd),
        system_prompt: setup.system_prompt.clone(),
        loaded_skills,
        loaded_tools,
        loaded_plugins,
        identity_files: collect_agent_identity_files(&setup.tool_ctx.cwd),
        default_provider: setup.model.provider.clone(),
        default_model: setup.model.id.clone(),
        workspace_root: setup.tool_ctx.cwd.display().to_string(),
        last_activities: vec![
            format!("Workspace: {}", setup.tool_ctx.cwd.display()),
            format!("Model: {}/{}", setup.model.provider, setup.model.id),
            format!("Thinking: {}", setup.thinking_level),
        ],
    }
}

fn build_summary_from_setup(setup: &SessionRuntimeSetup) -> Result<DesktopChatSessionSummary> {
    let detail = build_detail_from_setup(setup)?;
    Ok(DesktopChatSessionSummary {
        id: detail.id,
        title: detail.title,
        subtitle: detail.subtitle,
        updated_at_label: detail.updated_at_label,
        message_count: detail.message_count,
        draft: detail.draft,
    })
}

fn build_detail_from_setup(setup: &SessionRuntimeSetup) -> Result<DesktopChatSessionDetail> {
    let session_row = if setup.session_created {
        kordi_session::store::get_session(&setup.conn, &setup.session_id)?
    } else {
        None
    };
    let messages = if setup.session_created {
        load_session_messages(&setup.conn, &setup.session_id)?
    } else {
        Vec::new()
    };

    let title = if let Some(row) = session_row.as_ref() {
        repair_session_title_from_history(&setup.conn, row)?
            .or_else(|| session_title_from_messages(&messages))
            .unwrap_or_else(|| "New session".to_string())
    } else {
        "New session".to_string()
    };
    let subtitle = session_focus_subtitle(&messages).unwrap_or_default();
    let updated_at_label = session_row
        .as_ref()
        .map(|row| session_activity_label(&setup.conn, row))
        .unwrap_or_else(|| "Draft".to_string());

    let context_window_status = current_context_window_status(setup);
    let project = session_row
        .as_ref()
        .filter(|row| row.session_scope == "project")
        .and_then(|row| row.project_root.as_deref())
        .map(std::path::PathBuf::from)
        .as_deref()
        .and_then(load_project_info);

    Ok(DesktopChatSessionDetail {
        id: setup.session_id.clone(),
        title,
        subtitle,
        provider: setup.model.provider.clone(),
        provider_label: login::provider_display_name(&setup.model.provider).into_owned(),
        model: setup.model.id.clone(),
        model_label: setup.model.id.clone(),
        thinking: setup.thinking_level.clone(),
        thinking_label: thinking_label(&setup.thinking_level),
        thinking_levels: desktop_thinking_levels_for_model(&setup.model),
        updated_at_label,
        message_count: messages.len(),
        draft: !setup.session_created,
        cache_monitor_text: current_cache_monitor_text(setup),
        context_window_text: render_context_window_status(&context_window_status),
        context_window_status: DesktopChatContextWindowStatus {
            context_window: context_window_status.context_window,
            used_tokens: context_window_status.used_tokens,
            used_percent: context_window_status.used_percent,
            auto_compaction: context_window_status.auto_compaction,
            compaction_threshold_percent:
                kordi_session::compaction::AUTO_COMPACTION_THRESHOLD_PERCENT,
        },
        project,
        messages,
    })
}

fn current_auth_cache_metrics_source(
    auth: Option<&crate::login::ResolvedProviderAuth>,
) -> Option<SessionCacheMetricsSource> {
    auth.map(|auth| match auth.method {
        crate::login::ProviderAuthMethod::OAuth => SessionCacheMetricsSource::Estimated,
        crate::login::ProviderAuthMethod::ApiKey => SessionCacheMetricsSource::Official,
    })
}

fn request_matches_cache_domain(
    metrics: &RequestCacheMetrics,
    provider: &str,
    model: &str,
    current_context_epoch: Option<u64>,
) -> bool {
    metrics.provider == provider
        && metrics.model == model
        && current_context_epoch.is_none_or(|epoch| metrics.context_epoch == epoch)
}

fn active_path_has_contextful_entries(path: &[kordi_session::store::EntryRow]) -> bool {
    path.iter().any(|row| row.entry_type == "message")
}

fn estimate_active_path_context_tokens(path: &[kordi_session::store::EntryRow]) -> Option<u64> {
    let latest_compaction_index = path.iter().rposition(|row| row.entry_type == "compaction");
    if let Some(compaction_index) = latest_compaction_index {
        let has_post_compaction_usage = path.iter().skip(compaction_index + 1).rev().any(|row| {
            let Ok(entry) = kordi_session::store::parse_entry(row) else {
                return false;
            };
            match entry {
                kordi_core::types::SessionEntry::Message {
                    message: kordi_core::types::AgentMessage::Assistant(assistant),
                    ..
                } => {
                    assistant.stop_reason != kordi_core::types::StopReason::Aborted
                        && assistant.stop_reason != kordi_core::types::StopReason::Error
                        && kordi_session::compaction::calculate_context_tokens(&assistant.usage) > 0
                }
                _ => false,
            }
        });
        if !has_post_compaction_usage {
            return None;
        }
    }

    kordi_session::context::build_context_from_path(path)
        .ok()
        .map(|ctx| kordi_session::compaction::estimate_context_tokens(&ctx.messages).tokens)
}

fn current_cache_monitor_text(setup: &SessionRuntimeSetup) -> Option<String> {
    let summary = collect_session_info_summary(
        &setup.conn,
        &setup.session_id,
        &setup.model.provider,
        &setup.model.id,
        &setup.thinking_level,
        setup.tool_ctx.execution_policy,
        setup.auth.as_ref(),
    )
    .ok()?;

    let latest_request = setup.request_metrics_log_path.as_ref().and_then(|path| {
        latest_request_metrics_for_session(path, &setup.session_id)
            .ok()
            .flatten()
    });
    let current_context_epoch = setup
        .request_metrics_tracker
        .try_lock()
        .ok()
        .map(|tracker| tracker.state().context_epoch);
    let latest_matches_current_cache_domain = latest_request.as_ref().is_some_and(|metrics| {
        request_matches_cache_domain(
            metrics,
            &setup.model.provider,
            &setup.model.id,
            current_context_epoch,
        )
    });
    let source = if latest_matches_current_cache_domain {
        latest_request.as_ref().map(|metrics| {
            SessionCacheMetricsSource::from_cache_metrics_source(Some(
                &metrics.cache_metrics_source,
            ))
        })
    } else {
        current_auth_cache_metrics_source(setup.auth.as_ref())
            .or(summary.cache_metrics_source.clone())
    };
    let latest_hit_rate_pct = if latest_matches_current_cache_domain {
        latest_request
            .as_ref()
            .and_then(|metrics| metrics.cache_read_hit_rate_pct)
    } else if latest_request.is_some() {
        Some(0.0)
    } else {
        None
    };

    render_cache_monitor_text(&CacheMonitorTextInput {
        source,
        average_hit_rate_pct: summary.cache_read_hit_rate_pct,
        latest_hit_rate_pct,
        has_cache_activity: summary.cache_read_tokens > 0
            || summary.cache_write_tokens > 0
            || summary.input_tokens > 0,
    })
}

fn current_context_window_status(setup: &SessionRuntimeSetup) -> ContextWindowStatus {
    let active_path = kordi_session::tree::active_path(&setup.conn, &setup.session_id).ok();
    let latest_entry_is_compaction = active_path
        .as_ref()
        .and_then(|rows| rows.last())
        .is_some_and(|row| row.entry_type == "compaction");
    let suppress_runtime_usage = latest_entry_is_compaction;
    let context_window = setup.model.context_window;
    let active_path_tokens = if suppress_runtime_usage {
        None
    } else {
        active_path
            .as_deref()
            .and_then(estimate_active_path_context_tokens)
    };

    resolve_context_window_status(&ContextResolutionInput {
        runtime_usage: None,
        active_path_tokens,
        has_contextful_active_path: active_path
            .as_deref()
            .is_some_and(active_path_has_contextful_entries),
        context_window,
        auto_compaction: setup.compaction_enabled,
        suppress_runtime_usage,
    })
}

fn session_focus_subtitle(messages: &[DesktopChatMessage]) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .or_else(|| {
            messages
                .iter()
                .rev()
                .find(|message| message.role == "assistant")
        })
        .and_then(|message| {
            let text = message.text.replace('\n', " ").trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
            attachment_summary_from_metadata(&message.attachments)
        })
        .map(|value| truncate_chars(&value, 96))
        .filter(|value| !value.trim().is_empty())
}

fn thinking_label(value: &str) -> String {
    match ThinkingLevel::parse(value) {
        Some(ThinkingLevel::Off) => "Off".to_string(),
        Some(ThinkingLevel::Default) => "Default".to_string(),
        Some(ThinkingLevel::Minimal) => "Minimal".to_string(),
        Some(ThinkingLevel::Low) => "Low".to_string(),
        Some(ThinkingLevel::Medium) => "Medium".to_string(),
        Some(ThinkingLevel::High) => "High".to_string(),
        Some(ThinkingLevel::XHigh) => "Extra High".to_string(),
        None => value.to_string(),
    }
}

fn format_message_timestamp(timestamp_ms: i64) -> String {
    format_utc_timestamp(timestamp_ms)
}

fn format_utc_timestamp(timestamp_ms: i64) -> String {
    let local = Local.timestamp_millis_opt(timestamp_ms).single();
    match local {
        Some(datetime) => datetime.format("%H:%M").to_string(),
        None => "--:--".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_core::settings::ProviderOverride;
    use std::sync::Mutex;

    fn env_lock() -> &'static Mutex<()> {
        crate::login::auth_test_env_lock()
    }

    struct EnvVarGuard {
        key: &'static str,
        old: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set_value(key: &'static str, value: &str) -> Self {
            let old = std::env::var_os(key);
            unsafe { std::env::set_var(key, value) };
            Self { key, old }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(value) = &self.old {
                unsafe { std::env::set_var(self.key, value) };
            } else {
                unsafe { std::env::remove_var(self.key) };
            }
        }
    }

    fn local_provider_settings(provider: &str, base_url: &str) -> Settings {
        Settings {
            providers: Some(vec![ProviderOverride {
                name: provider.to_string(),
                base_url: Some(base_url.to_string()),
                api_key_env: None,
                api: None,
                headers: None,
            }]),
            ..Settings::default()
        }
    }

    fn lm_studio_settings() -> Settings {
        local_provider_settings("lm-studio", "http://localhost:1234/v1")
    }

    #[test]
    fn attachment_metadata_from_path_includes_size_local_path_and_mime_type() -> Result<()> {
        let path = std::env::temp_dir().join(format!(
            "kordi-attachment-test-{}.png",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, b"png-bytes")?;

        let metadata = attachment_metadata_from_path(path.to_str().expect("temp path is utf-8"));

        assert_eq!(metadata.kind, "image");
        assert_eq!(metadata.format_label.as_deref(), Some("PNG"));
        assert_eq!(metadata.mime_type.as_deref(), Some("image/png"));
        assert_eq!(metadata.local_path.as_deref(), path.to_str());
        assert_eq!(metadata.size_bytes, Some(9));

        std::fs::remove_file(path)?;
        Ok(())
    }

    #[test]
    fn local_model_id_with_publisher_slash_stays_on_current_local_provider() -> Result<()> {
        let model = resolve_model_candidate(
            &lm_studio_settings(),
            "google/gemma-4-e4b",
            Some("lm-studio"),
        )?;

        assert_eq!(model.provider, "lm-studio");
        assert_eq!(model.id, "google/gemma-4-e4b");
        Ok(())
    }

    #[test]
    fn ollama_model_selection_resolves_to_ollama_provider() -> Result<()> {
        let model = resolve_model_candidate(
            &local_provider_settings("ollama", "http://localhost:11434/v1"),
            "ollama/llama3.2:latest",
            Some("anthropic"),
        )?;

        assert_eq!(model.provider, "ollama");
        assert_eq!(model.id, "llama3.2:latest");
        Ok(())
    }

    #[test]
    fn bridge_agent_auth_override_resolves_choice_without_changing_global_provider() {
        let _lock = env_lock().lock().unwrap();
        let _openai = EnvVarGuard::set_value("OPENAI_API_KEY", "env-openai-key");
        let choice = SessionAuthChoiceOverride {
            provider: "openai-codex".to_string(),
            choice: "env:api-key".to_string(),
        };

        let auth = resolve_auth_choice_override_for_model("openai", &choice)
            .expect("matching OpenAI route resolves explicit auth choice");

        assert_eq!(auth.credential, "env-openai-key");
        assert_eq!(auth.method, crate::login::ProviderAuthMethod::ApiKey);
        assert!(resolve_auth_choice_override_for_model("anthropic", &choice).is_none());
    }

    fn test_model(provider: &str, id: &str, reasoning: bool) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            provider: provider.to_string(),
            api: kordi_provider::registry::ApiType::OpenaiCompletions,
            context_window: 4096,
            max_tokens: 1024,
            reasoning,
            input: vec![kordi_provider::registry::ModelInput::Text],
            base_url: None,
            cost: kordi_provider::registry::CostConfig::default(),
        }
    }

    #[test]
    fn non_reasoning_models_do_not_send_thinking_controls() {
        let model = test_model("ollama", "qwen:1.8b-chat", false);
        assert_eq!(desktop_thinking_levels_for_model(&model), vec!["off"]);
        assert_eq!(request_thinking_for_model("medium", &model), None);
        assert_eq!(
            effective_thinking_for_model(ThinkingLevel::Medium, &model),
            ThinkingLevel::Off
        );

        let reasoning_model = test_model("openai", "gpt-5", true);
        assert_eq!(
            desktop_thinking_levels_for_model(&reasoning_model),
            vec!["off", "minimal", "low", "medium", "high"]
        );
        assert_eq!(
            request_thinking_for_model("medium", &reasoning_model).as_deref(),
            Some("medium")
        );
    }

    #[test]
    fn xhigh_is_exposed_only_for_supported_model_families() {
        let gpt = test_model("openai", "gpt-5.4", true);
        assert_eq!(
            desktop_thinking_levels_for_model(&gpt),
            vec!["off", "minimal", "low", "medium", "high", "xhigh"]
        );
        assert_eq!(
            effective_thinking_for_model(ThinkingLevel::XHigh, &gpt),
            ThinkingLevel::XHigh
        );
        assert_eq!(
            request_thinking_for_model("Extra High", &gpt).as_deref(),
            Some("xhigh")
        );

        let standard = test_model("openai", "gpt-5.1-codex", true);
        assert_eq!(
            desktop_thinking_levels_for_model(&standard),
            vec!["off", "minimal", "low", "medium", "high"]
        );
        assert_eq!(
            effective_thinking_for_model(ThinkingLevel::XHigh, &standard),
            ThinkingLevel::High
        );

        let local = test_model("lm-studio", "gpt-oss-20b", true);
        assert_eq!(desktop_thinking_levels_for_model(&local), vec!["default"]);
        assert_eq!(
            effective_thinking_for_model(ThinkingLevel::XHigh, &local),
            ThinkingLevel::Default
        );
    }

    #[test]
    fn local_thinking_models_expose_only_documented_controls() {
        let qwen3 = test_model("ollama", "qwen3:30b", false);
        assert_eq!(desktop_thinking_levels_for_model(&qwen3), vec!["default"]);
        assert_eq!(
            effective_thinking_for_model(ThinkingLevel::High, &qwen3),
            ThinkingLevel::Default
        );
        assert_eq!(request_thinking_for_model("default", &qwen3), None);

        let gpt_oss = test_model("ollama", "gpt-oss:20b", false);
        assert_eq!(
            desktop_thinking_levels_for_model(&gpt_oss),
            vec!["low", "medium", "high"]
        );
        assert_eq!(
            effective_thinking_for_model(ThinkingLevel::Off, &gpt_oss),
            ThinkingLevel::Medium
        );
        assert_eq!(
            request_thinking_for_model("high", &gpt_oss).as_deref(),
            Some("high")
        );

        let lm_studio_r1 = test_model("lm-studio", "deepseek-r1-distill-qwen-7b", false);
        assert_eq!(
            desktop_thinking_levels_for_model(&lm_studio_r1),
            vec!["default"]
        );
        assert_eq!(request_thinking_for_model("default", &lm_studio_r1), None);

        let gemma = test_model("lm-studio", "google/gemma-4-e4b", false);
        assert_eq!(desktop_thinking_levels_for_model(&gemma), vec!["default"]);
        assert_eq!(request_thinking_for_model("off", &gemma), None);
    }

    #[test]
    fn ollama_selection_is_not_absorbed_by_current_lm_studio_provider() -> Result<()> {
        let settings = Settings {
            providers: Some(vec![
                ProviderOverride {
                    name: "lm-studio".to_string(),
                    base_url: Some("http://localhost:1234/v1".to_string()),
                    api_key_env: None,
                    api: None,
                    headers: None,
                },
                ProviderOverride {
                    name: "ollama".to_string(),
                    base_url: Some("http://localhost:11434/v1".to_string()),
                    api_key_env: None,
                    api: None,
                    headers: None,
                },
            ]),
            ..Settings::default()
        };
        let model = resolve_model_candidate(&settings, "ollama/qwen:1.8b-chat", Some("lm-studio"))?;

        assert_eq!(model.provider, "ollama");
        assert_eq!(model.id, "qwen:1.8b-chat");
        Ok(())
    }

    #[test]
    fn unconfigured_provider_prefix_is_not_synthesized_from_slash_model_id() {
        let settings = Settings::default();
        if login::provider_configured_for_settings(&settings, "google") {
            return;
        }

        let result = resolve_model_candidate(&settings, "google/gemma-4-e4b", None);

        assert!(result.is_err());
    }

    #[test]
    fn local_desktop_agent_label_is_not_inferred_from_project_name() {
        assert_eq!(
            infer_agent_label(std::path::Path::new("/tmp/any-project")),
            "Kordi"
        );
    }
}
