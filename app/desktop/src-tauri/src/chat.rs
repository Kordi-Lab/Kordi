use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use kordi_cli::desktop_runtime::{
    DesktopChatAgentProfile, DesktopChatModelOption, DesktopChatProjectGroup,
    DesktopChatSessionDetail, DesktopChatSessionSummary, DesktopChatSlashCommand,
    DesktopRuntimeSession,
};
use kordi_core::error::KordiError;
use kordi_core::settings::Settings;
use kordi_tools::ReachOutRuntime;

use crate::bridge::{
    desktop_bridge_outreach_prompt_context, desktop_bridge_reach_out_impl, DesktopBridgeManager,
};

pub(crate) mod artifacts;
pub(crate) mod attachments;
pub(crate) mod bridge_agent_runner;
pub(crate) mod turns;

pub(crate) use attachments::{
    allow_attachment_asset_scope, store_chat_attachment_bytes, stored_chat_attachment_from_path,
};

pub(crate) use bridge_agent_runner::{run_bridge_agent_prompt, DesktopBridgeAgentModelRouting};

use turns::{
    apply_desktop_turn_event, prune_finished_turns, session_has_running_turn, snapshot_turn,
    update_turn,
};

#[cfg(test)]
use turns::{is_auto_compaction_failure_status, is_auto_compaction_success_status};

type DesktopSessionHandle = Arc<tokio::sync::Mutex<DesktopRuntimeSession>>;

#[derive(Clone)]
struct DesktopChatTurnHandle {
    snapshot: Arc<Mutex<DesktopChatTurnSnapshot>>,
    cancel: tokio_util::sync::CancellationToken,
}

