use anyhow::{Result, anyhow, bail};
use chrono::{Local, TimeZone, Utc};
use kordi_core::agent_session::{ImageContent, ThinkingLevel};
use kordi_core::settings::Settings;
use kordi_core::types::{
    AgentMessage, AssistantContent, ContentBlock, EntryBase, EntryId, SessionEntry,
};
use kordi_monitor::{
    CacheMonitorTextInput, ContextResolutionInput, ContextWindowStatus, RequestCacheMetrics,
    SessionCacheMetricsSource, latest_request_metrics_for_session, render_cache_monitor_text,
    render_context_window_status, resolve_context_window_status,
};
use kordi_provider::registry::{Model, ModelRegistry};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use crate::login;
use crate::session_bootstrap::{
    SessionAuthChoiceOverride, SessionBootstrapOptions, SessionRuntimeSetup,
    prepare_session_runtime_for_cwd,
};
use crate::session_info::collect_session_info_summary;
use crate::turn_runner::{self, TurnConfig, TurnEvent, run_turn};

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
    pub kind: String,
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
const DESKTOP_MODEL_OPTIONS_CACHE_TTL: Duration = Duration::from_secs(300);

static DESKTOP_MODEL_OPTIONS_CACHE: OnceLock<
    StdMutex<HashMap<String, (Instant, Vec<DesktopChatModelOption>)>>,
> = OnceLock::new();

fn desktop_model_options_cache()
-> &'static StdMutex<HashMap<String, (Instant, Vec<DesktopChatModelOption>)>> {
    DESKTOP_MODEL_OPTIONS_CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub fn clear_desktop_model_options_cache() {
    if let Ok(mut cache) = desktop_model_options_cache().lock() {
        cache.clear();
    }
}

fn desktop_model_options_cache_key(cwd: &Path, settings: &Settings) -> String {
    let mut parts = vec![cwd.display().to_string()];
    parts.push(format!(
        "default:{}:{}",
        settings.default_provider.as_deref().unwrap_or_default(),
        settings.default_model.as_deref().unwrap_or_default()
    ));
    for provider in login::authenticated_providers_for_settings(settings) {
        let active_method = login::active_auth_method(&provider)
            .map(|method| method.footer_label().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let active_option = login::provider_auth_option_summaries(&provider)
            .into_iter()
            .find(|option| option.active);
        let active_source = active_option
            .as_ref()
            .map(|option| option.source.label().to_string())
            .unwrap_or_else(|| "implicit".to_string());
        let active_identity = active_option
            .and_then(|option| {
                option
                    .profile_id
                    .or(option.account_label)
                    .or(option.authority)
            })
            .unwrap_or_else(|| "env-or-default".to_string());
        parts.push(format!(
            "auth:{provider}:{active_method}:{active_source}:{active_identity}"
        ));
    }
    if let Some(models) = &settings.models {
        for model in models {
            parts.push(format!(
                "model:{}:{}:{}:{}:{}",
                model.provider,
                model.id,
                model.reasoning.unwrap_or(false),
                model.api.as_deref().unwrap_or_default(),
                model.base_url.as_deref().unwrap_or_default()
            ));
        }
    }
    if let Some(providers) = &settings.providers {
        for provider in providers {
            let env_present = provider.api_key_env.as_deref().is_some_and(|env_key| {
                std::env::var(env_key)
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            });
            parts.push(format!(
                "provider:{}:{}:{}:{}",
                provider.name,
                provider.base_url.as_deref().unwrap_or_default(),
                provider.api.as_deref().unwrap_or_default(),
                env_present
            ));
        }
    }
    parts.join("|")
}

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
                kind: desktop_slash_command_kind(item.value.as_str(), &self.setup).to_string(),
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

    async fn reload_runtime_setup(&mut self) -> Result<()> {
        let cwd = self.setup.tool_ctx.cwd.clone();
        let session_id = self.setup.session_id.clone();
        let entry = SessionBootstrapOptions {
            session: Some(session_id),
            ..SessionBootstrapOptions::default()
        };
        let (_runtime_host, _ui, mut setup) = prepare_session_runtime_for_cwd(cwd, entry).await?;
        normalize_setup_thinking(&mut setup);
        self.setup = setup;
        Ok(())
    }

    pub async fn run_local_command(&mut self, text: &str) -> Result<Option<String>> {
        let text = text.trim();
        let command = text.split_whitespace().next().unwrap_or(text);
        match command {
            "/reload" => {
                if text != "/reload" {
                    return Ok(Some("Usage: /reload".to_string()));
                }
                self.reload_runtime_setup().await?;
                Ok(Some(
                    "Reloaded desktop runtime resources and slash commands.".to_string(),
                ))
            }
            "/install" => self.run_install_command(text).await,
            "/skill" => self.run_skill_command(text).await,
            "/compact" => self.run_compact_command(text).await,
            "/export" => self.run_export_command(text),
            "/import" => self.run_import_command(text),
            "/fork" => Ok(Some(
                "Desktop /fork is reserved for the upcoming message fork flow (#172).".to_string(),
            )),
            "/tree" => Ok(Some(
                "Desktop /tree is reserved for the upcoming session branch browser (#173)."
                    .to_string(),
            )),
            _ if is_desktop_dynamic_agent_slash_command(command, &self.setup.session_resources) => {
                Ok(None)
            }
            _ if self.setup.extension_commands.is_registered(text) => {
                let note = self
                    .setup
                    .extension_commands
                    .execute_text(text)
                    .await?
                    .unwrap_or_else(|| "Extension command completed.".to_string());
                Ok(Some(note))
            }
            _ if self
                .setup
                .slash_command_items
                .iter()
                .any(|item| item.value == command) =>
            {
                Ok(Some(format!(
                    "{command} is visible in the desktop command menu, but interactive execution is not wired yet."
                )))
            }
            _ => Ok(None),
        }
    }

    async fn run_install_command(&mut self, text: &str) -> Result<Option<String>> {
        match crate::slash::parse_install_command(text) {
            Some(crate::slash::InstallSlashAction::Help) => {
                Ok(Some(crate::slash::install_help_text()))
            }
            Some(crate::slash::InstallSlashAction::Install(install)) => {
                let cwd = self.setup.tool_ctx.cwd.clone();
                let scope = if install.local {
                    crate::extensions::SettingsScope::Project
                } else {
                    crate::extensions::SettingsScope::Global
                };
                let source = install.source.clone();
                tokio::task::spawn_blocking(move || {
                    crate::extensions::install_package(&source, scope, &cwd)
                })
                .await
                .map_err(|err| anyhow!("install task failed: {err}"))??;
                self.reload_runtime_setup().await?;
                Ok(Some(format!(
                    "Installed {} and reloaded resources.",
                    install.source
                )))
            }
            None => Ok(None),
        }
    }

    async fn run_compact_command(&mut self, text: &str) -> Result<Option<String>> {
        let instructions = text
            .strip_prefix("/compact")
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let settings = kordi_core::types::CompactionSettings {
            enabled: self.setup.compaction_enabled,
            reserve_tokens: self.setup.compaction_reserve_tokens,
            keep_recent_tokens: self.setup.compaction_keep_recent_tokens,
        };
        let entries = kordi_session::store::get_entries(&self.setup.conn, &self.setup.session_id)?;
        let parent_id = crate::turn_runner::get_leaf_raw(&self.setup.conn, &self.setup.session_id);
        let db_path = self
            .setup
            .conn
            .path()
            .map(std::path::PathBuf::from)
            .ok_or_else(|| anyhow!("Compaction requires a file-backed session database"))?;
        let (auth_mode, auth_account_id) =
            crate::compaction_exec::compaction_auth_options(self.setup.auth.as_ref());
        let result = crate::compaction_exec::execute_session_compaction(
            entries,
            parent_id,
            db_path,
            &self.setup.session_id,
            self.setup.provider.clone(),
            &self.setup.model.id,
            &self.setup.api_key,
            auth_mode,
            auth_account_id,
            &self.setup.base_url,
            &self.setup.headers,
            &settings,
            instructions,
            tokio_util::sync::CancellationToken::new(),
        )
        .await;

        match result {
            Ok(result) => Ok(Some(format!(
                "Compaction complete • {} messages summarized • {} kept • {} tokens before",
                result.summarized_count, result.kept_count, result.tokens_before
            ))),
            Err(err) if err.to_string() == "Nothing to compact" => {
                let entries =
                    kordi_session::store::get_entries(&self.setup.conn, &self.setup.session_id)?;
                let total_tokens: u64 = entries
                    .iter()
                    .map(kordi_session::compaction::estimate_tokens_row)
                    .sum();
                Ok(Some(format!(
                    "Nothing to compact ({total_tokens} estimated tokens, {} entries)",
                    entries.len()
                )))
            }
            Err(err) => Err(err),
        }
    }

    fn run_export_command(&mut self, text: &str) -> Result<Option<String>> {
        let path = text
            .strip_prefix("/export")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("session-export.jsonl");
        let rows = kordi_session::store::get_entries(&self.setup.conn, &self.setup.session_id)?;
        let mut lines = Vec::new();
        for row in &rows {
            if let Ok(entry) = kordi_session::store::parse_entry(row)
                && let Ok(json) = serde_json::to_string(&entry)
            {
                lines.push(json);
            }
        }
        std::fs::write(path, format!("{}\n", lines.join("\n")))?;
        let abs_path =
            std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
        Ok(Some(format!("Exported session to: {}", abs_path.display())))
    }

    fn run_import_command(&mut self, text: &str) -> Result<Option<String>> {
        let Some(path) = text
            .strip_prefix("/import")
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(Some("Usage: /import <path.jsonl>".to_string()));
        };
        Ok(Some(format!(
            "Import from {path} is not supported in the desktop app yet."
        )))
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
        let prompt_text = expand_desktop_dynamic_slash_prompt(
            expanded.text.trim(),
            &self.setup.session_resources,
        )
        .trim()
        .to_string();
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
            &prompt_text,
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

fn parse_db_timestamp_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .and_then(|dt| Local.from_local_datetime(&dt).single())
                .map(|dt| dt.timestamp_millis())
        })
}

