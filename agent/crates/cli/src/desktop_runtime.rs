use anyhow::{Result, anyhow, bail};
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
use chrono::{Local, TimeZone, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use tokio::sync::mpsc;

use crate::login;
use crate::session_bootstrap::{
    SessionBootstrapOptions, SessionRuntimeSetup, prepare_session_runtime_for_cwd,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatMessage {
    pub role: String,
    pub sender: Option<String>,
    pub text: String,
    pub detail: Option<String>,
    pub time_label: String,
    pub timestamp_ms: i64,
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

impl DesktopRuntimeSession {
    pub async fn create_new(cwd: std::path::PathBuf) -> Result<Self> {
        let (_runtime_host, _ui, setup) =
            prepare_session_runtime_for_cwd(cwd, SessionBootstrapOptions::default()).await?;
        Ok(Self { setup })
    }

    pub async fn resume(cwd: std::path::PathBuf, session_id: &str) -> Result<Self> {
        let entry = SessionBootstrapOptions {
            session: Some(session_id.to_string()),
            ..SessionBootstrapOptions::default()
        };
        let (_runtime_host, _ui, setup) = prepare_session_runtime_for_cwd(cwd, entry).await?;
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

    pub fn set_model(&mut self, requested_model: &str) -> Result<()> {
        let settings = Settings::load_merged(&self.setup.tool_ctx.cwd);
        let model =
            resolve_model_candidate(&settings, requested_model, Some(&self.setup.model.provider))?;
        self.setup.model = model;
        refresh_provider_runtime_fields(&mut self.setup);
        if self.setup.session_created {
            append_model_change_entry(&self.setup.conn, &self.setup.session_id, &self.setup.model)?;
        }
        Ok(())
    }

    pub fn set_thinking(&mut self, requested_thinking: &str) -> Result<()> {
        let thinking = ThinkingLevel::parse(requested_thinking)
            .ok_or_else(|| anyhow!("Unknown thinking level: {requested_thinking}"))?;
        self.setup.thinking_level = thinking.as_str().to_string();
        if self.setup.session_created {
            append_thinking_level_change_entry(&self.setup.conn, &self.setup.session_id, thinking)?;
        }
        Ok(())
    }

    pub fn set_name(&mut self, requested_name: &str) -> Result<()> {
        let name = requested_name.trim();
        if name.is_empty() {
            bail!("Session name cannot be empty");
        }
        ensure_session_row_created(&mut self.setup)?;
        kordi_session::store::set_session_name(&self.setup.conn, &self.setup.session_id, Some(name))?;
        Ok(())
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

    pub async fn send_message_streaming<F>(
        &mut self,
        prompt: String,
        attachment_paths: Vec<String>,
        cancel: tokio_util::sync::CancellationToken,
        mut on_event: F,
    ) -> Result<DesktopChatSessionDetail>
    where
        F: FnMut(&TurnEvent),
    {
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
        let images = load_images_from_paths(&expanded.image_paths)?;

        ensure_session_row_created(&mut self.setup)?;
        maybe_name_session_from_prompt(&self.setup.conn, &self.setup.session_id, &prompt_text)?;
        turn_runner::append_user_message_with_images(
            &self
                .setup
                .sibling_conn
                .clone()
                .ok_or_else(|| anyhow!("Session DB connection is unavailable"))?,
            &self.setup.session_id,
            &prompt_text,
            &images,
        )
        .await?;
        refresh_provider_runtime_fields(&mut self.setup);

        let turn_config = build_turn_config(&mut self.setup, cancel)?;
        let (turn_event_tx, mut turn_event_rx) = mpsc::unbounded_channel::<TurnEvent>();
        let turn_handle =
            tokio::spawn(async move { run_turn(turn_config, turn_event_tx, prompt_text).await });

        let mut turn_error: Option<String> = None;
        while let Some(event) = turn_event_rx.recv().await {
            on_event(&event);
            match &event {
                TurnEvent::ContextOverflow { message } => turn_error = Some(message.clone()),
                TurnEvent::Error(message) => turn_error = Some(message.clone()),
                _ => {}
            }
        }

        let (returned_config, turn_result) = turn_handle
            .await
            .map_err(|err| anyhow!("turn task failed: {err}"))?;
        self.setup.tool_registry = returned_config.tool_registry;

        turn_result?;
        if let Some(message) = turn_error {
            bail!(message);
        }

        self.detail()
    }
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

fn session_summary_from_row(
    conn: &rusqlite::Connection,
    row: kordi_session::store::SessionRow,
) -> Result<DesktopChatSessionSummary> {
    let updated_at_label = session_activity_label(conn, &row);
    let title = row
        .name
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("Session {}", short_session_id(&row.session_id)));
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
    kordi_session::store::open_db(&kordi_core::config::session_db_path(&global_settings.storage))
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

pub fn list_project_groups(_cwd: &std::path::Path) -> Result<Vec<DesktopChatProjectGroup>> {
    let conn = open_sessions_db()?;
    let rows = kordi_session::store::list_all_sessions(&conn)?;
    let mut groups: std::collections::BTreeMap<String, DesktopChatProjectGroup> =
        std::collections::BTreeMap::new();
    let mut group_sort_keys = std::collections::HashMap::<String, i64>::new();
    let mut session_sort_keys = std::collections::HashMap::<String, i64>::new();

    for row in rows {
        let sort_ts = session_sort_timestamp_ms(&conn, &row);
        let session_id = row.session_id.clone();
        let session_cwd = std::path::PathBuf::from(&row.cwd);
        let project_root =
            kordi_core::config::project_root(&session_cwd).unwrap_or_else(|| session_cwd.clone());
        let group_id = format!("project:{}", project_root.display());
        let settings = Settings::load_project(&session_cwd);
        let project_name = settings
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
        let summary_row = session_summary_from_row(&conn, row)?;

        let entry = groups
            .entry(group_id.clone())
            .or_insert_with(|| DesktopChatProjectGroup {
                id: group_id.clone(),
                name: project_name,
                root: project_root.display().to_string(),
                summary,
                background_system,
                shared_sources,
                sessions: Vec::new(),
            });
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
    }
}

fn model_source_label(provider: &str, auth: Option<&login::ResolvedProviderAuth>) -> String {
    match (provider, auth.map(|value| value.method)) {
        ("anthropic", Some(login::ProviderAuthMethod::OAuth)) => "Claude Pro/Max".to_string(),
        ("anthropic", Some(login::ProviderAuthMethod::ApiKey)) => "Anthropic API key".to_string(),
        ("openai", Some(login::ProviderAuthMethod::OAuth))
        | ("openai-codex", Some(login::ProviderAuthMethod::OAuth)) => {
            "ChatGPT Plus/Pro".to_string()
        }
        ("openai", Some(login::ProviderAuthMethod::ApiKey))
        | ("openai-codex", Some(login::ProviderAuthMethod::ApiKey)) => "OpenAI API key".to_string(),
        ("github-copilot", _) => "GitHub Copilot".to_string(),
        (_, Some(login::ProviderAuthMethod::ApiKey)) => {
            format!("{} API key", login::provider_display_name(provider))
        }
        _ => login::provider_display_name(provider).into_owned(),
    }
}

fn desktop_model_option_from_live_id(
    provider: &str,
    model_id: String,
    static_models: &HashMap<String, Model>,
    auth: Option<&login::ResolvedProviderAuth>,
) -> DesktopChatModelOption {
    if let Some(model) = static_models.get(&model_id) {
        return desktop_model_option_from_model(model);
    }

    DesktopChatModelOption {
        provider: provider.to_string(),
        provider_label: login::provider_display_name(provider).into_owned(),
        value: format!("{provider}/{model_id}"),
        label: model_id.clone(),
        detail: format!(
            "{} • live from official provider",
            model_source_label(provider, auth)
        ),
    }
}

async fn fetch_openai_compatible_model_ids(
    base_url: &str,
    bearer_token: &str,
) -> Result<Vec<String>> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let response = Client::new()
        .get(url)
        .header("Authorization", format!("Bearer {bearer_token}"))
        .header("Accept", "application/json")
        .send()
        .await?;

    if !response.status().is_success() {
        anyhow::bail!("HTTP {}", response.status());
    }

    let body: Value = response.json().await?;
    Ok(body
        .get("data")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
        .map(ToString::to_string)
        .collect())
}

async fn fetch_anthropic_model_ids(auth: &login::ResolvedProviderAuth) -> Result<Vec<String>> {
    let mut request = Client::new()
        .get("https://api.anthropic.com/v1/models")
        .header("anthropic-version", "2023-06-01")
        .header("accept", "application/json")
        .header("anthropic-dangerous-direct-browser-access", "true");

    request = match auth.method {
        login::ProviderAuthMethod::OAuth => request
            .header("Authorization", format!("Bearer {}", auth.credential))
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("user-agent", "claude-cli/2.1.75")
            .header("x-app", "cli"),
        login::ProviderAuthMethod::ApiKey => request.header("x-api-key", auth.credential.clone()),
    };

    let response = request.send().await?;
    if !response.status().is_success() {
        anyhow::bail!("HTTP {}", response.status());
    }

    let body: Value = response.json().await?;
    Ok(body
        .get("data")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
        .map(ToString::to_string)
        .collect())
}

async fn fetch_google_model_ids(api_key: &str) -> Result<Vec<String>> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={api_key}");
    let response = Client::new().get(url).send().await?;
    if !response.status().is_success() {
        anyhow::bail!("HTTP {}", response.status());
    }

    let body: Value = response.json().await?;
    Ok(body
        .get("models")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter(|item| {
            item.get("supportedGenerationMethods")
                .and_then(|value| value.as_array())
                .map(|methods| {
                    methods.iter().any(|method| {
                        method
                            .as_str()
                            .is_some_and(|value| value.eq_ignore_ascii_case("generateContent"))
                    })
                })
                .unwrap_or(false)
        })
        .filter_map(|item| item.get("name").and_then(|value| value.as_str()))
        .map(|name| name.trim_start_matches("models/").to_string())
        .filter(|name| name.contains("gemini"))
        .collect())
}

async fn fetch_live_model_ids_for_provider(provider: &str) -> Option<Vec<String>> {
    let auth = login::resolve_provider_auth(provider)?;
    let result = match provider {
        "anthropic" => fetch_anthropic_model_ids(&auth).await,
        "openai" if matches!(auth.method, login::ProviderAuthMethod::ApiKey) => {
            fetch_openai_compatible_model_ids("https://api.openai.com/v1", &auth.credential).await
        }
        "google" => fetch_google_model_ids(&auth.credential).await,
        "groq" => {
            fetch_openai_compatible_model_ids("https://api.groq.com/openai/v1", &auth.credential)
                .await
        }
        "xai" => fetch_openai_compatible_model_ids("https://api.x.ai/v1", &auth.credential).await,
        "openrouter" => {
            fetch_openai_compatible_model_ids("https://openrouter.ai/api/v1", &auth.credential)
                .await
        }
        "github-copilot" => Ok(login::github_copilot_cached_models()),
        _ => return None,
    };

    result.ok().filter(|ids| !ids.is_empty())
}

pub async fn authenticated_model_options(cwd: &std::path::Path) -> Vec<DesktopChatModelOption> {
    let settings = Settings::load_merged(cwd);
    let mut static_models = login::authenticated_model_candidates(&settings);
    static_models.sort_by(|left, right| {
        left.provider
            .cmp(&right.provider)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut static_by_provider: BTreeMap<String, Vec<Model>> = BTreeMap::new();
    for model in static_models {
        static_by_provider
            .entry(model.provider.clone())
            .or_default()
            .push(model);
    }

    let mut options = Vec::new();
    for (provider, models) in &static_by_provider {
        let static_lookup = models
            .iter()
            .cloned()
            .map(|model| (model.id.clone(), model))
            .collect::<HashMap<_, _>>();

        let resolved_auth = login::resolve_provider_auth(provider);
        let provider_options =
            if let Some(mut live_ids) = fetch_live_model_ids_for_provider(provider).await {
                live_ids.sort();
                live_ids.dedup();
                live_ids
                    .into_iter()
                    .map(|model_id| {
                        desktop_model_option_from_live_id(
                            provider,
                            model_id,
                            &static_lookup,
                            resolved_auth.as_ref(),
                        )
                    })
                    .collect::<Vec<_>>()
            } else {
                models
                    .iter()
                    .map(desktop_model_option_from_model)
                    .collect::<Vec<_>>()
            };

        options.extend(provider_options);
    }

    options
}

fn synthesize_live_model_candidate(
    registry: &ModelRegistry,
    provider: &str,
    model_id: &str,
) -> Option<Model> {
    let template = registry
        .list()
        .iter()
        .find(|model| model.provider == provider)
        .cloned()?;

    Some(Model {
        id: model_id.to_string(),
        name: model_id.to_string(),
        ..template
    })
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

    if let Some((provider, model_id)) = requested.split_once('/') {
        return registry
            .find(provider, model_id)
            .cloned()
            .or_else(|| registry.find_fuzzy(model_id, Some(provider)).cloned())
            .or_else(|| synthesize_live_model_candidate(&registry, provider, model_id))
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
        if let Some(model) = synthesize_live_model_candidate(&registry, provider, requested) {
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

fn refresh_provider_runtime_fields(setup: &mut SessionRuntimeSetup) {
    let runtime = crate::runtime_model::resolve_runtime_config(&setup.model);

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
    append_model_change_entry(&setup.conn, &setup.session_id, &setup.model)?;
    let initial_thinking =
        ThinkingLevel::parse(&setup.thinking_level).unwrap_or(ThinkingLevel::Medium);
    append_thinking_level_change_entry(&setup.conn, &setup.session_id, initial_thinking)?;
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
    if row
        .name
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Ok(());
    }

    let title = prompt
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    let title = if title.is_empty() {
        format!("Session {}", short_session_id(session_id))
    } else {
        truncate_chars(&title, 60)
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
            execution_mode: setup.tool_ctx.execution_mode,
            request_approval: setup.tool_ctx.request_approval.clone(),
        },
        thinking: if setup.thinking_level == "off" {
            None
        } else {
            Some(setup.thinking_level.clone())
        },
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

fn load_project_info(cwd: &std::path::Path) -> Option<DesktopChatProjectInfo> {
    let project_root = kordi_core::config::project_root(cwd).unwrap_or_else(|| cwd.to_path_buf());
    let settings = Settings::load_project(cwd);
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

    let title = session_row
        .as_ref()
        .and_then(|row| row.name.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            if messages.is_empty() {
                "New session".to_string()
            } else {
                format!("Session {}", short_session_id(&setup.session_id))
            }
        });
    let subtitle = session_focus_subtitle(&messages).unwrap_or_default();
    let updated_at_label = session_row
        .as_ref()
        .map(|row| session_activity_label(&setup.conn, row))
        .unwrap_or_else(|| "Draft".to_string());

    let context_window_status = current_context_window_status(setup);

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
        },
        project: load_project_info(&setup.tool_ctx.cwd),
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
    timestamp_ms: i64,
}

impl HistoricalTurnBuilder {
    fn is_empty(&self) -> bool {
        self.assistant_text_parts.is_empty()
            && self.thinking_parts.is_empty()
            && self.tools.is_empty()
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
    out.push(DesktopChatMessage {
        role: "assistant".to_string(),
        sender: Some("Kordi".to_string()),
        text: assistant_text,
        detail: turn.detail,
        time_label: format_message_timestamp(turn.timestamp_ms),
        timestamp_ms: turn.timestamp_ms,
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
                        text: text_from_blocks(&user.content),
                        detail: None,
                        time_label: format_message_timestamp(user.timestamp),
                        timestamp_ms: user.timestamp,
                        thinking_text: None,
                        tools: Vec::new(),
                    });
                }
                AgentMessage::Assistant(message) => {
                    let turn = current_turn.get_or_insert_with(HistoricalTurnBuilder::default);
                    turn.touch_timestamp(message.timestamp);

                    turn.detail = Some(format!(
                        "{}/{} • {}",
                        message.provider,
                        message.model,
                        match &message.stop_reason {
                            kordi_core::types::StopReason::Stop => "completed",
                            kordi_core::types::StopReason::Length => "length limit",
                            kordi_core::types::StopReason::ToolUse => "tool use",
                            kordi_core::types::StopReason::Error => "error",
                            kordi_core::types::StopReason::Aborted => "aborted",
                        }
                    ));

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
                        detail: Some(format!("Compaction • {} tokens", message.tokens_before)),
                        time_label: format_message_timestamp(message.timestamp),
                        timestamp_ms: message.timestamp,
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
                    thinking_text: None,
                    tools: Vec::new(),
                })
            }
            SessionEntry::CustomMessage {
                custom_type,
                content,
                display,
                base,
                ..
            } => {
                flush_historical_turn(&mut out, &mut current_turn);
                if display {
                    out.push(DesktopChatMessage {
                        role: "system".to_string(),
                        sender: None,
                        text: text_from_blocks(&content),
                        detail: Some(custom_type),
                        time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                        timestamp_ms: base.timestamp.timestamp_millis(),
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
                    detail: Some(format!("Compaction • {} tokens", tokens_before)),
                    time_label: format_utc_timestamp(base.timestamp.timestamp_millis()),
                    timestamp_ms: base.timestamp.timestamp_millis(),
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

fn text_from_blocks(blocks: &[ContentBlock]) -> String {
    let joined = blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            ContentBlock::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");

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
        .map(|message| truncate_chars(&message.text.replace('\n', " "), 96))
        .filter(|value| !value.trim().is_empty())
}

fn thinking_label(value: &str) -> String {
    match value {
        "off" => "Off".to_string(),
        "minimal" => "Minimal".to_string(),
        "low" => "Low".to_string(),
        "medium" => "Medium".to_string(),
        "high" => "High".to_string(),
        "xhigh" => "Extra High".to_string(),
        other => other.to_string(),
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