#[derive(Clone, Default)]
pub struct DesktopChatManager {
    sessions: Arc<tokio::sync::Mutex<HashMap<String, DesktopSessionHandle>>>,
    turns: Arc<tokio::sync::Mutex<HashMap<String, DesktopChatTurnHandle>>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopStoredChatAttachment {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub mime_type: Option<String>,
    pub format_label: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatState {
    pub cwd: String,
    pub active_session_id: String,
    pub sessions: Vec<DesktopChatSessionSummary>,
    pub projects: Vec<DesktopChatProjectGroup>,
    pub active_session: DesktopChatSessionDetail,
    pub local_agent: DesktopChatAgentProfile,
    pub model_options: Vec<DesktopChatModelOption>,
    pub slash_commands: Vec<DesktopChatSlashCommand>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatToolSnapshot {
    pub id: String,
    pub name: String,
    pub status: String,
    pub arguments: String,
    pub live_output: String,
    pub result_text: Option<String>,
    pub detail: Option<String>,
    pub is_error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatTurnSnapshot {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub status: String,
    pub message: String,
    pub assistant_text: String,
    pub thinking_text: String,
    pub tools: Vec<DesktopChatToolSnapshot>,
    pub completed: bool,
    pub succeeded: bool,
    pub error: Option<String>,
    pub transcript_refresh_required: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatMessageRoute {
    pub model: Option<String>,
    pub auth_provider: Option<String>,
    pub auth_choice: Option<String>,
    pub thinking: Option<String>,
}

const TRANSIENT_LOCAL_DRAFT_SESSION_ID: &str = "draft:local-chat";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatArtifactPreviewLine {
    pub number: usize,
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopChatArtifactPreview {
    pub path: String,
    pub lines: Vec<DesktopChatArtifactPreviewLine>,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopArtifactDirectoryEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub is_directory: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopArtifactDirectory {
    pub path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<DesktopArtifactDirectoryEntry>,
}

fn chat_cwd() -> Result<PathBuf, String> {
    std::env::current_dir().map_err(|err| err.to_string())
}

fn sanitize_bridge_segment(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

async fn ensure_provider_ready_for_send(
    provider: &str,
    model: &str,
    cwd: &std::path::Path,
) -> Result<(), String> {
    if provider != "lm-studio" && provider != "ollama" {
        return Ok(());
    }

    if model.trim().is_empty() {
        let label = if provider == "ollama" {
            "Ollama"
        } else {
            "LM Studio"
        };
        return Err(format!("{label} selected, but no local model is selected."));
    }

    let settings = Settings::load_merged(cwd);
    if provider == "ollama" {
        crate::auth::ollama::ensure_server_running(local_provider_port(&settings, "ollama"))
            .await
            .map_err(|err| format!(
                "Ollama selected, but its local server is not running. Open Authentication → Ollama and start the local server, or start it from Ollama. {err}"
            ))?;
        return Ok(());
    }

    crate::auth::lm_studio::ensure_server_running(local_provider_port(&settings, "lm-studio"))
        .await
        .map_err(|err| format!(
            "LM Studio selected, but its local server is not running. Open Authentication → LM Studio and start the local server, or start it from LM Studio. {err}"
        ))?;

    crate::auth::lm_studio::ensure_model_loaded_with_best_context(model)
        .await
        .map_err(|err| format!(
            "LM Studio selected, but Kordi could not load `{model}` with a larger supported context length. {err}"
        ))
}

fn bridge_agent_session_cwd(
    local_agent_node_id: &str,
    peer_node_id: &str,
) -> Result<PathBuf, String> {
    let root = std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or(chat_cwd()?);
    let dir = root
        .join("korde")
        .join("bridge-agent-sessions")
        .join(sanitize_bridge_segment(local_agent_node_id))
        .join(sanitize_bridge_segment(peer_node_id));
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn session_exists_globally(session_id: &str) -> Result<bool, String> {
    kordi_cli::desktop_runtime::session_exists(session_id).map_err(|err| err.to_string())
}

fn is_placeholder_session_title(title: &str) -> bool {
    let trimmed = title.trim();
    trimmed.is_empty() || trimmed.eq_ignore_ascii_case("New session") || trimmed == "Session"
}

fn is_blank_draft_summary(summary: &DesktopChatSessionSummary) -> bool {
    summary.message_count == 0 && (summary.draft || is_placeholder_session_title(&summary.title))
}

fn filter_blank_draft_projects(
    projects: Vec<DesktopChatProjectGroup>,
) -> Vec<DesktopChatProjectGroup> {
    projects
        .into_iter()
        .map(|mut project| {
            project
                .sessions
                .retain(|session| !is_blank_draft_summary(session));
            project
        })
        .collect()
}

fn desktop_chat_message_is_agent(message: &kordi_cli::desktop_runtime::DesktopChatMessage) -> bool {
    let role = message.role.trim().to_lowercase();
    role != "user" && role != "system"
}

fn completed_desktop_session_state_for_canonical_sync(
    cwd: &Path,
    active_session_id: &str,
    active_session: DesktopChatSessionDetail,
    local_agent: DesktopChatAgentProfile,
) -> DesktopChatState {
    DesktopChatState {
        cwd: cwd.display().to_string(),
        active_session_id: active_session_id.to_string(),
        sessions: Vec::new(),
        projects: Vec::new(),
        active_session,
        local_agent,
        model_options: Vec::new(),
        slash_commands: Vec::new(),
    }
}

async fn sync_completed_desktop_session_to_canonical(
    cwd: &Path,
    active_session_id: &str,
    session: &DesktopSessionHandle,
) {
    let snapshot = {
        let session = session.lock().await;
        match session.detail() {
            Ok(detail) => Some((detail, session.agent_profile())),
            Err(error) => {
                eprintln!(
                    "Unable to load completed desktop chat detail for canonical sync: {error}"
                );
                None
            }
        }
    };

    let Some((active_session, local_agent)) = snapshot else {
        return;
    };
    let state = completed_desktop_session_state_for_canonical_sync(
        cwd,
        active_session_id,
        active_session,
        local_agent,
    );
    if let Err(error) = crate::canonical_sessions::sync_desktop_chat_state(&state) {
        eprintln!("Unable to sync completed desktop chat into canonical sessions: {error}");
    }
}

fn desktop_state_for_canonical_sync(
    state: &DesktopChatState,
    active_turn_running: bool,
) -> DesktopChatState {
    if !active_turn_running {
        return state.clone();
    }

    let Some(last_user_index) = state
        .active_session
        .messages
        .iter()
        .rposition(|message| message.role.trim().eq_ignore_ascii_case("user"))
    else {
        return state.clone();
    };

    let mut next = state.clone();
    next.active_session.messages = state
        .active_session
        .messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| {
            (!(index > last_user_index && desktop_chat_message_is_agent(message)))
                .then(|| message.clone())
        })
        .collect();
    next.active_session.message_count = next.active_session.messages.len();
    next
}

async fn ensure_transient_draft_runtime(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
) -> Result<DesktopSessionHandle, String> {
    {
        let sessions = manager.sessions.lock().await;
        if let Some(handle) = sessions.get(TRANSIENT_LOCAL_DRAFT_SESSION_ID).cloned() {
            return Ok(handle);
        }
    }

    let runtime = DesktopRuntimeSession::create_new(cwd.to_path_buf())
        .await
        .map_err(|err| err.to_string())?;
    let handle = Arc::new(tokio::sync::Mutex::new(runtime));
    let mut sessions = manager.sessions.lock().await;
    Ok(sessions
        .entry(TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string())
        .or_insert_with(|| handle.clone())
        .clone())
}

async fn materialize_transient_draft_runtime(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
) -> Result<String, String> {
    let handle = ensure_transient_draft_runtime(manager, cwd).await?;
    let session_id = {
        let mut runtime = handle.lock().await;
        runtime
            .materialize_session()
            .map_err(|err| err.to_string())?;
        runtime.session_id().to_string()
    };

    let mut sessions = manager.sessions.lock().await;
    sessions.remove(TRANSIENT_LOCAL_DRAFT_SESSION_ID);
    sessions.insert(session_id.clone(), handle);
    Ok(session_id)
}

async fn build_transient_draft_chat_state(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    persisted: Vec<DesktopChatSessionSummary>,
    projects: Vec<DesktopChatProjectGroup>,
    model_options: Vec<DesktopChatModelOption>,
) -> Result<DesktopChatState, String> {
    let runtime = ensure_transient_draft_runtime(manager, cwd).await?;
    let runtime = runtime.lock().await;
    let mut active_session = runtime.detail().map_err(|err| err.to_string())?;
    active_session.id = TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string();
    active_session.title = "New session".to_string();
    active_session.subtitle.clear();
    active_session.updated_at_label = "Draft".to_string();
    active_session.message_count = 0;
    active_session.draft = true;
    active_session.messages.clear();

    Ok(DesktopChatState {
        cwd: cwd.display().to_string(),
        active_session_id: TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string(),
        sessions: persisted,
        projects,
        active_session,
        local_agent: runtime.agent_profile(),
        model_options,
        slash_commands: runtime.slash_commands(),
    })
}

fn normalize_mention_label(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn mention_text_starts_with_label(text: &str, label: &str) -> bool {
    let normalized_text = normalize_mention_label(text);
    let normalized_label = normalize_mention_label(label);
    if normalized_text.is_empty() || normalized_label.is_empty() {
        return false;
    }
    if normalized_text == normalized_label {
        return true;
    }
    let Some(rest) = normalized_text.strip_prefix(&normalized_label) else {
        return false;
    };
    rest.chars().next().is_none_or(|ch| {
        ch.is_whitespace() || matches!(ch, ':' | ';' | ',' | '.' | '!' | '?' | '—' | '-')
    })
}

fn text_explicitly_mentions_label(text: &str, label: &str) -> bool {
    text.match_indices('@').any(|(index, _)| {
        let before = text[..index].chars().next_back();
        if before.is_some_and(|ch| !ch.is_whitespace()) {
            return false;
        }
        mention_text_starts_with_label(&text[index + 1..], label)
    })
}

fn local_agent_mention_labels(
    runtime: &DesktopRuntimeSession,
    cwd: &std::path::Path,
) -> Vec<String> {
    let profile = runtime.agent_profile();
    let mut labels = vec!["Kordi".to_string(), profile.label];
    if let Some(name) = std::path::Path::new(&profile.workspace_root)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        labels.push(name.to_string());
    }
    if let Some(name) = cwd
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        labels.push(name.to_string());
    }
    labels.sort_by_key(|label| normalize_mention_label(label));
    labels.dedup_by(|left, right| normalize_mention_label(left) == normalize_mention_label(right));
    labels
}

fn text_mentions_non_local_target(text: &str, local_agent_labels: &[String]) -> bool {
    text.match_indices('@').any(|(index, _)| {
        let before = text[..index].chars().next_back();
        if before.is_some_and(|ch| !ch.is_whitespace()) {
            return false;
        }
        let after_at = &text[index + 1..];
        if after_at.trim().is_empty() {
            return false;
        }
        !local_agent_labels
            .iter()
            .any(|label| mention_text_starts_with_label(after_at, label))
    })
}

fn text_mentions_local_agent(text: &str, local_agent_labels: &[String]) -> bool {
    text.match_indices('@').any(|(index, _)| {
        let before = text[..index].chars().next_back();
        if before.is_some_and(|ch| !ch.is_whitespace()) {
            return false;
        }
        let after_at = &text[index + 1..];
        local_agent_labels
            .iter()
            .any(|label| mention_text_starts_with_label(after_at, label))
    })
}

fn reach_out_target_allowed_by_user_text(
    user_text: &str,
    target: &str,
    local_agent_labels: &[String],
) -> bool {
    let target = target.trim();
    if target.is_empty() {
        return false;
    }
    if local_agent_labels
        .iter()
        .any(|label| normalize_mention_label(label) == normalize_mention_label(target))
    {
        return false;
    }
    text_explicitly_mentions_label(user_text, target)
}

async fn prepare_desktop_session_for_send(
    runtime: &mut DesktopRuntimeSession,
    bridge_manager: DesktopBridgeManager,
    chat_manager: DesktopChatManager,
    cwd: PathBuf,
    user_text: &str,
) {
    let local_agent_labels = local_agent_mention_labels(runtime, &cwd);
    let local_session_context = if text_mentions_local_agent(user_text, &local_agent_labels) {
        crate::canonical_sessions::local_agent_session_prompt_context(Some(runtime.session_id()))
            .ok()
            .flatten()
    } else {
        None
    };
    if text_mentions_non_local_target(user_text, &local_agent_labels) {
        let prompt_context = desktop_bridge_outreach_prompt_context(&bridge_manager).await;
        runtime.set_bridge_outreach_prompt_context(match (local_session_context, prompt_context) {
            (Some(local_context), Some(bridge_context)) => {
                Some(format!("{local_context}\n\n{bridge_context}"))
            }
            (Some(local_context), None) => Some(local_context),
            (None, bridge_context) => bridge_context,
        });
        install_reach_out_runtime(
            runtime,
            bridge_manager,
            chat_manager,
            cwd,
            user_text.to_string(),
            local_agent_labels,
        );
    } else {
        runtime.set_bridge_outreach_prompt_context(local_session_context);
        runtime.set_reach_out_runtime(None);
    }
}

fn install_reach_out_runtime(
    runtime: &mut DesktopRuntimeSession,
    bridge_manager: DesktopBridgeManager,
    chat_manager: DesktopChatManager,
    cwd: PathBuf,
    user_text: String,
    local_agent_labels: Vec<String>,
) {
    let parent_session_id = runtime.session_id().to_string();
    runtime.set_reach_out_runtime(Some(ReachOutRuntime {
        reach_out: Arc::new(move |mut request| {
            let bridge_manager = bridge_manager.clone();
            let chat_manager = chat_manager.clone();
            let cwd = cwd.clone();
            let parent_session_id = parent_session_id.clone();
            let user_text = user_text.clone();
            let local_agent_labels = local_agent_labels.clone();
            Box::pin(async move {
                if !reach_out_target_allowed_by_user_text(
                    &user_text,
                    &request.target,
                    &local_agent_labels,
                ) {
                    return Err(KordiError::Tool(
                        "reach_out is only for explicit non-local @Person/@Agent mentions in the current user message; @Kordi addresses the local agent."
                            .to_string(),
                    ));
                }
                if request.parent_session_id.is_none() {
                    request.parent_session_id = Some(parent_session_id);
                }
                if request.project_name.is_none() {
                    request.project_name = kordi_core::settings::Settings::load_project(&cwd)
                        .project_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                        .or_else(|| {
                            cwd.file_name()
                                .and_then(|value| value.to_str())
                                .map(ToString::to_string)
                        });
                }
                desktop_bridge_reach_out_impl(&bridge_manager, &chat_manager, request)
                    .await
                    .map_err(KordiError::Tool)
            })
        }),
    }));
}

async fn ensure_loaded_session(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    active_session_id: Option<String>,
) -> Result<String, String> {
    let persisted =
        kordi_cli::desktop_runtime::list_session_summaries(cwd).map_err(|err| err.to_string())?;
    let mut sessions = manager.sessions.lock().await;

    if let Some(session_id) = active_session_id {
        if session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
            return Ok(session_id);
        }
        if sessions.contains_key(&session_id) {
            return Ok(session_id);
        }
        if persisted.iter().any(|session| session.id == session_id)
            || session_exists_globally(&session_id)?
        {
            let runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), &session_id)
                .await
                .map_err(|err| err.to_string())?;
            sessions.insert(
                session_id.clone(),
                Arc::new(tokio::sync::Mutex::new(runtime)),
            );
            return Ok(session_id);
        }
    }

    if let Some(session_id) = persisted.first().map(|session| session.id.clone()) {
        if !sessions.contains_key(&session_id) {
            let runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), &session_id)
                .await
                .map_err(|err| err.to_string())?;
            sessions.insert(
                session_id.clone(),
                Arc::new(tokio::sync::Mutex::new(runtime)),
            );
        }
        return Ok(session_id);
    }

    Ok(TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string())
}

async fn ensure_loaded_or_create_explicit_session(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    session_id: String,
) -> Result<String, String> {
    if session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        return ensure_loaded_session(manager, cwd, Some(session_id)).await;
    }

    {
        let sessions = manager.sessions.lock().await;
        if sessions.contains_key(&session_id) {
            return Ok(session_id);
        }
    }

    let persisted =
        kordi_cli::desktop_runtime::list_session_summaries(cwd).map_err(|err| err.to_string())?;
    let runtime = if persisted.iter().any(|session| session.id == session_id)
        || session_exists_globally(&session_id)?
    {
        DesktopRuntimeSession::resume(cwd.to_path_buf(), &session_id)
            .await
            .map_err(|err| err.to_string())?
    } else {
        DesktopRuntimeSession::create_with_id(cwd.to_path_buf(), &session_id)
            .await
            .map_err(|err| err.to_string())?
    };

    let mut sessions = manager.sessions.lock().await;
    sessions.insert(
        session_id.clone(),
        Arc::new(tokio::sync::Mutex::new(runtime)),
    );
    Ok(session_id)
}

async fn authenticated_model_options_with_local_runtime(
    cwd: &std::path::Path,
) -> Vec<DesktopChatModelOption> {
    let mut options = kordi_cli::desktop_runtime::authenticated_model_options(cwd).await;
    options.retain(|option| option.provider != "ollama");
    merge_lm_studio_running_model_options(cwd, &mut options).await;
    merge_ollama_running_model_options(cwd, &mut options).await;
    options
}

async fn merge_lm_studio_running_model_options(
    cwd: &std::path::Path,
    options: &mut Vec<DesktopChatModelOption>,
) {
    let settings = Settings::load_merged(cwd);
    let base_url = lm_studio_base_url(&settings);
    let Ok(model_ids) = crate::auth::lm_studio::loaded_model_ids_for_base_url(&base_url).await
    else {
        return;
    };

    for model_id in model_ids {
        if options
            .iter()
            .any(|option| option.provider == "lm-studio" && option.label == model_id)
        {
            continue;
        }
        options.push(DesktopChatModelOption {
            provider: "lm-studio".to_string(),
            provider_label: "LM Studio".to_string(),
            value: format!("lm-studio/{model_id}"),
            label: model_id.clone(),
            detail: "LM Studio • running local model".to_string(),
            thinking_levels: kordi_cli::desktop_runtime::desktop_thinking_levels_for_model_id(
                &settings,
                "lm-studio",
                &model_id,
            ),
        });
    }
}

async fn merge_ollama_running_model_options(
    cwd: &std::path::Path,
    options: &mut Vec<DesktopChatModelOption>,
) {
    let settings = Settings::load_merged(cwd);
    let base_url = local_provider_base_url(&settings, "ollama", "http://localhost:11434/v1");
    let Ok(model_ids) = crate::auth::ollama::running_model_ids_for_base_url(&base_url).await else {
        return;
    };

    for model_id in model_ids {
        if options
            .iter()
            .any(|option| option.provider == "ollama" && option.label == model_id)
        {
            continue;
        }
        options.push(DesktopChatModelOption {
            provider: "ollama".to_string(),
            provider_label: "Ollama".to_string(),
            value: format!("ollama/{model_id}"),
            label: model_id.clone(),
            detail: "Ollama • running local model".to_string(),
            thinking_levels: kordi_cli::desktop_runtime::desktop_thinking_levels_for_model_id(
                &settings, "ollama", &model_id,
            ),
        });
    }
}

fn local_provider_port(settings: &Settings, provider: &str) -> Option<u32> {
    let fallback = if provider == "ollama" {
        "http://localhost:11434/v1"
    } else {
        "http://localhost:1234/v1"
    };
    let base_url = local_provider_base_url(settings, provider, fallback);
    let url = reqwest::Url::parse(&base_url).ok()?;
    url.port().map(u32::from)
}

fn lm_studio_base_url(settings: &Settings) -> String {
    local_provider_base_url(settings, "lm-studio", "http://localhost:1234/v1")
}

fn local_provider_base_url(settings: &Settings, provider_name: &str, fallback: &str) -> String {
    settings
        .providers
        .as_ref()
        .and_then(|providers| {
            providers.iter().find_map(|provider| {
                kordi_cli::login::provider_names_match(provider_name, &provider.name)
                    .then(|| provider.base_url.as_deref().map(str::trim))
                    .flatten()
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            })
        })
        .or_else(|| {
            settings.models.as_ref().and_then(|models| {
                models.iter().find_map(|model| {
                    kordi_cli::login::provider_names_match(provider_name, &model.provider)
                        .then(|| model.base_url.as_deref().map(str::trim))
                        .flatten()
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)
                })
            })
        })
        .or_else(|| {
            kordi_cli::login::local_openai_provider_base_url(provider_name).map(ToString::to_string)
        })
        .unwrap_or_else(|| fallback.to_string())
}