fn session_last_message_timestamp(conn: &rusqlite::Connection, session_id: &str) -> Option<String> {
    kordi_session::store::get_last_message_timestamp(conn, session_id)
        .ok()
        .flatten()
}

fn session_last_activity_timestamp(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> String {
    session_last_message_timestamp(conn, &row.session_id)
        .or_else(|| {
            kordi_session::store::get_last_entry_timestamp(conn, &row.session_id)
                .ok()
                .flatten()
        })
        .unwrap_or_else(|| row.created_at.clone())
}

fn session_sort_timestamp_ms(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> i64 {
    parse_db_timestamp_millis(&session_last_activity_timestamp(conn, row)).unwrap_or_default()
}

fn session_activity_label(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> String {
    format_db_timestamp(&session_last_activity_timestamp(conn, row))
}

fn is_placeholder_session_name(row: &kordi_session::store::SessionRow) -> bool {
    row.name.as_deref().is_some_and(|value| {
        let trimmed = value.trim();
        trimmed.eq_ignore_ascii_case("New session")
            || trimmed
                .eq_ignore_ascii_case(&format!("Session {}", short_session_id(&row.session_id)))
    })
}

fn session_row_display_name(row: &kordi_session::store::SessionRow) -> Option<String> {
    if is_placeholder_session_name(row) {
        return None;
    }
    row.name.clone().filter(|value| !value.trim().is_empty())
}

fn session_title_from_seed(value: &str) -> Option<String> {
    let title = value
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then(|| truncate_chars(&title, 60))
}

fn session_title_from_messages(messages: &[DesktopChatMessage]) -> Option<String> {
    messages
        .iter()
        .find(|message| message.role == "user")
        .and_then(|message| {
            session_title_from_seed(&message.text).or_else(|| {
                attachment_summary_from_metadata(&message.attachments)
                    .and_then(|value| session_title_from_seed(&value))
            })
        })
}

fn repair_session_title_from_history(
    conn: &rusqlite::Connection,
    row: &kordi_session::store::SessionRow,
) -> Result<Option<String>> {
    if let Some(title) = session_row_display_name(row) {
        return Ok(Some(title));
    }
    if row.entry_count <= 0 {
        return Ok(None);
    }
    let Some(title) = session_title_from_messages(&load_session_messages(conn, &row.session_id)?)
    else {
        return Ok(None);
    };
    kordi_session::store::set_session_name(conn, &row.session_id, Some(&title))?;
    Ok(Some(title))
}

fn session_summary_from_row(
    conn: &rusqlite::Connection,
    row: kordi_session::store::SessionRow,
) -> Result<DesktopChatSessionSummary> {
    let updated_at_label = session_activity_label(conn, &row);
    let title =
        repair_session_title_from_history(conn, &row)?.unwrap_or_else(|| "New session".to_string());
    let subtitle = match kordi_session::context::build_context(conn, &row.session_id) {
        Ok(context) => context
            .model
            .map(|model| format!("{}/{}", model.provider, model.model_id))
            .unwrap_or_else(|| format!("{} entries", row.entry_count)),
        Err(_) => format!("{} entries", row.entry_count),
    };

    Ok(DesktopChatSessionSummary {
        id: row.session_id,
        title,
        subtitle,
        updated_at_label,
        message_count: row.entry_count.max(0) as usize,
        draft: false,
    })
}

fn open_sessions_db() -> Result<rusqlite::Connection> {
    let global_settings = Settings::load_global();
    kordi_session::store::open_db(&kordi_core::config::session_db_path(
        &global_settings.storage,
    ))
}

fn runtime_cwd_for_session(
    fallback_cwd: std::path::PathBuf,
    session_id: &str,
) -> Result<std::path::PathBuf> {
    let conn = open_sessions_db()?;
    let Some(row) = kordi_session::store::get_session(&conn, session_id)? else {
        return Ok(fallback_cwd);
    };

    if row.session_scope == "project" {
        if let Some(project_root) = row
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(std::path::PathBuf::from(project_root));
        }
    }

    let row_cwd = row.cwd.trim();
    if row_cwd.is_empty() {
        Ok(fallback_cwd)
    } else {
        Ok(std::path::PathBuf::from(row_cwd))
    }
}

pub fn list_session_summaries(cwd: &std::path::Path) -> Result<Vec<DesktopChatSessionSummary>> {
    let conn = open_sessions_db()?;
    let cwd_str = cwd.display().to_string();
    let mut rows = kordi_session::store::list_sessions(&conn, &cwd_str)?;
    rows.sort_by(|left, right| {
        session_sort_timestamp_ms(&conn, right)
            .cmp(&session_sort_timestamp_ms(&conn, left))
            .then_with(|| right.created_at.cmp(&left.created_at))
    });

    rows.into_iter()
        .map(|row| session_summary_from_row(&conn, row))
        .collect()
}

fn project_group_id(project_root: &std::path::Path) -> String {
    format!("project:{}", project_root.display())
}

fn exact_project_settings(project_root: &std::path::Path) -> Settings {
    let preferred = project_root.join(".kordi").join("settings.json");
    let legacy = project_root.join(".bb-agent").join("settings.json");
    let path = if preferred.exists() {
        preferred
    } else if legacy.exists() {
        legacy
    } else {
        preferred
    };
    Settings::load_from_file(&path)
}

fn project_group_from_root(
    project_root: &std::path::Path,
    registered_name: Option<&str>,
) -> DesktopChatProjectGroup {
    let settings = exact_project_settings(project_root);
    let project_name = settings
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            registered_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(ToString::to_string)
        .or_else(|| {
            project_root
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Project".to_string());
    let summary = settings
        .project_context
        .clone()
        .or_else(|| settings.project_system_prompt.clone())
        .unwrap_or_else(|| project_root.display().to_string());
    let background_system = settings.project_system_prompt.clone();
    let shared_sources = settings
        .project_shared_sources
        .iter()
        .map(|source| DesktopChatProjectSource {
            label: source.label.clone(),
            path: source.path.clone(),
            detail: source.detail.clone(),
        })
        .collect::<Vec<_>>();

    DesktopChatProjectGroup {
        id: project_group_id(project_root),
        name: project_name,
        root: project_root.display().to_string(),
        summary,
        background_system,
        shared_sources,
        sessions: Vec::new(),
    }
}

pub fn register_project(
    project_root: &std::path::Path,
    name: Option<&str>,
) -> Result<DesktopChatProjectGroup> {
    let conn = open_sessions_db()?;
    let group_id = project_group_id(project_root);
    kordi_session::store::upsert_project(
        &conn,
        &group_id,
        &project_root.display().to_string(),
        name,
    )?;
    Ok(project_group_from_root(project_root, name))
}

pub fn list_project_groups(_cwd: &std::path::Path) -> Result<Vec<DesktopChatProjectGroup>> {
    let conn = open_sessions_db()?;
    let rows = kordi_session::store::list_all_sessions(&conn)?;
    let registered_projects = kordi_session::store::list_projects(&conn)?;
    let mut groups: std::collections::BTreeMap<String, DesktopChatProjectGroup> =
        std::collections::BTreeMap::new();
    let mut group_sort_keys = std::collections::HashMap::<String, i64>::new();
    let mut session_sort_keys = std::collections::HashMap::<String, i64>::new();

    for project in registered_projects {
        let project_root = std::path::PathBuf::from(project.root.trim());
        let group_id = project_group_id(&project_root);
        groups
            .entry(group_id.clone())
            .or_insert_with(|| project_group_from_root(&project_root, project.name.as_deref()));
        group_sort_keys
            .entry(group_id)
            .or_insert_with(|| parse_db_timestamp_millis(&project.updated_at).unwrap_or_default());
    }

    for row in rows {
        if row.session_scope != "project" {
            continue;
        }
        let Some(project_root_value) = row
            .project_root
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        let sort_ts = session_sort_timestamp_ms(&conn, &row);
        let session_id = row.session_id.clone();
        let project_root = std::path::PathBuf::from(project_root_value);
        let group_id = project_group_id(&project_root);
        let summary_row = session_summary_from_row(&conn, row)?;

        let entry = groups
            .entry(group_id.clone())
            .or_insert_with(|| project_group_from_root(&project_root, None));
        entry.sessions.push(summary_row);
        session_sort_keys.insert(session_id, sort_ts);
        group_sort_keys
            .entry(group_id)
            .and_modify(|current| *current = (*current).max(sort_ts))
            .or_insert(sort_ts);
    }

    for group in groups.values_mut() {
        group.sessions.sort_by(|left, right| {
            let left_time = session_sort_keys.get(&left.id).copied().unwrap_or_default();
            let right_time = session_sort_keys
                .get(&right.id)
                .copied()
                .unwrap_or_default();
            right_time
                .cmp(&left_time)
                .then_with(|| right.updated_at_label.cmp(&left.updated_at_label))
        });
    }

    let mut result = groups.into_values().collect::<Vec<_>>();
    result.sort_by(|left, right| {
        let left_time = group_sort_keys.get(&left.id).copied().unwrap_or_default();
        let right_time = group_sort_keys.get(&right.id).copied().unwrap_or_default();
        right_time
            .cmp(&left_time)
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(result)
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

const OFF_ONLY_THINKING_LEVELS: [ThinkingLevel; 1] = [ThinkingLevel::Off];
const DEFAULT_ONLY_THINKING_LEVELS: [ThinkingLevel; 1] = [ThinkingLevel::Default];
const LOCAL_EFFORT_THINKING_LEVELS: [ThinkingLevel; 3] = [
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];
const STANDARD_THINKING_LEVELS: [ThinkingLevel; 5] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
];
const XHIGH_THINKING_LEVELS: [ThinkingLevel; 6] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::XHigh,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ThinkingControlMode {
    OffOnly,
    DefaultOnly,
    LocalEffort,
    Standard,
    XHigh,
}

fn normalized_model_capability_id(model: &Model) -> String {
    [
        model.provider.as_str(),
        model.id.as_str(),
        model.name.as_str(),
    ]
    .join("/")
    .to_ascii_lowercase()
    .replace([' ', '_'], "-")
}

fn normalized_local_provider_id(provider: &str) -> String {
    login::normalize_provider_for_model_selection(provider)
}

fn is_ollama_model(model: &Model) -> bool {
    normalized_local_provider_id(&model.provider) == "ollama"
}

fn local_model_matches_any(model: &Model, needles: &[&str]) -> bool {
    let id = normalized_model_capability_id(model);
    needles.iter().any(|needle| id.contains(needle))
}

// Ollama documents GPT-OSS as the local family with tunable `think` levels
// (`low`/`medium`/`high`) and no fully disabled mode. Other known local
// thinking families only expose a provider/model default in Kordi so we avoid
// presenting unsupported effort controls.
fn local_model_supports_effort_levels(model: &Model) -> bool {
    if !is_ollama_model(model) {
        return false;
    }
    local_model_matches_any(model, &["gpt-oss", "gptoss"])
}

fn local_model_supports_default_thinking(model: &Model) -> bool {
    local_model_matches_any(
        model,
        &[
            "thinking",
            "reasoning",
            "reasoner",
            "qwen3",
            "qwen-3",
            "qwq",
            "deepseek-r1",
            "deepseek-v3.1",
            "deepseek-v3-1",
            "deepseek-v31",
            "gemma-3n",
            "gemma3n",
            "gemma-4",
            "gemma4",
            "magistral",
            "phi-4-reasoning",
            "phi4-reasoning",
            "seed-oss",
            "seedoss",
            "glm-z1",
            "glmz1",
        ],
    ) || (!is_ollama_model(model) && local_model_matches_any(model, &["gpt-oss", "gptoss"]))
        || model.reasoning
}

fn local_thinking_control_mode(model: &Model) -> Option<ThinkingControlMode> {
    if !login::is_local_openai_provider(&model.provider) {
        return None;
    }

    if local_model_supports_effort_levels(model) {
        Some(ThinkingControlMode::LocalEffort)
    } else if local_model_supports_default_thinking(model) {
        Some(ThinkingControlMode::DefaultOnly)
    } else {
        Some(ThinkingControlMode::OffOnly)
    }
}

fn supports_xhigh(model: &Model) -> bool {
    if !model.reasoning || login::is_local_openai_provider(&model.provider) {
        return false;
    }

    let id = normalized_model_capability_id(model);
    [
        "gpt-5.2", "gpt-5-2", "gpt-5.3", "gpt-5-3", "gpt-5.4", "gpt-5-4", "gpt-5.5", "gpt-5-5",
    ]
    .iter()
    .any(|needle| id.contains(needle))
        || ((id.contains("claude-opus-4-6") || id.contains("claude-opus-4.6"))
            || (id.contains("claude-opus-4-7") || id.contains("claude-opus-4.7")))
        || (id.contains("deepseek")
            && (id.contains("v4-pro") || id.contains("v4pro") || id.contains("v4/pro")))
}

fn thinking_control_mode_for_model(model: &Model) -> ThinkingControlMode {
    if let Some(mode) = local_thinking_control_mode(model) {
        return mode;
    }

    if !model.reasoning {
        ThinkingControlMode::OffOnly
    } else if supports_xhigh(model) {
        ThinkingControlMode::XHigh
    } else {
        ThinkingControlMode::Standard
    }
}

fn available_thinking_levels_for_model(model: &Model) -> &'static [ThinkingLevel] {
    match thinking_control_mode_for_model(model) {
        ThinkingControlMode::OffOnly => &OFF_ONLY_THINKING_LEVELS,
        ThinkingControlMode::DefaultOnly => &DEFAULT_ONLY_THINKING_LEVELS,
        ThinkingControlMode::LocalEffort => &LOCAL_EFFORT_THINKING_LEVELS,
        ThinkingControlMode::Standard => &STANDARD_THINKING_LEVELS,
        ThinkingControlMode::XHigh => &XHIGH_THINKING_LEVELS,
    }
}

pub fn desktop_thinking_levels_for_model(model: &Model) -> Vec<String> {
    available_thinking_levels_for_model(model)
        .iter()
        .map(|level| level.as_str().to_string())
        .collect()
}

pub fn desktop_thinking_levels_for_model_id(
    settings: &Settings,
    provider: &str,
    model_id: &str,
) -> Vec<String> {
    let mut registry = ModelRegistry::new();
    registry.load_custom_models(settings);
    login::add_cached_github_copilot_models(&mut registry);
    let model = crate::runtime_model::resolve_or_synthesize_model_with_settings(
        &registry, settings, provider, model_id,
    );
    desktop_thinking_levels_for_model(&model)
}

fn fallback_thinking_for_levels(levels: &[ThinkingLevel]) -> ThinkingLevel {
    if levels.contains(&ThinkingLevel::Off) {
        ThinkingLevel::Off
    } else if levels.contains(&ThinkingLevel::Default) {
        ThinkingLevel::Default
    } else if levels.contains(&ThinkingLevel::Medium) {
        ThinkingLevel::Medium
    } else {
        levels.first().copied().unwrap_or(ThinkingLevel::Off)
    }
}

fn effective_thinking_for_model(requested: ThinkingLevel, model: &Model) -> ThinkingLevel {
    let levels = available_thinking_levels_for_model(model);
    if levels.contains(&requested) {
        requested
    } else if requested == ThinkingLevel::XHigh && levels.contains(&ThinkingLevel::High) {
        ThinkingLevel::High
    } else {
        fallback_thinking_for_levels(levels)
    }
}

fn normalize_setup_thinking(setup: &mut SessionRuntimeSetup) {
    let requested = ThinkingLevel::parse(&setup.thinking_level).unwrap_or(ThinkingLevel::Off);
    setup.thinking_level = effective_thinking_for_model(requested, &setup.model)
        .as_str()
        .to_string();
}

fn desktop_slash_command_kind(value: &str, setup: &SessionRuntimeSetup) -> &'static str {
    let token = value.trim().split_whitespace().next().unwrap_or(value);
    if token.starts_with("/skill:") {
        return "skill";
    }
    if setup
        .session_resources
        .prompts
        .iter()
        .any(|prompt| format!("/{}", prompt.info.slash_command_name()) == token)
    {
        return "prompt";
    }
    if setup.extension_commands.is_registered(token) {
        return "extension";
    }
    "builtin"
}

fn is_desktop_dynamic_agent_slash_command(
    command: &str,
    resources: &kordi_core::agent_session_extensions::SessionResourceBootstrap,
) -> bool {
    parse_desktop_skill_command(command).is_some()
        || parse_desktop_prompt_template(command, resources).is_some()
}

fn expand_desktop_dynamic_slash_prompt(
    text: &str,
    resources: &kordi_core::agent_session_extensions::SessionResourceBootstrap,
) -> String {
    if let Some((skill_name, user_args)) = parse_desktop_skill_command(text)
        && let Some(skill) = resources
            .skills
            .iter()
            .find(|skill| skill.info.name == skill_name)
    {
        return format_desktop_resource_content(&skill.content, user_args);
    }

    if let Some((prompt, user_args)) = parse_desktop_prompt_template(text, resources) {
        return format_desktop_resource_content(&prompt.content, user_args);
    }

    text.to_string()
}

fn parse_desktop_skill_command(text: &str) -> Option<(&str, Option<&str>)> {
    let trimmed = text.trim();
    let remainder = trimmed.strip_prefix("/skill:")?;
    split_desktop_slash_command_name_and_args(remainder)
}

fn parse_desktop_prompt_template<'a, 'b>(
    text: &'b str,
    resources: &'a kordi_core::agent_session_extensions::SessionResourceBootstrap,
) -> Option<(
    &'a kordi_core::agent_session_extensions::PromptTemplateDefinition,
    Option<&'b str>,
)> {
    let (name, args) = parse_desktop_slash_command(text)?;
    resources
        .prompts
        .iter()
        .find(|prompt| prompt.info.slash_command_name() == name)
        .map(|prompt| (prompt, args))
}

fn parse_desktop_slash_command(text: &str) -> Option<(&str, Option<&str>)> {
    let trimmed = text.trim();
    let remainder = trimmed.strip_prefix('/')?;
    split_desktop_slash_command_name_and_args(remainder)
}

fn split_desktop_slash_command_name_and_args(input: &str) -> Option<(&str, Option<&str>)> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    match trimmed.find(char::is_whitespace) {
        Some(index) => {
            let name = trimmed[..index].trim();
            if name.is_empty() {
                return None;
            }
            let args = trimmed[index..].trim();
            Some((name, (!args.is_empty()).then_some(args)))
        }
        None => Some((trimmed, None)),
    }
}

fn format_desktop_resource_content(content: &str, user_args: Option<&str>) -> String {
    match user_args {
        Some(args) => format!("{}\n\nUser: {}", content.trim_end(), args),
        None => content.to_string(),
    }
}

fn request_thinking_for_model(thinking_level: &str, model: &Model) -> Option<String> {
    let requested = ThinkingLevel::parse(thinking_level).unwrap_or(ThinkingLevel::Off);
    let effective = effective_thinking_for_model(requested, model);
    match effective {
        ThinkingLevel::Off | ThinkingLevel::Default => None,
        other => other
            .reasoning_enabled()
            .then(|| other.as_str().to_string()),
    }
}

fn desktop_model_option_from_model(model: &Model) -> DesktopChatModelOption {
    DesktopChatModelOption {
        provider: model.provider.clone(),
        provider_label: login::provider_display_name(&model.provider).into_owned(),
        value: format!("{}/{}", model.provider, model.id),
        label: model.id.clone(),
        detail: format!(
            "{} • {}",
            login::provider_display_name(&model.provider),
            model.name
        ),
        thinking_levels: desktop_thinking_levels_for_model(model),
    }
}

pub async fn authenticated_model_options(cwd: &std::path::Path) -> Vec<DesktopChatModelOption> {
    let settings = Settings::load_merged(cwd);
    let cache_key = desktop_model_options_cache_key(cwd, &settings);
    if let Some(cached_options) = desktop_model_options_cache().lock().ok().and_then(|cache| {
        cache
            .get(&cache_key)
            .filter(|(cached_at, _)| cached_at.elapsed() <= DESKTOP_MODEL_OPTIONS_CACHE_TTL)
            .map(|(_, options)| options.clone())
    }) {
        return cached_options;
    }

    let mut models = crate::live_models::authenticated_model_candidates_with_live(&settings).await;
    if let (Some(default_provider), Some(default_model)) = (
        settings.default_provider.as_deref(),
        settings.default_model.as_deref(),
    ) {
        let provider = login::normalize_provider_for_model_selection(default_provider);
        let model_id = default_model
            .trim()
            .strip_prefix(&format!("{provider}/"))
            .unwrap_or_else(|| default_model.trim());
        if !model_id.is_empty()
            && !models
                .iter()
                .any(|model| model.provider == provider && model.id == model_id)
        {
            let mut registry = ModelRegistry::new();
            registry.load_custom_models(&settings);
            login::add_cached_github_copilot_models(&mut registry);
            if let Some(model) =
                synthesize_live_model_candidate(&registry, &settings, &provider, model_id)
            {
                models.push(model);
            }
        }
    }
    models.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then_with(|| left.id.cmp(&right.id))
    });

    let options = models
        .iter()
        .map(desktop_model_option_from_model)
        .collect::<Vec<_>>();

    if !options.is_empty()
        && let Ok(mut cache) = desktop_model_options_cache().lock()
    {
        cache.insert(cache_key, (Instant::now(), options.clone()));
    }

    options
}

fn synthesize_live_model_candidate(
    registry: &ModelRegistry,
    settings: &Settings,
    provider: &str,
    model_id: &str,
) -> Option<Model> {
    if !login::provider_configured_for_settings(settings, provider) {
        return None;
    }

    Some(
        crate::runtime_model::synthesize_model_candidate_with_settings(
            registry, settings, provider, model_id,
        ),
    )
}

fn resolve_model_candidate(
    settings: &Settings,
    requested_model: &str,
    current_provider: Option<&str>,
) -> Result<Model> {
    let requested = requested_model.trim();
    if requested.is_empty() {
        bail!("Model cannot be empty");
    }

    let mut registry = ModelRegistry::new();
    registry.load_custom_models(settings);
    login::add_cached_github_copilot_models(&mut registry);

    let requested_prefix_is_configured_provider = requested
        .split_once('/')
        .map(|(provider, _)| login::normalize_provider_for_model_selection(provider))
        .is_some_and(|provider| login::provider_configured_for_settings(settings, &provider));

    if requested.contains('/')
        && let Some(provider) = current_provider
    {
        let normalized_provider = login::normalize_provider_for_model_selection(provider);
        if login::is_local_openai_provider(&normalized_provider)
            && !requested_prefix_is_configured_provider
            && !requested.starts_with(&format!("{normalized_provider}/"))
            && let Some(model) = synthesize_live_model_candidate(
                &registry,
                settings,
                &normalized_provider,
                requested,
            )
        {
            return Ok(model);
        }
    }

    if let Some((provider, model_id)) = requested.split_once('/') {
        return registry
            .find(provider, model_id)
            .cloned()
            .filter(|_| login::provider_configured_for_settings(settings, provider))
            .or_else(|| {
                login::provider_configured_for_settings(settings, provider)
                    .then(|| registry.find_fuzzy(model_id, Some(provider)).cloned())
                    .flatten()
            })
            .or_else(|| synthesize_live_model_candidate(&registry, settings, provider, model_id))
            .ok_or_else(|| anyhow!("Unknown model: {requested}"));
    }

    let candidates = login::authenticated_model_candidates(settings);
    if let Some(provider) = current_provider {
        if let Some(model) = candidates.iter().find(|model| {
            model.provider == provider
                && (model.id.eq_ignore_ascii_case(requested)
                    || model.name.eq_ignore_ascii_case(requested))
        }) {
            return Ok(model.clone());
        }
        if let Some(model) =
            synthesize_live_model_candidate(&registry, settings, provider, requested)
        {
            return Ok(model);
        }
    }

    candidates
        .iter()
        .find(|model| {
            model.id.eq_ignore_ascii_case(requested) || model.name.eq_ignore_ascii_case(requested)
        })
        .cloned()
        .ok_or_else(|| anyhow!("Unknown model: {requested}"))
}

fn resolve_auth_choice_override_for_model(
    model_provider: &str,
    choice: &SessionAuthChoiceOverride,
) -> Option<crate::login::ResolvedProviderAuth> {
    let model_provider = login::normalize_provider_for_model_selection(model_provider);
    let auth_provider = login::normalize_provider_for_model_selection(&choice.provider);
    (model_provider == auth_provider)
        .then(|| login::resolve_provider_auth_choice(&choice.provider, &choice.choice))
        .flatten()
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

fn load_project_info(project_root: &std::path::Path) -> Option<DesktopChatProjectInfo> {
    let settings = exact_project_settings(project_root);
    let name = settings
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            project_root
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "Project".to_string());

    let shared_context = settings
        .project_context
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let background_system = settings
        .project_system_prompt
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let shared_sources = settings
        .project_shared_sources
        .into_iter()
        .map(|source| DesktopChatProjectSource {
            label: source.label,
            path: source.path,
            detail: source.detail,
        })
        .collect::<Vec<_>>();

    Some(DesktopChatProjectInfo {
        name,
        root: project_root.display().to_string(),
        shared_context,
        background_system,
        shared_sources,
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

#[derive(Default)]
struct HistoricalTurnBuilder {
    assistant_text_parts: Vec<String>,
    thinking_parts: Vec<String>,
    tools: Vec<DesktopChatStoredTool>,
    tool_index_by_id: HashMap<String, usize>,
    detail: Option<String>,
    error_message: Option<String>,
    failed: bool,
    timestamp_ms: i64,
}

impl HistoricalTurnBuilder {
    fn is_empty(&self) -> bool {
        self.assistant_text_parts.is_empty()
            && self.thinking_parts.is_empty()
            && self.tools.is_empty()
            && self.error_message.is_none()
    }

    fn touch_timestamp(&mut self, timestamp_ms: i64) {
        self.timestamp_ms = self.timestamp_ms.max(timestamp_ms);
    }
}

fn flush_historical_turn(
    out: &mut Vec<DesktopChatMessage>,
    current_turn: &mut Option<HistoricalTurnBuilder>,
) {
    let Some(turn) = current_turn.take() else {
        return;
    };
    if turn.is_empty() {
        return;
    }

    let assistant_text = turn.assistant_text_parts.join("\n\n");
    let thinking_text = turn.thinking_parts.join("\n\n");
    let visible_text = if assistant_text.trim().is_empty() && turn.failed {
        turn.error_message.clone().unwrap_or_default()
    } else {
        assistant_text
    };
    out.push(DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("Kordi".to_string()),
        text: visible_text,
        detail: turn.detail,
        time_label: format_message_timestamp(turn.timestamp_ms),
        timestamp_ms: turn.timestamp_ms,
        failed: turn.failed,
        attachments: Vec::new(),
        thinking_text: (!thinking_text.trim().is_empty()).then_some(thinking_text),
        tools: turn.tools,
    });
}

fn tool_detail_label(details: &Option<serde_json::Value>) -> Option<String> {
    let details = details.as_ref()?;
    let mut parts = Vec::new();
    if let Some(duration_ms) = details.get("durationMs").and_then(|value| value.as_u64()) {
        parts.push(format!("{}ms", duration_ms));
    }
    if let Some(exit_code) = details.get("exitCode").and_then(|value| value.as_i64()) {
        parts.push(format!("exit {exit_code}"));
    }
    if details
        .get("truncated")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        parts.push("truncated".to_string());
    }
    if details
        .get("cancelled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        parts.push("cancelled".to_string());
    }
    (!parts.is_empty()).then(|| parts.join(" • "))
}

fn attachment_is_image(path: &str) -> bool {
    matches!(
        std::path::Path::new(path)
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("gif") | Some("webp")
    )
}

fn attachment_format_label_from_path(path: &str) -> Option<String> {
    std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| !value.is_empty())
}

fn attachment_name_from_path(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(path)
        .to_string()
}

fn attachment_mime_type_from_path(path: &str) -> Option<String> {
    match std::path::Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png".to_string()),
        Some("jpg" | "jpeg") => Some("image/jpeg".to_string()),
        Some("gif") => Some("image/gif".to_string()),
        Some("webp") => Some("image/webp".to_string()),
        Some("bmp") => Some("image/bmp".to_string()),
        Some("svg") => Some("image/svg+xml".to_string()),
        Some("pdf") => Some("application/pdf".to_string()),
        Some("json") => Some("application/json".to_string()),
        Some("zip") => Some("application/zip".to_string()),
        Some("txt" | "md" | "log") => Some("text/plain".to_string()),
        _ => None,
    }
}

