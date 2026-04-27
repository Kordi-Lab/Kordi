use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::State;

use kordi_cli::desktop_runtime::{
    DesktopChatAgentProfile, DesktopChatModelOption, DesktopChatProjectGroup,
    DesktopChatSessionDetail, DesktopChatSessionSummary, DesktopChatSlashCommand,
    DesktopRuntimeSession,
};
use kordi_core::error::KordiError;
use kordi_tools::ReachOutRuntime;

use crate::bridge::{
    desktop_bridge_outreach_prompt_context, desktop_bridge_reach_out_impl, DesktopBridgeManager,
};
use kordi_cli::turn_runner::TurnEvent;

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

fn attachment_storage_dir() -> Result<PathBuf, String> {
    let dir = std::env::var_os("APP_DATA_DIR")
        .map(PathBuf::from)
        .map(|path| path.join("tmp").join("attachments"))
        .unwrap_or_else(|| std::env::temp_dir().join("kordi-desktop-attachments"));
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn artifact_base_path(base_root: Option<&str>) -> Result<PathBuf, String> {
    base_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_home_project_path)
        .map(Ok)
        .unwrap_or_else(chat_cwd)
}

fn project_root_is_set(base_root: Option<&str>) -> bool {
    base_root
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir | Component::Normal(_) => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn ensure_artifact_path_within_base(
    resolved_path: PathBuf,
    base_root: Option<&str>,
) -> Result<PathBuf, String> {
    if !project_root_is_set(base_root) {
        return Ok(resolved_path);
    }

    let base_path = artifact_base_path(base_root)?;
    let base_path =
        std::fs::canonicalize(&base_path).unwrap_or_else(|_| normalize_path_lexically(&base_path));
    let canonical_path = std::fs::canonicalize(&resolved_path)
        .unwrap_or_else(|_| normalize_path_lexically(&resolved_path));
    if !canonical_path.starts_with(&base_path) {
        return Err(format!(
            "Artifact path is outside the project root: {}",
            resolved_path.display()
        ));
    }

    Ok(resolved_path)
}

fn resolve_artifact_preview_path(
    raw_path: &str,
    base_root: Option<&str>,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Artifact path is required".to_string());
    }

    let candidate = expand_home_project_path(trimmed);
    let resolved_path = if candidate.is_absolute() {
        candidate
    } else {
        artifact_base_path(base_root)?.join(candidate)
    };

    ensure_artifact_path_within_base(resolved_path, base_root)
}

fn resolve_artifact_directory_path(
    raw_path: Option<&str>,
    base_root: Option<&str>,
) -> Result<PathBuf, String> {
    let base = artifact_base_path(base_root)?;
    let Some(trimmed) = raw_path.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(base);
    };

    let candidate = expand_home_project_path(trimmed);
    if candidate.is_absolute() {
        Ok(candidate)
    } else {
        Ok(base.join(candidate))
    }
}

fn artifact_file_kind(path: &Path) -> &'static str {
    let Some(extension) = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_lowercase)
    else {
        return "file";
    };
    match extension.as_str() {
        "c" | "cc" | "cpp" | "cs" | "css" | "go" | "h" | "hpp" | "html" | "java" | "js"
        | "json" | "jsx" | "kt" | "mjs" | "php" | "py" | "rb" | "rs" | "scss" | "sh" | "sql"
        | "swift" | "toml" | "ts" | "tsx" | "vue" | "xml" | "yaml" | "yml" => "code",
        "adoc" | "csv" | "ipynb" | "markdown" | "md" | "mdx" | "pdf" | "rst" | "rtf" | "txt" => {
            "document"
        }
        _ => "file",
    }
}

fn snapshot_turn(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
) -> Result<DesktopChatTurnSnapshot, String> {
    snapshot
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "Chat turn state is unavailable".to_string())
}

fn update_turn(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    apply: impl FnOnce(&mut DesktopChatTurnSnapshot),
) {
    if let Ok(mut guard) = snapshot.lock() {
        apply(&mut guard);
    }
}

fn turn_matches_running_session(
    snapshot: &Arc<Mutex<DesktopChatTurnSnapshot>>,
    session_id: &str,
) -> bool {
    snapshot
        .lock()
        .map(|turn| turn.session_id == session_id && !turn.completed)
        .unwrap_or(false)
}