async fn build_chat_state(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
    active_session_id: String,
) -> Result<DesktopChatState, String> {
    let persisted = kordi_cli::desktop_runtime::list_session_summaries(cwd)
        .map_err(|err| err.to_string())?
        .into_iter()
        .filter(|session| !is_blank_draft_summary(session))
        .collect::<Vec<_>>();
    let model_options = authenticated_model_options_with_local_runtime(cwd).await;
    let projects = filter_blank_draft_projects(
        kordi_cli::desktop_runtime::list_project_groups(cwd).map_err(|err| err.to_string())?,
    );
    if active_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        let state =
            build_transient_draft_chat_state(manager, cwd, persisted, projects, model_options)
                .await?;
        if let Err(error) = crate::canonical_sessions::sync_desktop_chat_state(&state) {
            eprintln!("Unable to sync desktop chat into canonical sessions: {error}");
        }
        return Ok(state);
    }

    let active_runtime = {
        let mut sessions = manager.sessions.lock().await;

        if !sessions.contains_key(&active_session_id) {
            let runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), &active_session_id)
                .await
                .map_err(|err| err.to_string())?;
            sessions.insert(
                active_session_id.clone(),
                Arc::new(tokio::sync::Mutex::new(runtime)),
            );
        }

        sessions
            .get(&active_session_id)
            .cloned()
            .ok_or_else(|| "Active session is unavailable".to_string())?
    };

    let (active_session, local_agent, slash_commands) = {
        let active_runtime = active_runtime.lock().await;
        (
            active_runtime.detail().map_err(|err| err.to_string())?,
            active_runtime.agent_profile(),
            active_runtime.slash_commands(),
        )
    };

    let mut summaries = persisted;
    let active_exists = summaries
        .iter()
        .any(|session| session.id == active_session_id);
    if !active_exists && active_session.project.is_none() {
        let active_runtime = active_runtime.lock().await;
        let summary = active_runtime.summary().map_err(|err| err.to_string())?;
        if !is_blank_draft_summary(&summary) {
            summaries.insert(0, summary);
        }
    }

    let session_handles = {
        let sessions = manager.sessions.lock().await;
        sessions
            .iter()
            .map(|(session_id, runtime)| (session_id.clone(), runtime.clone()))
            .collect::<Vec<_>>()
    };

    for (session_id, runtime) in session_handles {
        if summaries.iter().any(|session| session.id == session_id) {
            continue;
        }
        let runtime = runtime.lock().await;
        let detail = runtime.detail().map_err(|err| err.to_string())?;
        if detail.project.is_some() {
            continue;
        }
        let summary = runtime.summary().map_err(|err| err.to_string())?;
        if !is_blank_draft_summary(&summary) {
            summaries.push(summary);
        }
    }

    let state = DesktopChatState {
        cwd: cwd.display().to_string(),
        active_session_id,
        sessions: summaries,
        projects,
        active_session,
        local_agent,
        model_options,
        slash_commands,
    };
    let sync_state = desktop_state_for_canonical_sync(
        &state,
        session_has_running_turn(manager, &state.active_session_id).await,
    );
    if let Err(error) = crate::canonical_sessions::sync_desktop_chat_state(&sync_state) {
        eprintln!("Unable to sync desktop chat into canonical sessions: {error}");
    }
    Ok(state)
}