fn attachment_metadata_from_path(path: &str) -> DesktopChatAttachment {
    DesktopChatAttachment {
        kind: if attachment_is_image(path) {
            "image".to_string()
        } else {
            "file".to_string()
        },
        name: attachment_name_from_path(path),
        format_label: attachment_format_label_from_path(path),
        preview_url: None,
        mime_type: attachment_mime_type_from_path(path),
        local_path: Some(path.to_string()),
        size_bytes: std::fs::metadata(path).ok().map(|metadata| metadata.len()),
    }
}

fn attachment_summary_from_metadata(attachments: &[DesktopChatAttachment]) -> Option<String> {
    match attachments {
        [] => None,
        [attachment] => Some(format!("Attached {}", attachment.name)),
        _ => Some(format!("{} attachments", attachments.len())),
    }
}

async fn append_attachment_context_message(
    conn: &Arc<tokio::sync::Mutex<rusqlite::Connection>>,
    session_id: &str,
    attachment_context_text: &str,
    attachments: &[DesktopChatAttachment],
) -> Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }

    let conn = conn.lock().await;
    let content = if attachment_context_text.trim().is_empty() {
        Vec::new()
    } else {
        vec![ContentBlock::Text {
            text: attachment_context_text.to_string(),
        }]
    };
    let entry = SessionEntry::CustomMessage {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: turn_runner::get_leaf_raw(&conn, session_id),
            timestamp: Utc::now(),
        },
        custom_type: ATTACHMENT_CONTEXT_CUSTOM_TYPE.to_string(),
        content,
        display: false,
        details: Some(serde_json::json!({ "attachments": attachments })),
    };
    kordi_session::store::append_entry(&conn, session_id, &entry)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct AttachmentContextDetails {
    #[serde(default)]
    attachments: Vec<DesktopChatAttachment>,
}