async fn prune_finished_turns(manager: &DesktopChatManager) {
    let mut turns = manager.turns.lock().await;
    turns.retain(|_, turn| {
        turn.snapshot
            .lock()
            .map(|snapshot| !snapshot.completed)
            .unwrap_or(false)
    });
}

async fn session_has_running_turn(manager: &DesktopChatManager, session_id: &str) -> bool {
    let turns = manager.turns.lock().await;
    turns
        .values()
        .any(|turn| turn_matches_running_session(&turn.snapshot, session_id))
}

fn content_blocks_to_text(content: &[kordi_core::types::ContentBlock]) -> String {
    let text = content
        .iter()
        .filter_map(|block| match block {
            kordi_core::types::ContentBlock::Text { text } => Some(text.as_str()),
            kordi_core::types::ContentBlock::Image { .. } => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    if text.trim().is_empty() {
        "(no text output)".to_string()
    } else {
        text
    }
}

fn tool_detail(details: &Option<serde_json::Value>) -> Option<String> {
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

fn session_exists_globally(session_id: &str) -> Result<bool, String> {
    kordi_cli::desktop_runtime::session_exists(session_id).map_err(|err| err.to_string())
}

fn is_blank_draft_summary(summary: &DesktopChatSessionSummary) -> bool {
    summary.draft && summary.message_count == 0
}

fn filter_blank_draft_projects(
    projects: Vec<DesktopChatProjectGroup>,
) -> Vec<DesktopChatProjectGroup> {
    // Project creation itself is explicit, and the Projects page can now create an
    // empty project session before the first message. Keep those draft project
    // rows visible so a user-created project session does not become an orphan.
    projects
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
    let model_options = kordi_cli::desktop_runtime::authenticated_model_options(cwd).await;
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
    if let Err(error) = crate::canonical_sessions::sync_desktop_chat_state(&state) {
        eprintln!("Unable to sync desktop chat into canonical sessions: {error}");
    }
    Ok(state)
}

#[tauri::command]
pub async fn desktop_chat_store_attachment(name: String, data: Vec<u8>) -> Result<String, String> {
    let safe_name = std::path::Path::new(&name)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment.bin");
    let stem = std::path::Path::new(safe_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("attachment");
    let extension = std::path::Path::new(safe_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let path =
        attachment_storage_dir()?.join(format!("{}-{}{}", stem, uuid::Uuid::new_v4(), extension));
    std::fs::write(&path, data).map_err(|err| err.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn desktop_chat_artifact_preview(
    path: String,
    base_root: Option<String>,
) -> Result<DesktopChatArtifactPreview, String> {
    const MAX_PREVIEW_BYTES: usize = 64 * 1024;
    const MAX_PREVIEW_LINES: usize = 400;

    let resolved_path = resolve_artifact_preview_path(&path, base_root.as_deref())?;
    let bytes = std::fs::read(&resolved_path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            format!("Artifact file not found: {}", resolved_path.display())
        } else {
            format!(
                "Unable to read artifact preview for {}: {err}",
                resolved_path.display()
            )
        }
    })?;
    let mut truncated = bytes.len() > MAX_PREVIEW_BYTES;
    let preview_bytes = if truncated {
        &bytes[..MAX_PREVIEW_BYTES]
    } else {
        bytes.as_slice()
    };
    let preview_text = String::from_utf8_lossy(preview_bytes).into_owned();

    if preview_text.contains('\u{0000}') {
        return Err(
            "This artifact looks like a binary file and can't be previewed here.".to_string(),
        );
    }

    let mut lines = Vec::new();
    if !preview_text.is_empty() {
        for (index, line) in preview_text.split('\n').enumerate() {
            if index >= MAX_PREVIEW_LINES {
                truncated = true;
                break;
            }

            lines.push(DesktopChatArtifactPreviewLine {
                number: index + 1,
                text: line.strip_suffix('\r').unwrap_or(line).to_string(),
            });
        }
    }

    Ok(DesktopChatArtifactPreview {
        path: resolved_path.display().to_string(),
        lines,
        truncated,
    })
}

#[tauri::command]
pub async fn desktop_chat_artifact_directory(
    path: Option<String>,
    base_root: Option<String>,
) -> Result<DesktopArtifactDirectory, String> {
    const MAX_DIRECTORY_ENTRIES: usize = 500;

    let requested_path = resolve_artifact_directory_path(path.as_deref(), base_root.as_deref())?;
    let directory_path = if requested_path.is_file() {
        requested_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Artifact file has no parent folder".to_string())?
    } else {
        requested_path
    };
    if !directory_path.exists() {
        return Err(format!("Folder not found: {}", directory_path.display()));
    }
    if !directory_path.is_dir() {
        return Err(format!(
            "Path is not a folder: {}",
            directory_path.display()
        ));
    }

    let directory_path = std::fs::canonicalize(&directory_path).unwrap_or(directory_path);
    let base_path = artifact_base_path(base_root.as_deref())?;
    let base_path = std::fs::canonicalize(&base_path).unwrap_or(base_path);
    let has_project_root = project_root_is_set(base_root.as_deref());
    if has_project_root && !directory_path.starts_with(&base_path) {
        return Err(format!(
            "Folder is outside the project root: {}",
            directory_path.display()
        ));
    }
    let parent_path = directory_path.parent().and_then(|parent| {
        if directory_path == base_path || !parent.starts_with(&base_path) {
            None
        } else {
            Some(parent.display().to_string())
        }
    });

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory_path).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let entry_path = entry.path();
        let name = entry.file_name().to_string_lossy().trim().to_string();
        if name.is_empty() || name == ".DS_Store" {
            continue;
        }
        let metadata = entry.metadata().map_err(|err| err.to_string())?;
        let is_directory = metadata.is_dir();
        entries.push(DesktopArtifactDirectoryEntry {
            name,
            path: entry_path.display().to_string(),
            kind: if is_directory {
                "directory"
            } else {
                artifact_file_kind(&entry_path)
            }
            .to_string(),
            is_directory,
            size_bytes: (!is_directory).then_some(metadata.len()),
        });
    }

    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    entries.truncate(MAX_DIRECTORY_ENTRIES);

    Ok(DesktopArtifactDirectory {
        path: directory_path.display().to_string(),
        parent_path,
        entries,
    })
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
    let target_session_id = ensure_loaded_session(&manager, &cwd, Some(session_id)).await?;
    let session = {
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
    let mut session = session.lock().await;
    prepare_desktop_session_for_send(
        &mut session,
        bridge_manager.inner().clone(),
        manager.inner().clone(),
        cwd.clone(),
        &text,
    )
    .await;
    session
        .send_message(text, Vec::new())
        .await
        .map_err(|err| err.to_string())?;
    drop(session);

    build_chat_state(&manager, &cwd, target_session_id).await
}

async fn ensure_bridge_agent_execution_session(
    manager: &DesktopChatManager,
    cwd: &std::path::Path,
) -> Result<(String, DesktopSessionHandle), String> {
    let persisted =
        kordi_cli::desktop_runtime::list_session_summaries(cwd).map_err(|err| err.to_string())?;

    if let Some(session_id) = persisted.first().map(|session| session.id.clone()) {
        let mut sessions = manager.sessions.lock().await;
        if let Some(handle) = sessions.get(&session_id).cloned() {
            return Ok((session_id, handle));
        }
        let runtime = DesktopRuntimeSession::resume(cwd.to_path_buf(), &session_id)
            .await
            .map_err(|err| err.to_string())?;
        let handle = Arc::new(tokio::sync::Mutex::new(runtime));
        sessions.insert(session_id.clone(), handle.clone());
        return Ok((session_id, handle));
    }

    let mut runtime = DesktopRuntimeSession::create_new(cwd.to_path_buf())
        .await
        .map_err(|err| err.to_string())?;
    runtime
        .materialize_session()
        .map_err(|err| err.to_string())?;
    let session_id = runtime.session_id().to_string();
    let handle = Arc::new(tokio::sync::Mutex::new(runtime));
    let mut sessions = manager.sessions.lock().await;
    sessions.insert(session_id.clone(), handle.clone());
    Ok((session_id, handle))
}

pub(crate) async fn run_bridge_agent_prompt(
    manager: &DesktopChatManager,
    local_agent_node_id: &str,
    peer_node_id: &str,
    prompt: String,
) -> Result<DesktopChatTurnSnapshot, String> {
    let cwd = bridge_agent_session_cwd(local_agent_node_id, peer_node_id)?;
    let (target_session_id, session) = ensure_bridge_agent_execution_session(manager, &cwd).await?;
    let execution_session_id = target_session_id.clone();

    let snapshot = Arc::new(Mutex::new(DesktopChatTurnSnapshot {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: target_session_id,
        prompt: prompt.trim().to_string(),
        status: "processing".to_string(),
        message: "Processing…".to_string(),
        assistant_text: String::new(),
        thinking_text: String::new(),
        tools: Vec::new(),
        completed: false,
        succeeded: false,
        error: None,
    }));

    let result = {
        let mut session = session.lock().await;
        session.send_message(prompt, Vec::new()).await
    };

    match result {
        Ok(detail) => {
            let assistant = detail
                .messages
                .iter()
                .rev()
                .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
                .cloned();
            update_turn(&snapshot, |state| {
                state.status = "complete".to_string();
                state.message = "Response complete".to_string();
                state.completed = true;
                state.succeeded = assistant.is_some();
                if let Some(message) = assistant {
                    state.assistant_text = message.text;
                    state.thinking_text = message.thinking_text.unwrap_or_default();
                    state.tools = message
                        .tools
                        .into_iter()
                        .map(|tool| DesktopChatToolSnapshot {
                            id: tool.id,
                            name: tool.name,
                            status: tool.status,
                            arguments: tool.arguments,
                            live_output: tool.live_output,
                            result_text: tool.result_text,
                            detail: tool.detail,
                            is_error: tool.is_error,
                        })
                        .collect();
                } else {
                    state.status = "failed".to_string();
                    state.message = "Bridge agent returned no text response".to_string();
                    state.error = Some("Bridge agent returned no text response".to_string());
                }
            });
        }
        Err(error) => {
            let message = error.to_string();
            update_turn(&snapshot, |state| {
                state.status = "failed".to_string();
                state.message = message.clone();
                state.completed = true;
                state.succeeded = false;
                state.error = Some(message.clone());
            });
        }
    }

    {
        let mut sessions = manager.sessions.lock().await;
        sessions.remove(&execution_session_id);
    }
    drop(session);
    let _ = kordi_cli::desktop_runtime::delete_session_forever(&execution_session_id);

    snapshot_turn(&snapshot)
}

#[tauri::command]
pub async fn desktop_chat_start_message(
    manager: State<'_, DesktopChatManager>,
    bridge_manager: State<'_, DesktopBridgeManager>,
    session_id: String,
    text: String,
    attachment_paths: Option<Vec<String>>,
) -> Result<DesktopChatTurnSnapshot, String> {
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
    let attachment_paths = attachment_paths.unwrap_or_default();
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
    tokio::spawn(async move {
        let mut session = session.lock().await;
        prepare_desktop_session_for_send(
            &mut session,
            bridge_manager_for_task,
            chat_manager_for_task,
            cwd,
            &text,
        )
        .await;

        let result =
            session
                .send_message_streaming(text, attachment_paths, cancel.clone(), |event| match event
                {
                    TurnEvent::TurnStart { .. } => update_turn(&snapshot_for_task, |state| {
                        state.status = "streaming".to_string();
                        state.message = "Working…".to_string();
                    }),
                    TurnEvent::TextDelta(text) => update_turn(&snapshot_for_task, |state| {
                        state.status = "writing".to_string();
                        state.message = "Writing response…".to_string();
                        state.assistant_text.push_str(text);
                    }),
                    TurnEvent::ThinkingDelta(text) => update_turn(&snapshot_for_task, |state| {
                        state.status = "thinking".to_string();
                        state.message = "Thinking…".to_string();
                        state.thinking_text.push_str(text);
                    }),
                    TurnEvent::ToolCallStart { id, name } => {
                        update_turn(&snapshot_for_task, |state| {
                            state.status = "tooling".to_string();
                            state.message = "Working…".to_string();
                            state.tools.push(DesktopChatToolSnapshot {
                                id: id.clone(),
                                name: name.clone(),
                                status: "preparing".to_string(),
                                arguments: String::new(),
                                live_output: String::new(),
                                result_text: None,
                                detail: None,
                                is_error: false,
                            });
                        })
                    }
                    TurnEvent::ToolCallDelta { id, args } => {
                        update_turn(&snapshot_for_task, |state| {
                            if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                                tool.arguments.push_str(args);
                            }
                        })
                    }
                    TurnEvent::ToolExecuting { id } => update_turn(&snapshot_for_task, |state| {
                        state.status = "tooling".to_string();
                        state.message = "Running tool…".to_string();
                        if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                            tool.status = "running".to_string();
                        }
                    }),
                    TurnEvent::ToolOutputDelta { id, chunk } => {
                        update_turn(&snapshot_for_task, |state| {
                            if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                                tool.status = "running".to_string();
                                tool.live_output.push_str(chunk);
                            }
                        })
                    }
                    TurnEvent::ToolResult {
                        id,
                        content,
                        details,
                        is_error,
                        ..
                    } => update_turn(&snapshot_for_task, |state| {
                        state.status = "tooling".to_string();
                        state.message = if *is_error {
                            "Tool failed".to_string()
                        } else {
                            "Tool finished".to_string()
                        };
                        if let Some(tool) = state.tools.iter_mut().find(|tool| tool.id == *id) {
                            tool.status = if *is_error {
                                "error".to_string()
                            } else {
                                "done".to_string()
                            };
                            tool.result_text = Some(content_blocks_to_text(content));
                            tool.detail = tool_detail(details);
                            tool.is_error = *is_error;
                            tool.live_output.clear();
                        }
                    }),
                    TurnEvent::TurnEnd => update_turn(&snapshot_for_task, |state| {
                        state.status = "finalizing".to_string();
                        state.message = "Finalizing response…".to_string();
                    }),
                    TurnEvent::ContextOverflow { message } | TurnEvent::Error(message) => {
                        update_turn(&snapshot_for_task, |state| {
                            state.status = "failed".to_string();
                            state.message = message.clone();
                            state.error = Some(message.clone());
                        })
                    }
                    TurnEvent::AutoRetryStart {
                        attempt,
                        max_attempts,
                        ..
                    } => update_turn(&snapshot_for_task, |state| {
                        state.status = "retrying".to_string();
                        state.message = format!("Retrying request ({attempt}/{max_attempts})…");
                    }),
                    TurnEvent::AutoRetryEnd => update_turn(&snapshot_for_task, |state| {
                        state.status = "streaming".to_string();
                        state.message = "Retry complete. Continuing…".to_string();
                    }),
                    TurnEvent::AutoCompactionStart => update_turn(&snapshot_for_task, |state| {
                        state.status = "compacting".to_string();
                        state.message = "Compressing conversation…".to_string();
                    }),
                    TurnEvent::Status(message)
                        if message.starts_with("Auto-compacted session:") =>
                    {
                        update_turn(&snapshot_for_task, |state| {
                            state.status = "compacted".to_string();
                            state.message = "Conversation compressed. Continuing…".to_string();
                        })
                    }
                    TurnEvent::Status(message)
                        if message.starts_with("Auto-compaction failed:") =>
                    {
                        update_turn(&snapshot_for_task, |state| {
                            state.status = "compaction_failed".to_string();
                            state.message = message.clone();
                            state.error = Some(message.clone());
                        })
                    }
                    TurnEvent::Done { .. } | TurnEvent::Status(_) => {}
                })
                .await;

        match result {
            Ok(_) if cancel.is_cancelled() => update_turn(&snapshot_for_task, |state| {
                state.status = "cancelled".to_string();
                state.message = "Response stopped".to_string();
                state.completed = true;
                state.succeeded = false;
                state.error = None;
            }),
            Ok(_) => update_turn(&snapshot_for_task, |state| {
                state.status = "succeeded".to_string();
                state.message = "Response complete".to_string();
                state.completed = true;
                state.succeeded = true;
                state.error = None;
            }),
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