#[tauri::command]
pub async fn desktop_chat_state(
    manager: State<'_, DesktopChatManager>,
    active_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let active_session_id = ensure_loaded_session(&manager, &cwd, active_session_id).await?;
    build_chat_state(&manager, &cwd, active_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_new_session(
    manager: State<'_, DesktopChatManager>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let session_id = materialize_transient_draft_runtime(&manager, &cwd).await?;
    build_chat_state(&manager, &cwd, session_id).await
}

#[tauri::command]
pub async fn desktop_chat_new_project_session(
    manager: State<'_, DesktopChatManager>,
    project_root: String,
    title: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let resolved_project_root = resolve_project_root_input(&cwd, &project_root)?;
    kordi_cli::desktop_runtime::register_project(&resolved_project_root, None)
        .map_err(|err| err.to_string())?;

    let mut runtime = DesktopRuntimeSession::create_new(resolved_project_root.clone())
        .await
        .map_err(|err| err.to_string())?;
    runtime
        .materialize_session()
        .map_err(|err| err.to_string())?;
    if let Some(title) = title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        runtime.set_name(title).map_err(|err| err.to_string())?;
    }
    let session_id = runtime.session_id().to_string();
    kordi_cli::desktop_runtime::move_session_to_project(&session_id, &resolved_project_root)
        .map_err(|err| err.to_string())?;

    {
        let mut sessions = manager.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            Arc::new(tokio::sync::Mutex::new(runtime)),
        );
    }

    build_chat_state(&manager, &cwd, session_id).await
}