fn attachments_from_details(details: &Option<serde_json::Value>) -> Vec<DesktopChatAttachment> {
    details
        .clone()
        .and_then(|value| serde_json::from_value::<AttachmentContextDetails>(value).ok())
        .map(|value| value.attachments)
        .unwrap_or_default()
}

fn image_attachments_from_blocks(blocks: &[ContentBlock]) -> Vec<DesktopChatAttachment> {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Image { data, mime_type } => Some(DesktopChatAttachment {
                kind: "image".to_string(),
                name: "Image attachment".to_string(),
                format_label: mime_type
                    .split('/')
                    .nth(1)
                    .map(|value| value.trim().to_ascii_uppercase())
                    .filter(|value| !value.is_empty()),
                preview_url: Some(format!("data:{mime_type};base64,{data}")),
                mime_type: Some(mime_type.to_string()),
                local_path: None,
                size_bytes: None,
            }),
            _ => None,
        })
        .collect()
}

fn merge_attachment_metadata(
    existing: Vec<DesktopChatAttachment>,
    metadata: Vec<DesktopChatAttachment>,
) -> Vec<DesktopChatAttachment> {
    if metadata.is_empty() {
        return existing;
    }

    let mut remaining_images = existing
        .into_iter()
        .filter(|attachment| attachment.kind == "image")
        .collect::<Vec<_>>()
        .into_iter();
    let mut merged = Vec::new();

    for attachment in metadata {
        if attachment.kind == "image" {
            if let Some(preview) = remaining_images.next() {
                merged.push(DesktopChatAttachment {
                    kind: "image".to_string(),
                    name: if attachment.name.trim().is_empty() {
                        preview.name
                    } else {
                        attachment.name
                    },
                    format_label: attachment.format_label.or(preview.format_label),
                    preview_url: preview.preview_url,
                    mime_type: attachment.mime_type.or(preview.mime_type),
                    local_path: attachment.local_path.or(preview.local_path),
                    size_bytes: attachment.size_bytes.or(preview.size_bytes),
                });
            } else {
                merged.push(attachment);
            }
        } else {
            merged.push(attachment);
        }
    }

    merged.extend(remaining_images);
    merged
}

fn load_session_messages(
    conn: &rusqlite::Connection,
    session_id: &str,
) -> Result<Vec<DesktopChatMessage>> {
    let path = kordi_session::tree::active_path(conn, session_id)?;
    let mut out = Vec::new();
    let mut current_turn: Option<HistoricalTurnBuilder> = None;

    for row in path {
        let entry = kordi_session::store::parse_entry(&row)?;
        match entry {
            SessionEntry::Message { message, .. } => match message {
                AgentMessage::User(user) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    out.push(DesktopChatMessage {
                        role: "user".to_string(),
                        sender: Some("You".to_string()),
                        text: user_visible_text_from_blocks(&user.content),
                        detail: None,
                        time_label: format_message_timestamp(user.timestamp),
                        timestamp_ms: user.timestamp,
                        failed: false,
                        attachments: image_attachments_from_blocks(&user.content),
                        thinking_text: None,
                        tools: Vec::new(),
                    });
                }
                AgentMessage::Assistant(message) => {
                    let turn = current_turn.get_or_insert_with(HistoricalTurnBuilder::default);
                    turn.touch_timestamp(message.timestamp);

                    let stop_reason_label = match &message.stop_reason {
                        kordi_core::types::StopReason::Stop => "completed",
                        kordi_core::types::StopReason::Length => "length limit",
                        kordi_core::types::StopReason::ToolUse => "tool use",
                        kordi_core::types::StopReason::Error => "error",
                        kordi_core::types::StopReason::Aborted => "aborted",
                    };
                    turn.detail = Some(format!(
                        "{}/{} • {}",
                        message.provider, message.model, stop_reason_label,
                    ));
                    if message.stop_reason == kordi_core::types::StopReason::Error {
                        turn.failed = true;
                        if let Some(error_message) = message.error_message.as_deref() {
                            turn.error_message = Some(error_message.to_string());
                        }
                    }

                    for item in message.content {
                        match item {
                            AssistantContent::Text { text } => {
                                if !text.trim().is_empty() {
                                    turn.assistant_text_parts.push(text);
                                }
                            }
                            AssistantContent::Thinking { thinking } => {
                                if !thinking.trim().is_empty() {
                                    turn.thinking_parts.push(thinking);
                                }
                            }
                            AssistantContent::ToolCall {
                                id,
                                name,
                                arguments,
                            } => {
                                let raw_args = arguments.to_string();
                                let next_index = turn.tools.len();
                                turn.tool_index_by_id.insert(id.clone(), next_index);
                                turn.tools.push(DesktopChatStoredTool {
                                    id,
                                    name,
                                    status: "done".to_string(),
                                    arguments: raw_args,
                                    live_output: String::new(),
                                    result_text: None,
                                    detail: None,
                                    is_error: false,
                                });
                            }
                        }
                    }
                }
                AgentMessage::ToolResult(message) => {
                    let turn = current_turn.get_or_insert_with(HistoricalTurnBuilder::default);
                    turn.touch_timestamp(message.timestamp);
                    let tool_index = if let Some(index) =
                        turn.tool_index_by_id.get(&message.tool_call_id).copied()
                    {
                        index
                    } else {
                        let index = turn.tools.len();
                        turn.tool_index_by_id
                            .insert(message.tool_call_id.clone(), index);
                        turn.tools.push(DesktopChatStoredTool {
                            id: message.tool_call_id.clone(),
                            name: message.tool_name.clone(),
                            status: if message.is_error {
                                "error".to_string()
                            } else {
                                "done".to_string()
                            },
                            arguments: String::new(),
                            live_output: String::new(),
                            result_text: None,
                            detail: None,
                            is_error: message.is_error,
                        });
                        index
                    };

                    if let Some(tool) = turn.tools.get_mut(tool_index) {
                        tool.status = if message.is_error {
                            "error".to_string()
                        } else {
                            "done".to_string()
                        };
                        tool.result_text = Some(text_from_blocks(&message.content));
                        tool.detail = tool_detail_label(&message.details);
                        tool.is_error = message.is_error;
                    }
                }
                AgentMessage::BashExecution(message) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    let detail = {
                        let mut parts = Vec::new();
                        if let Some(exit_code) = message.exit_code {
                            parts.push(format!("exit {exit_code}"));
                        }
                        if message.truncated {
                            parts.push("truncated".to_string());
                        }
                        if message.cancelled {
                            parts.push("cancelled".to_string());
                        }
                        (!parts.is_empty()).then(|| parts.join(" • "))
                    };
                    current_turn = Some(HistoricalTurnBuilder {
                        assistant_text_parts: Vec::new(),
                        thinking_parts: Vec::new(),
                        tools: vec![DesktopChatStoredTool {
                            id: format!("bash-exec-{}", message.timestamp),
                            name: "bash".to_string(),
                            status: if message.cancelled {
                                "error".to_string()
                            } else {
                                "done".to_string()
                            },
                            arguments: serde_json::json!({ "command": message.command })
                                .to_string(),
                            live_output: String::new(),
                            result_text: Some(if message.output.trim().is_empty() {
                                "(no output)".to_string()
                            } else {
                                message.output
                            }),
                            detail,
                            is_error: message.cancelled
                                || message.exit_code.unwrap_or_default() != 0,
                        }],
                        tool_index_by_id: HashMap::new(),
                        detail: Some("bash".to_string()),
                        error_message: None,
                        failed: false,
                        timestamp_ms: message.timestamp,
                    });
                    flush_historical_turn(&mut out, &mut current_turn);
                }
                AgentMessage::Custom(message) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    if message.display {
                        out.push(DesktopChatMessage {
                            role: "system".to_string(),
                            sender: None,
                            text: text_from_blocks(&message.content),
                            detail: Some(message.custom_type),
                            time_label: format_message_timestamp(message.timestamp),
                            timestamp_ms: message.timestamp,
                            failed: false,
                            attachments: Vec::new(),
                            thinking_text: None,
                            tools: Vec::new(),
                        });
                    }
                }
                AgentMessage::BranchSummary(message) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: message.summary,
                        detail: Some("Branch summary".to_string()),
                        time_label: format_message_timestamp(message.timestamp),
                        timestamp_ms: message.timestamp,
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                    });
                }
                AgentMessage::CompactionSummary(message) => {
                    flush_historical_turn(&mut out, &mut current_turn);
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: message.summary,
                        detail: Some(format!(
                            "Conversation compressed • {} tokens before",
                            message.tokens_before
                        )),
                        time_label: format_message_timestamp(message.timestamp),
                        timestamp_ms: message.timestamp,
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                    });
                }
            },
            SessionEntry::ModelChange {
                provider,
                model_id,
                base,
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: format!("Switched model to {provider}/{model_id}"),
                    detail: Some("Model updated".to_string()),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                })
            }
            SessionEntry::ThinkingLevelChange {
                thinking_level,
                base,
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: format!(
                        "Thinking set to {}",
                        thinking_label(thinking_level.as_str())
                    ),
                    detail: Some("Thinking updated".to_string()),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                })
            }
            SessionEntry::CustomMessage {
                custom_type,
                content,
                display,
                details,
                base,
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                if custom_type == ATTACHMENT_CONTEXT_CUSTOM_TYPE {
                    if let Some(last_user_message) =
                        out.iter_mut().rev().find(|message| message.role == "user")
                    {
                        last_user_message.attachments = merge_attachment_metadata(
                            std::mem::take(&mut last_user_message.attachments),
                            attachments_from_details(&details),
                        );
                    }
                    continue;
                }
                if display {
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: text_from_blocks(&content),
                        detail: Some(custom_type),
                        time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                        timestamp_ms: base.timestamp.timestamp_millis(),
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                    });
                }
            }
            SessionEntry::Compaction {
                summary,
                tokens_before,
                base,
                ..
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: summary,
                    detail: Some(format!(
                        "Conversation compressed • {} tokens before",
                        tokens_before
                    )),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                })
            }
            SessionEntry::BranchSummary { summary, base, .. } => {
                flush_historical_turn(&mut out, &mut current_turn);
                out.push(DesktopChatMessage {
                    role: "system".to_string(),
                    sender: None,
                    text: summary,
                    detail: Some("Branch summary".to_string()),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                })
            }
            SessionEntry::SessionInfo { name, base } => {
                flush_historical_turn(&mut out, &mut current_turn);
                if let Some(name) = name.filter(|value| !value.trim().is_empty()) {
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: format!("Renamed session to {name}"),
                        detail: Some("Session updated".to_string()),
                        time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                        timestamp_ms: base.timestamp.timestamp_millis(),
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                    });
                }
            }
            SessionEntry::Label { label, base, .. } => {
                flush_historical_turn(&mut out, &mut current_turn);
                if let Some(label) = label.filter(|value| !value.trim().is_empty()) {
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: format!("Added label: {label}"),
                        detail: Some("Label updated".to_string()),
                        time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                        timestamp_ms: base.timestamp.timestamp_millis(),
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                    });
                }
            }
            SessionEntry::Custom { .. } => {
                flush_historical_turn(&mut out, &mut current_turn);
            }
        }
    }

    flush_historical_turn(&mut out, &mut current_turn);
    Ok(out)
}