#[tauri::command]
pub async fn desktop_chat_prepare_draft_session(
    manager: State<'_, DesktopChatManager>,
) -> Result<(), String> {
    let cwd = chat_cwd()?;
    ensure_transient_draft_runtime(&manager, &cwd).await?;
    Ok(())
}

#[tauri::command]
pub async fn desktop_chat_update_session_config(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    model: Option<String>,
    thinking: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target_session_id = if session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string()
    } else {
        ensure_loaded_session(&manager, &cwd, Some(session_id)).await?
    };
    if target_session_id != TRANSIENT_LOCAL_DRAFT_SESSION_ID
        && session_has_running_turn(&manager, &target_session_id).await
    {
        return Err(
            "Stop the running task before changing this session's model or thinking level."
                .to_string(),
        );
    }
    let session = if target_session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        ensure_transient_draft_runtime(&manager, &cwd).await?
    } else {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let mut session = session.lock().await;

    if let Some(model) = model.as_deref() {
        session.set_model(model).map_err(|err| err.to_string())?;
    }
    if let Some(thinking) = thinking.as_deref() {
        session
            .set_thinking(thinking)
            .map_err(|err| err.to_string())?;
    }
    drop(session);

    build_chat_state(&manager, &cwd, target_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_rename_session(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    name: String,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target_session_id = ensure_loaded_session(&manager, &cwd, Some(session_id)).await?;
    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let mut session = session.lock().await;
    session.set_name(&name).map_err(|err| err.to_string())?;
    drop(session);

    build_chat_state(&manager, &cwd, target_session_id).await
}

struct SessionActionTarget {
    id: String,
    local_exists: bool,
    canonical_exists: bool,
}

fn resolve_existing_session_action_target(session_id: &str) -> Result<SessionActionTarget, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id == TRANSIENT_LOCAL_DRAFT_SESSION_ID {
        return Err("Session not found".to_string());
    }

    let local_exists = session_exists_globally(session_id)?;
    let canonical_exists = crate::canonical_sessions::session_exists(session_id)?;
    if !local_exists && !canonical_exists {
        return Err(format!("Session not found: {session_id}"));
    }

    Ok(SessionActionTarget {
        id: session_id.to_string(),
        local_exists,
        canonical_exists,
    })
}

fn resolve_session_action_fallback_target(
    cwd: &std::path::Path,
    preferred_active_session_id: Option<String>,
) -> Result<String, String> {
    if let Some(session_id) = preferred_active_session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if session_exists_globally(session_id)? {
            return Ok(session_id.to_string());
        }
    }

    let next_chat_session_id = kordi_cli::desktop_runtime::list_session_summaries(cwd)
        .map_err(|err| err.to_string())?
        .into_iter()
        .find(|session| !is_blank_draft_summary(session))
        .map(|session| session.id);

    Ok(next_chat_session_id.unwrap_or_else(|| TRANSIENT_LOCAL_DRAFT_SESSION_ID.to_string()))
}

fn expand_home_project_path(raw_path: &str) -> std::path::PathBuf {
    if raw_path == "~" {
        return std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(raw_path));
    }
    if let Some(rest) = raw_path.strip_prefix("~/") {
        return std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .map(|home| home.join(rest))
            .unwrap_or_else(|| std::path::PathBuf::from(raw_path));
    }
    std::path::PathBuf::from(raw_path)
}

fn resolve_project_root_input(
    cwd: &std::path::Path,
    raw_project_root: &str,
) -> Result<std::path::PathBuf, String> {
    let trimmed = raw_project_root.trim();
    if trimmed.is_empty() {
        return Err("Project folder is required".to_string());
    }

    let candidate = expand_home_project_path(trimmed);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    };
    std::fs::create_dir_all(&resolved).map_err(|err| err.to_string())?;
    Ok(std::fs::canonicalize(&resolved).unwrap_or(resolved))
}

#[tauri::command]
pub async fn desktop_chat_archive_session(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    active_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before hiding this session.".to_string());
    }

    if target.local_exists {
        kordi_cli::desktop_runtime::hide_session(&target.id).map_err(|err| err.to_string())?;
    }
    manager.sessions.lock().await.remove(&target.id);
    if target.canonical_exists {
        crate::canonical_sessions::archive_session(&target.id)?;
    }

    let fallback_active_session_id = if active_session_id.as_deref() == Some(target.id.as_str()) {
        None
    } else {
        active_session_id
    };
    let next_active_session_id =
        resolve_session_action_fallback_target(&cwd, fallback_active_session_id)?;
    build_chat_state(&manager, &cwd, next_active_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_delete_session_forever(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    active_session_id: Option<String>,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before deleting this session.".to_string());
    }

    {
        let mut turns = manager.turns.lock().await;
        turns.retain(|_, turn| {
            turn.snapshot
                .lock()
                .map(|snapshot| snapshot.session_id != target.id)
                .unwrap_or(true)
        });
    }
    manager.sessions.lock().await.remove(&target.id);

    if target.local_exists {
        kordi_cli::desktop_runtime::delete_session_forever(&target.id)
            .map_err(|err| err.to_string())?;
    }
    if target.canonical_exists {
        crate::canonical_sessions::delete_session(&target.id)?;
    }

    let fallback_active_session_id = if active_session_id.as_deref() == Some(target.id.as_str()) {
        None
    } else {
        active_session_id
    };
    let next_active_session_id =
        resolve_session_action_fallback_target(&cwd, fallback_active_session_id)?;
    build_chat_state(&manager, &cwd, next_active_session_id).await
}

#[tauri::command]
pub async fn desktop_chat_move_session_to_project(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    project_root: String,
) -> Result<DesktopChatState, String> {
    let cwd = chat_cwd()?;
    let target = resolve_existing_session_action_target(&session_id)?;
    if session_has_running_turn(&manager, &target.id).await {
        return Err("Stop the running task before moving this session.".to_string());
    }
    if !target.local_exists {
        return Err("Only local chat sessions can be moved to a project.".to_string());
    }

    let resolved_project_root = resolve_project_root_input(&cwd, &project_root)?;
    kordi_cli::desktop_runtime::register_project(&resolved_project_root, None)
        .map_err(|err| err.to_string())?;
    manager.sessions.lock().await.remove(&target.id);
    kordi_cli::desktop_runtime::move_session_to_project(&target.id, &resolved_project_root)
        .map_err(|err| err.to_string())?;
    build_chat_state(&manager, &cwd, target.id).await
}

#[tauri::command]
pub async fn desktop_chat_send_message(
    manager: State<'_, DesktopChatManager>,
    bridge_manager: State<'_, DesktopBridgeManager>,
    session_id: String,
    text: String,
) -> Result<DesktopChatState, String> {
    if text.trim().is_empty() {
        return Err("Message is empty".to_string());
    }

    let cwd = chat_cwd()?;
    let target_session_id =
        ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id).await?;
    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let session_handle = session;
    let (provider, model) = {
        let mut session = session_handle.lock().await;
        prepare_desktop_session_for_send(
            &mut session,
            bridge_manager.inner().clone(),
            manager.inner().clone(),
            cwd.clone(),
            &text,
        )
        .await;
        let detail = session.detail().map_err(|err| err.to_string())?;
        (detail.provider, detail.model)
    };
    ensure_provider_ready_for_send(&provider, &model, &cwd).await?;

    let turn = {
        let mut session = session_handle.lock().await;
        session
            .begin_message_streaming(text, Vec::new(), tokio_util::sync::CancellationToken::new())
            .await
            .map_err(|err| err.to_string())?
    };

    let result = turn.run(|_| {}).await.map_err(|err| err.to_string())?;
    {
        let mut session = session_handle.lock().await;
        session
            .finish_message_streaming(result)
            .map_err(|err| err.to_string())?;
    }

    build_chat_state(&manager, &cwd, target_session_id).await
}

fn normalized_message_route_value(value: Option<&String>) -> Option<&str> {
    value
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
}

fn apply_desktop_chat_message_route(
    session: &mut DesktopRuntimeSession,
    route: Option<&DesktopChatMessageRoute>,
) -> Result<(), String> {
    let Some(route) = route else {
        return Ok(());
    };

    if let Some(model) = normalized_message_route_value(route.model.as_ref()) {
        session
            .set_model(model)
            .map_err(|error| error.to_string())?;
    }
    if let (Some(auth_provider), Some(auth_choice)) = (
        normalized_message_route_value(route.auth_provider.as_ref()),
        normalized_message_route_value(route.auth_choice.as_ref()),
    ) {
        session
            .set_auth_choice(auth_provider, auth_choice)
            .map_err(|error| error.to_string())?;
    }
    if let Some(thinking) = normalized_message_route_value(route.thinking.as_ref()) {
        session
            .set_thinking(thinking)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn desktop_chat_start_message(
    manager: State<'_, DesktopChatManager>,
    bridge_manager: State<'_, DesktopBridgeManager>,
    session_id: String,
    text: String,
    attachment_paths: Option<Vec<String>>,
    route: Option<DesktopChatMessageRoute>,
) -> Result<DesktopChatTurnSnapshot, String> {
    let attachment_paths = attachment_paths.unwrap_or_default();
    if text.trim().is_empty() && attachment_paths.is_empty() {
        return Err("Message is empty".to_string());
    }

    let cwd = chat_cwd()?;
    let target_session_id =
        ensure_loaded_or_create_explicit_session(&manager, &cwd, session_id).await?;
    prune_finished_turns(&manager).await;
    if session_has_running_turn(&manager, &target_session_id).await {
        return Err(
            "This session already has a running task. Open another session to work concurrently."
                .to_string(),
        );
    }
    let turn_id = uuid::Uuid::new_v4().to_string();
    let snapshot = Arc::new(Mutex::new(DesktopChatTurnSnapshot {
        id: turn_id.clone(),
        session_id: target_session_id.clone(),
        prompt: text.trim().to_string(),
        status: "starting".to_string(),
        message: "Working…".to_string(),
        assistant_text: String::new(),
        thinking_text: String::new(),
        tools: Vec::new(),
        completed: false,
        succeeded: false,
        error: None,
        transcript_refresh_required: false,
    }));

    let cancel = tokio_util::sync::CancellationToken::new();

    {
        let mut turns = manager.turns.lock().await;
        turns.insert(
            turn_id.clone(),
            DesktopChatTurnHandle {
                snapshot: snapshot.clone(),
                cancel: cancel.clone(),
            },
        );
    }

    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };

    let snapshot_for_task = snapshot.clone();
    let bridge_manager_for_task = bridge_manager.inner().clone();
    let chat_manager_for_task = manager.inner().clone();
    let session_handle = session;
    tokio::spawn(async move {
        let (provider, model) = {
            let mut session = session_handle.lock().await;
            if let Err(error) = apply_desktop_chat_message_route(&mut session, route.as_ref()) {
                update_turn(&snapshot_for_task, |state| {
                    state.status = "failed".to_string();
                    state.message = error.clone();
                    state.completed = true;
                    state.succeeded = false;
                    state.error = Some(error);
                });
                return;
            }
            prepare_desktop_session_for_send(
                &mut session,
                bridge_manager_for_task,
                chat_manager_for_task,
                cwd.clone(),
                &text,
            )
            .await;

            let detail = session.detail().ok();
            let provider = detail
                .as_ref()
                .map(|detail| detail.provider.clone())
                .unwrap_or_default();
            let model = detail
                .as_ref()
                .map(|detail| detail.model.clone())
                .unwrap_or_default();
            (provider, model)
        };

        if let Err(error) = ensure_provider_ready_for_send(&provider, &model, &cwd).await {
            update_turn(&snapshot_for_task, |state| {
                state.status = "failed".to_string();
                state.message = error.clone();
                state.completed = true;
                state.succeeded = false;
                state.error = Some(error);
            });
            return;
        }

        let mut session = session_handle.lock().await;
        let turn = match session
            .begin_message_streaming(text, attachment_paths, cancel.clone())
            .await
        {
            Ok(turn) => turn,
            Err(err) => {
                update_turn(&snapshot_for_task, |state| {
                    state.status = "failed".to_string();
                    state.message = "Chat request failed".to_string();
                    state.completed = true;
                    state.succeeded = false;
                    state.error = Some(err.to_string());
                });
                return;
            }
        };
        drop(session);

        let turn_result = turn
            .run(|event| apply_desktop_turn_event(&snapshot_for_task, event))
            .await;
        let result = match turn_result {
            Ok(turn_result) => {
                let mut session = session_handle.lock().await;
                session.finish_message_streaming(turn_result)
            }
            Err(err) => Err(err),
        };

        match result {
            Ok(_) if cancel.is_cancelled() => {
                sync_completed_desktop_session_to_canonical(
                    &cwd,
                    &target_session_id,
                    &session_handle,
                )
                .await;
                update_turn(&snapshot_for_task, |state| {
                    state.status = "cancelled".to_string();
                    state.message = "Response stopped".to_string();
                    state.completed = true;
                    state.succeeded = false;
                    state.error = None;
                });
            }
            Ok(_) => {
                sync_completed_desktop_session_to_canonical(
                    &cwd,
                    &target_session_id,
                    &session_handle,
                )
                .await;
                update_turn(&snapshot_for_task, |state| {
                    state.status = "succeeded".to_string();
                    state.message = "Response complete".to_string();
                    state.completed = true;
                    state.succeeded = true;
                    state.error = None;
                });
            }
            Err(_err) if cancel.is_cancelled() => update_turn(&snapshot_for_task, |state| {
                state.status = "cancelled".to_string();
                state.message = "Response stopped".to_string();
                state.completed = true;
                state.succeeded = false;
                state.error = None;
            }),
            Err(err) => update_turn(&snapshot_for_task, |state| {
                state.status = "failed".to_string();
                state.message = "Chat request failed".to_string();
                state.completed = true;
                state.succeeded = false;
                state.error = Some(err.to_string());
            }),
        }
    });

    snapshot_turn(&snapshot)
}

#[tauri::command]
pub async fn desktop_chat_run_skill_command(
    manager: State<'_, DesktopChatManager>,
    session_id: String,
    text: String,
) -> Result<String, String> {
    let cwd = chat_cwd()?;
    let target_session_id = ensure_loaded_session(&manager, &cwd, Some(session_id)).await?;
    let session = {
        let sessions = manager.sessions.lock().await;
        sessions
            .get(&target_session_id)
            .cloned()
            .ok_or_else(|| "Session is unavailable".to_string())?
    };
    let mut session = session.lock().await;
    session
        .run_skill_command(&text)
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "Not a skill command".to_string())
}