fn user_visible_text_from_blocks(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn text_from_blocks(blocks: &[ContentBlock]) -> String {
    let joined = user_visible_text_from_blocks(blocks);

    if joined.trim().is_empty() {
        "(non-text content)".to_string()
    } else {
        joined
    }
}

fn quote_attachment_path(path: &str) -> String {
    if path.contains(char::is_whitespace) || path.contains('"') || path.contains('\'') {
        format!("\"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        path.to_string()
    }
}

fn expand_prompt_with_attachment_paths(
    prompt: &str,
    attachment_paths: &[String],
    cwd: &std::path::Path,
) -> crate::input_files::ExpandedInputFiles {
    let attachment_refs = attachment_paths
        .iter()
        .map(|path| format!("@{}", quote_attachment_path(path)))
        .collect::<Vec<_>>();
    let combined = if attachment_refs.is_empty() {
        prompt.trim().to_string()
    } else if prompt.trim().is_empty() {
        attachment_refs.join("\n")
    } else {
        format!("{}\n\n{}", prompt.trim(), attachment_refs.join("\n"))
    };
    crate::input_files::expand_at_file_references(&combined, cwd)
}

fn load_images_from_paths(paths: &[std::path::PathBuf]) -> Result<Vec<ImageContent>> {
    use base64::Engine;

    let mut images = Vec::new();
    for path in paths {
        let data = std::fs::read(path)
            .map_err(|error| anyhow!("Could not read image {}: {error}", path.display()))?;
        let mime_type = match path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref()
        {
            Some("png") => Some("image/png"),
            Some("jpg" | "jpeg") => Some("image/jpeg"),
            Some("gif") => Some("image/gif"),
            Some("webp") => Some("image/webp"),
            _ => None,
        };
        let Some(mime_type) = mime_type else {
            continue;
        };
        images.push(ImageContent {
            source: base64::engine::general_purpose::STANDARD.encode(data),
            mime_type: Some(mime_type.to_string()),
        });
    }
    Ok(images)
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

fn format_db_timestamp(value: &str) -> String {
    let parsed = chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.with_timezone(&Local))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .ok()
                .and_then(|dt| Local.from_local_datetime(&dt).single())
        });

    match parsed {
        Some(datetime) => {
            let today = Local::now().date_naive();
            if datetime.date_naive() == today {
                datetime.format("%H:%M").to_string()
            } else {
                datetime.format("%b %-d").to_string()
            }
        }
        None => value.to_string(),
    }
}