#[tauri::command]
pub async fn desktop_chat_cancel_turn(
    manager: State<'_, DesktopChatManager>,
    turn_id: String,
) -> Result<DesktopChatTurnSnapshot, String> {
    let turns = manager.turns.lock().await;
    let turn = turns
        .get(&turn_id)
        .ok_or_else(|| format!("Unknown chat turn: {turn_id}"))?;
    turn.cancel.cancel();
    update_turn(&turn.snapshot, |state| {
        if !state.completed {
            state.status = "cancelled".to_string();
            state.message = "Response stopped".to_string();
            state.completed = true;
            state.succeeded = false;
            state.error = None;
        }
    });
    snapshot_turn(&turn.snapshot)
}

#[tauri::command]
pub async fn desktop_chat_turn_state(
    manager: State<'_, DesktopChatManager>,
    turn_id: String,
) -> Result<DesktopChatTurnSnapshot, String> {
    let turns = manager.turns.lock().await;
    let snapshot = turns
        .get(&turn_id)
        .ok_or_else(|| format!("Unknown chat turn: {turn_id}"))?;
    snapshot_turn(&snapshot.snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kordi_cli::desktop_runtime::{DesktopChatContextWindowStatus, DesktopChatMessage};

    #[test]
    fn auto_compaction_status_detection_matches_turn_runner_messages() {
        assert!(is_auto_compaction_success_status(
            "Auto-compacted session: 10 summarized, 5 kept, 12345 tokens before"
        ));
        assert!(is_auto_compaction_failure_status(
            "Auto-compaction failed: provider quota exceeded"
        ));
        assert!(!is_auto_compaction_success_status(
            "Compacted session manually"
        ));
        assert!(!is_auto_compaction_failure_status(
            "Auto-compacted session: ok"
        ));
    }

    #[test]
    fn local_agent_mentions_do_not_enable_bridge_outreach() {
        let labels = vec!["Kordi".to_string(), "issue-63-agent-outreach".to_string()];

        assert!(!text_mentions_non_local_target("@Kordi hi", &labels));
        assert!(!text_mentions_non_local_target(
            "@issue-63-agent-outreach hi",
            &labels
        ));
        assert!(text_mentions_non_local_target(
            "@Shenzhehere's Kordi hi",
            &labels
        ));
    }

    #[tokio::test]
    async fn running_turn_lookup_is_session_scoped() {
        let manager = DesktopChatManager::default();
        let snapshot = Arc::new(Mutex::new(DesktopChatTurnSnapshot {
            id: "turn-a".to_string(),
            session_id: "session-a".to_string(),
            prompt: "work".to_string(),
            status: "processing".to_string(),
            message: "Working…".to_string(),
            assistant_text: String::new(),
            thinking_text: String::new(),
            tools: Vec::new(),
            completed: false,
            succeeded: false,
            error: None,
            transcript_refresh_required: false,
        }));
        manager.turns.lock().await.insert(
            "turn-a".to_string(),
            DesktopChatTurnHandle {
                snapshot,
                cancel: tokio_util::sync::CancellationToken::new(),
            },
        );

        assert!(session_has_running_turn(&manager, "session-a").await);
        assert!(!session_has_running_turn(&manager, "session-b").await);
    }

    #[test]
    fn desktop_canonical_sync_state_omits_active_agent_tail_while_live_turn_runs() {
        let mut state = DesktopChatState {
            cwd: "/tmp/workspace".to_string(),
            active_session_id: "session:local".to_string(),
            sessions: vec![DesktopChatSessionSummary {
                id: "session:local".to_string(),
                title: "Check disk".to_string(),
                subtitle: "Check disk".to_string(),
                updated_at_label: "Now".to_string(),
                message_count: 2,
                draft: false,
            }],
            projects: Vec::new(),
            active_session: DesktopChatSessionDetail {
                id: "session:local".to_string(),
                title: "Check disk".to_string(),
                subtitle: "Check disk".to_string(),
                provider: "openai".to_string(),
                provider_label: "OpenAI".to_string(),
                model: "gpt-5".to_string(),
                model_label: "gpt-5".to_string(),
                thinking: "medium".to_string(),
                thinking_label: "Medium".to_string(),
                thinking_levels: Vec::new(),
                updated_at_label: "Now".to_string(),
                message_count: 2,
                draft: false,
                cache_monitor_text: None,
                context_window_text: "0 / 0".to_string(),
                context_window_status: DesktopChatContextWindowStatus {
                    context_window: 0,
                    used_tokens: None,
                    used_percent: None,
                    auto_compaction: false,
                    compaction_threshold_percent: 90,
                },
                project: None,
                messages: vec![
                    DesktopChatMessage {
                        role: "user".to_string(),
                        sender: Some("You".to_string()),
                        text: "check disk".to_string(),
                        detail: None,
                        time_label: "Now".to_string(),
                        timestamp_ms: 1,
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: None,
                        tools: Vec::new(),
                    },
                    DesktopChatMessage {
                        role: "assistant".to_string(),
                        sender: Some("Kordi".to_string()),
                        text: "I’ll check disk usage.".to_string(),
                        detail: Some("openai/gpt-5 • tool use".to_string()),
                        time_label: "Now".to_string(),
                        timestamp_ms: 2,
                        failed: false,
                        attachments: Vec::new(),
                        thinking_text: Some("Checking disk usage".to_string()),
                        tools: Vec::new(),
                    },
                ],
            },
            local_agent: DesktopChatAgentProfile {
                label: "Kordi".to_string(),
                system_prompt: String::new(),
                loaded_skills: Vec::new(),
                loaded_tools: Vec::new(),
                loaded_plugins: Vec::new(),
                identity_files: Vec::new(),
                default_provider: "openai".to_string(),
                default_model: "gpt-5".to_string(),
                workspace_root: "/tmp/workspace".to_string(),
                last_activities: Vec::new(),
            },
            model_options: Vec::new(),
            slash_commands: Vec::new(),
        };

        let sync_state = desktop_state_for_canonical_sync(&state, true);
        assert_eq!(sync_state.active_session.messages.len(), 1);
        assert_eq!(sync_state.active_session.messages[0].role, "user");

        state.active_session.messages.push(DesktopChatMessage {
            role: "system".to_string(),
            sender: None,
            text: "Session note".to_string(),
            detail: None,
            time_label: "Now".to_string(),
            timestamp_ms: 3,
            failed: false,
            attachments: Vec::new(),
            thinking_text: None,
            tools: Vec::new(),
        });
        let completed_sync_state = desktop_state_for_canonical_sync(&state, false);
        assert_eq!(completed_sync_state.active_session.messages.len(), 3);
    }

    #[test]
    fn completed_desktop_session_sync_state_preserves_agent_runtime_details() {
        let detail = DesktopChatSessionDetail {
            id: "session:bridge:humans:test".to_string(),
            title: "Check repo".to_string(),
            subtitle: "Check repo".to_string(),
            provider: "openai".to_string(),
            provider_label: "OpenAI".to_string(),
            model: "gpt-5.5".to_string(),
            model_label: "gpt-5.5".to_string(),
            thinking: "medium".to_string(),
            thinking_label: "Medium".to_string(),
            thinking_levels: Vec::new(),
            updated_at_label: "Now".to_string(),
            message_count: 2,
            draft: false,
            cache_monitor_text: None,
            context_window_text: "0 / 0".to_string(),
            context_window_status: DesktopChatContextWindowStatus {
                context_window: 0,
                used_tokens: None,
                used_percent: None,
                auto_compaction: false,
                compaction_threshold_percent: 90,
            },
            project: None,
            messages: vec![
                DesktopChatMessage {
                    role: "user".to_string(),
                    sender: Some("You".to_string()),
                    text: "@Kordi check again".to_string(),
                    detail: None,
                    time_label: "Now".to_string(),
                    timestamp_ms: 1,
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: None,
                    tools: Vec::new(),
                },
                DesktopChatMessage {
                    role: "assistant".to_string(),
                    sender: Some("Kordi".to_string()),
                    text: "Checked again.".to_string(),
                    detail: Some("openai/gpt-5.5 • tool use".to_string()),
                    time_label: "Now".to_string(),
                    timestamp_ms: 2,
                    failed: false,
                    attachments: Vec::new(),
                    thinking_text: Some("Need to re-check the repo".to_string()),
                    tools: vec![kordi_cli::desktop_runtime::DesktopChatStoredTool {
                        id: "tool-1".to_string(),
                        name: "web_fetch".to_string(),
                        status: "complete".to_string(),
                        arguments: "{}".to_string(),
                        live_output: String::new(),
                        result_text: Some("repo page".to_string()),
                        detail: None,
                        is_error: false,
                    }],
                },
            ],
        };
        let local_agent = DesktopChatAgentProfile {
            label: "Kordi".to_string(),
            system_prompt: String::new(),
            loaded_skills: Vec::new(),
            loaded_tools: Vec::new(),
            loaded_plugins: Vec::new(),
            identity_files: Vec::new(),
            default_provider: "openai".to_string(),
            default_model: "gpt-5".to_string(),
            workspace_root: "/tmp/workspace".to_string(),
            last_activities: Vec::new(),
        };

        let sync_state = completed_desktop_session_state_for_canonical_sync(
            Path::new("/tmp/workspace"),
            "session:bridge:humans:test",
            detail,
            local_agent,
        );

        let assistant = sync_state
            .active_session
            .messages
            .iter()
            .find(|message| message.role == "assistant")
            .expect("assistant message is retained after completion");
        assert_eq!(
            assistant.thinking_text.as_deref(),
            Some("Need to re-check the repo")
        );
        assert_eq!(assistant.tools.len(), 1);
    }

    #[test]
    fn reach_out_requires_current_explicit_non_local_target() {
        let labels = vec!["Kordi".to_string(), "issue-63-agent-outreach".to_string()];

        assert!(!reach_out_target_allowed_by_user_text(
            "@Kordi hi",
            "Kordi",
            &labels
        ));
        assert!(!reach_out_target_allowed_by_user_text(
            "@Kordi hi",
            "Shenzhehere's Kordi",
            &labels
        ));
        assert!(reach_out_target_allowed_by_user_text(
            "@Shenzhehere's Kordi hi",
            "Shenzhehere's Kordi",
            &labels
        ));
    }
}