fn short_session_id(value: &str) -> String {
    value.chars().take(8).collect()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let total = value.chars().count();
    if total <= max_chars {
        return value.to_string();
    }
    let truncated = value.chars().take(max_chars).collect::<String>();
    format!("{truncated}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_core::settings::ProviderOverride;
    use kordi_core::types::{AssistantMessage, StopReason, Usage, UserMessage};
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
    fn desktop_dynamic_slash_prompt_expands_skills_and_prompt_templates() {
        let resources = kordi_core::agent_session_extensions::SessionResourceBootstrap {
            skills: vec![kordi_core::agent_session_extensions::SkillDefinition {
                info: kordi_core::agent_session_extensions::SkillInfo {
                    name: "review".to_string(),
                    description: "Review changes".to_string(),
                    source_info: kordi_core::agent_session_extensions::SourceInfo::default(),
                },
                content: "Use the review skill.".to_string(),
            }],
            prompts: vec![
                kordi_core::agent_session_extensions::PromptTemplateDefinition {
                    info: kordi_core::agent_session_extensions::PromptTemplateInfo {
                        name: "summarize".to_string(),
                        description: "Summarize context".to_string(),
                        source_info: kordi_core::agent_session_extensions::SourceInfo::default(),
                    },
                    content: "Summarize this context.".to_string(),
                },
            ],
            ..Default::default()
        };

        assert_eq!(
            expand_desktop_dynamic_slash_prompt("/skill:review focus on tests", &resources),
            "Use the review skill.\n\nUser: focus on tests"
        );
        assert_eq!(
            expand_desktop_dynamic_slash_prompt("/summarize release notes", &resources),
            "Summarize this context.\n\nUser: release notes"
        );
        assert_eq!(
            expand_desktop_dynamic_slash_prompt("/unknown release notes", &resources),
            "/unknown release notes"
        );
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
    fn session_title_seed_matches_chat_title_rules() {
        assert_eq!(
            session_title_from_seed(
                "  plan the project session naming behavior with enough extra words  "
            )
            .as_deref(),
            Some("plan the project session naming behavior with enough")
        );
        assert_eq!(session_title_from_seed("   "), None);
    }

    #[test]
    fn placeholder_session_names_are_not_real_titles() {
        let row = kordi_session::store::SessionRow {
            session_id: "abcdef12-3456".to_string(),
            cwd: "/tmp/kordi".to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            name: Some("Session abcdef12".to_string()),
            leaf_id: None,
            entry_count: 0,
            parent_session_id: None,
            session_scope: "project".to_string(),
            project_root: Some("/tmp/project".to_string()),
        };
        assert_eq!(session_row_display_name(&row), None);

        let row = kordi_session::store::SessionRow {
            name: Some("New session".to_string()),
            ..row
        };
        assert_eq!(session_row_display_name(&row), None);
    }

    #[test]
    fn local_desktop_agent_label_is_not_inferred_from_project_name() {
        assert_eq!(
            infer_agent_label(std::path::Path::new("/tmp/any-project")),
            "Kordi"
        );
    }

    #[test]
    fn load_session_messages_preserves_failed_assistant_error() -> Result<()> {
        let conn = kordi_session::store::open_memory()?;
        let session_id = "desktop-error-session";
        kordi_session::store::create_session_with_id(&conn, session_id, "/tmp/kordi")?;

        let user_entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: None,
                timestamp: Utc::now(),
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: "hi".to_string(),
                }],
                timestamp: 1_000,
            }),
        };
        kordi_session::store::append_entry(&conn, session_id, &user_entry)?;

        let error_text = "Claude OAuth credentials are not usable.";
        let assistant_entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: crate::turn_runner::get_leaf_raw(&conn, session_id),
                timestamp: Utc::now(),
            },
            message: AgentMessage::Assistant(AssistantMessage {
                content: vec![AssistantContent::Text {
                    text: error_text.to_string(),
                }],
                provider: "anthropic".to_string(),
                model: "claude-opus-4-6".to_string(),
                usage: Usage::default(),
                stop_reason: StopReason::Error,
                error_message: Some(error_text.to_string()),
                timestamp: 2_000,
            }),
        };
        kordi_session::store::append_entry(&conn, session_id, &assistant_entry)?;

        let messages = load_session_messages(&conn, session_id)?;
        assert_eq!(messages.len(), 2);
        let assistant = messages.last().expect("assistant message");
        assert_eq!(assistant.role, "assistant");
        assert!(assistant.failed);
        assert_eq!(assistant.text, error_text);
        assert!(
            assistant
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains("error")
        );
        Ok(())
    }
}
