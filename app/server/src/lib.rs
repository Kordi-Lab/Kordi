use anyhow::{Context, Result};
use async_trait::async_trait;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use directories::BaseDirs;
use kordi_core::config;
use kordi_core::settings::Settings;
use kordi_core::types::{AgentMessage, AssistantContent, ContentBlock, SessionEntry};
use kordi_protocol::{
    APP_PROTOCOL_VERSION, BootstrapSnapshot, ClientKind, ClientMetadata, FeatureFlags,
    ForkSessionRequest, ForkSessionResponse, ModelSelector, ServerMetadata, ServiceSnapshot,
    ServiceState, ServiceStatusSummary, SessionDetail, SessionForksPage, SessionSource,
    SessionStatus, SessionSummary, SessionsPage, SubmitTurnAccepted, SubmitTurnRequest,
    ThinkingLevel, TimelineEntry, TimelineEntryKind, TimelineRole, TimelineState, WorkspaceSummary,
};
use kordi_session::store;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Clone)]
pub struct AppServer {
    state: Arc<AppState>,
}

#[derive(Clone)]
struct AppState {
    cwd: PathBuf,
    sessions_db_path: PathBuf,
    bridges_status: Arc<dyn BridgesStatusProvider>,
    turn_executor: Arc<dyn TurnExecutor>,
    active_turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
}

#[derive(Clone, Debug)]
struct ActiveTurn {
    turn_id: String,
}

#[derive(Clone, Debug)]
struct TurnCommand {
    program: String,
    base_args: Vec<String>,
    current_dir: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct TurnExecution {
    turn_id: String,
    session_id: String,
    cwd: PathBuf,
    input: String,
    model: Option<ModelSelector>,
    thinking: Option<ThinkingLevel>,
}

#[derive(Debug, Clone, Deserialize)]
struct ListSessionsQuery {
    limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgesDaemonConfig {
    #[serde(default = "default_bridges_port")]
    local_api_port: u16,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgesStatusResponse {
    node_id: String,
    healthy: bool,
    daemon: BridgesDaemonStatus,
    coordination: BridgesComponentStatus,
    runtime: BridgesComponentStatus,
    reachability: BridgesReachabilityStatus,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgesDaemonStatus {
    state: String,
    started_at: String,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgesComponentStatus {
    state: String,
    detail: Option<String>,
    checked_at: String,
}

#[derive(Debug, Clone, Deserialize)]
struct BridgesReachabilityStatus {
    mode: String,
    endpoint_hints_published: usize,
    derp_connected: bool,
    mailbox_fallback: bool,
    mailbox_durable: bool,
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn internal(error: impl std::fmt::Display) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: error.to_string(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "error": self.message,
            })),
        )
            .into_response()
    }
}

type AppResult<T> = std::result::Result<T, AppError>;

#[async_trait]
trait BridgesStatusProvider: Send + Sync {
    async fn fetch_status(&self) -> Result<BridgesStatusResponse>;
}

#[async_trait]
trait TurnExecutor: Send + Sync {
    async fn run_turn(&self, execution: TurnExecution) -> Result<()>;
}

#[derive(Clone)]
struct HttpBridgesStatusProvider {
    client: reqwest::Client,
    base_url: String,
}

#[async_trait]
impl BridgesStatusProvider for HttpBridgesStatusProvider {
    async fn fetch_status(&self) -> Result<BridgesStatusResponse> {
        let response = self
            .client
            .get(format!("{}/status", self.base_url))
            .send()
            .await
            .with_context(|| format!("requesting Bridges status from {}", self.base_url))?
            .error_for_status()
            .with_context(|| format!("Bridges status request to {} failed", self.base_url))?;

        response
            .json::<BridgesStatusResponse>()
            .await
            .context("decoding Bridges status response")
    }
}

#[derive(Clone)]
struct ProcessTurnExecutor {
    command: TurnCommand,
}

#[async_trait]
impl TurnExecutor for ProcessTurnExecutor {
    async fn run_turn(&self, execution: TurnExecution) -> Result<()> {
        let mut command = tokio::process::Command::new(&self.command.program);
        command.args(&self.command.base_args);
        if let Some(current_dir) = &self.command.current_dir {
            command.current_dir(current_dir);
        }

        command
            .arg("-C")
            .arg(&execution.cwd)
            .arg("-p")
            .arg("--session")
            .arg(&execution.session_id);

        if let Some(model) = &execution.model {
            command.arg("--model").arg(format_cli_model(model));
        }

        let thinking = execution.thinking.clone().or_else(|| {
            execution
                .model
                .as_ref()
                .and_then(|model| model.reasoning.clone())
        });
        if let Some(thinking) = thinking {
            command
                .arg("--thinking")
                .arg(protocol_thinking_level(&thinking));
        }

        command
            .arg(&execution.input)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let output = command.output().await.with_context(|| {
            format!(
                "starting turn {} with {}",
                execution.turn_id,
                describe_turn_command(&self.command)
            )
        })?;

        if output.status.success() {
            return Ok(());
        }

        let stdout = trim_command_output(&String::from_utf8_lossy(&output.stdout));
        let stderr = trim_command_output(&String::from_utf8_lossy(&output.stderr));
        let status = output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated by signal".to_string());

        anyhow::bail!(
            "turn {} failed for session {} (status {}): stdout='{}' stderr='{}'",
            execution.turn_id,
            execution.session_id,
            status,
            stdout,
            stderr,
        );
    }
}

impl AppServer {
    pub fn from_cwd(cwd: PathBuf) -> Result<Self> {
        let cwd = std::fs::canonicalize(&cwd)
            .with_context(|| format!("canonicalizing cwd {}", cwd.display()))?;
        let global_settings = Settings::load_global();
        let sessions_db_path = config::session_db_path(&global_settings.storage);
        let bridges_base_url = resolve_bridges_base_url();
        let turn_command = resolve_turn_command();

        Ok(Self {
            state: Arc::new(AppState {
                cwd,
                sessions_db_path,
                bridges_status: Arc::new(HttpBridgesStatusProvider {
                    client: reqwest::Client::new(),
                    base_url: bridges_base_url,
                }),
                turn_executor: Arc::new(ProcessTurnExecutor {
                    command: turn_command,
                }),
                active_turns: Arc::new(Mutex::new(HashMap::new())),
            }),
        })
    }

    pub async fn serve(&self, listen: SocketAddr) -> Result<()> {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .with_context(|| format!("binding app server on {}", listen))?;
        tracing::info!("kordi app server listening on {}", listen);
        axum::serve(listener, self.router())
            .await
            .context("serving app server")
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/bootstrap", get(handle_bootstrap))
            .route("/v1/sessions", get(handle_sessions))
            .route("/v1/sessions/:session_id", get(handle_session_detail))
            .route(
                "/v1/sessions/:session_id/forks",
                get(handle_session_forks).post(handle_fork_session),
            )
            .route("/v1/sessions/:session_id/turns", post(handle_submit_turn))
            .with_state(self.state.clone())
    }
}

async fn handle_bootstrap(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<BootstrapSnapshot>> {
    let settings = Settings::load_merged(&state.cwd);
    let active_turns = active_turn_sessions(&state).await;
    let sessions = load_sessions_page(&state, 1, &active_turns).map_err(AppError::internal)?;
    let services = build_services_snapshot(&state).await;

    Ok(Json(BootstrapSnapshot {
        server: ServerMetadata {
            protocol_version: APP_PROTOCOL_VERSION.to_string(),
            server_name: "kordi-app-server".to_string(),
            server_version: env!("CARGO_PKG_VERSION").to_string(),
            transport: "http+sse".to_string(),
        },
        client: client_metadata_from_headers(&headers),
        workspace: WorkspaceSummary {
            cwd: state.cwd.display().to_string(),
            root_name: workspace_root_name(&state.cwd),
            platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            execution_mode: settings.resolved_execution_mode().as_str().to_string(),
        },
        services,
        features: FeatureFlags {
            session_streaming: false,
            tool_approval: false,
            projects: false,
            peers: false,
        },
        current_session_id: sessions
            .items
            .first()
            .map(|session| session.session_id.clone()),
    }))
}

async fn handle_sessions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListSessionsQuery>,
) -> AppResult<Json<SessionsPage>> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let active_turns = active_turn_sessions(&state).await;
    let page = load_sessions_page(&state, limit, &active_turns).map_err(AppError::internal)?;
    Ok(Json(page))
}

async fn handle_session_detail(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<SessionDetail>> {
    let active_turns = active_turn_sessions(&state).await;
    let detail = load_session_detail(&state, &session_id, &active_turns)
        .map_err(|error| map_session_load_error(error, &session_id))?;
    Ok(Json(detail))
}

async fn handle_session_forks(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<SessionForksPage>> {
    let active_turns = active_turn_sessions(&state).await;
    let page = load_session_forks(&state, &session_id, &active_turns)
        .map_err(|error| map_session_load_error(error, &session_id))?;
    Ok(Json(page))
}

async fn handle_fork_session(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<ForkSessionRequest>,
) -> AppResult<(StatusCode, Json<ForkSessionResponse>)> {
    let response = fork_session(&state, &session_id, request)
        .map_err(|error| map_fork_error(error, &session_id))?;
    Ok((StatusCode::CREATED, Json(response)))
}

async fn handle_submit_turn(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<SubmitTurnRequest>,
) -> AppResult<(StatusCode, Json<SubmitTurnAccepted>)> {
    validate_turn_request(&state, &session_id, &request)?;

    let cwd_display = state.cwd.display().to_string();
    let conn = store::open_db(&state.sessions_db_path)
        .with_context(|| {
            format!(
                "opening Kordi session store at {}",
                state.sessions_db_path.display()
            )
        })
        .map_err(AppError::internal)?;

    let Some(session) = store::get_session(&conn, &session_id)
        .with_context(|| format!("looking up session {}", session_id))
        .map_err(AppError::internal)?
    else {
        return Err(AppError::not_found(format!(
            "session {} was not found for workspace {}",
            session_id, cwd_display
        )));
    };

    if session.cwd != cwd_display {
        return Err(AppError::not_found(format!(
            "session {} does not belong to workspace {}",
            session_id, cwd_display
        )));
    }

    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
    {
        store::set_session_name(&conn, &session_id, Some(title))
            .with_context(|| format!("setting session title for {}", session_id))
            .map_err(AppError::internal)?;
    }

    let turn_id = Uuid::new_v4().to_string();
    {
        let mut active_turns = state.active_turns.lock().await;
        if let Some(existing) = active_turns.get(&session_id) {
            return Err(AppError::conflict(format!(
                "turn {} is already running for session {}",
                existing.turn_id, session_id
            )));
        }
        active_turns.insert(
            session_id.clone(),
            ActiveTurn {
                turn_id: turn_id.clone(),
            },
        );
    }

    let execution = TurnExecution {
        turn_id: turn_id.clone(),
        session_id: session_id.clone(),
        cwd: state.cwd.clone(),
        input: request.input,
        model: request.model,
        thinking: request.thinking,
    };
    let state_for_task = state.clone();
    let session_id_for_task = session_id.clone();
    let turn_id_for_task = turn_id.clone();
    tokio::spawn(async move {
        let result = state_for_task.turn_executor.run_turn(execution).await;
        if let Err(error) = result {
            tracing::error!(
                session_id = %session_id_for_task,
                turn_id = %turn_id_for_task,
                error = %error,
                "turn execution failed"
            );
        }
        state_for_task
            .active_turns
            .lock()
            .await
            .remove(&session_id_for_task);
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(SubmitTurnAccepted {
            turn_id,
            session_id: session_id.clone(),
            created_session: false,
            stream_url: format!("/v1/sessions/{session_id}/events"),
        }),
    ))
}

fn load_sessions_page(
    state: &AppState,
    limit: usize,
    active_turns: &HashSet<String>,
) -> Result<SessionsPage> {
    let conn = store::open_db(&state.sessions_db_path).with_context(|| {
        format!(
            "opening Kordi session store at {}",
            state.sessions_db_path.display()
        )
    })?;
    let cwd = state.cwd.display().to_string();
    let rows = store::list_sessions(&conn, &cwd)
        .with_context(|| format!("listing sessions for {}", cwd))?;

    let fork_counts = fork_counts_by_parent(&rows);
    let items = rows
        .iter()
        .take(limit)
        .map(|row| session_summary_from_row(&conn, row, active_turns, &fork_counts))
        .collect::<Result<Vec<_>>>()?;

    Ok(SessionsPage {
        items,
        next_cursor: None,
    })
}

fn fork_counts_by_parent(rows: &[store::SessionRow]) -> HashMap<String, u32> {
    let mut counts = HashMap::new();
    for row in rows {
        if let Some(parent_id) = row
            .parent_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            *counts.entry(parent_id.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

fn session_summary_from_row(
    conn: &rusqlite::Connection,
    row: &store::SessionRow,
    active_turns: &HashSet<String>,
    fork_counts: &HashMap<String, u32>,
) -> Result<SessionSummary> {
    let status = if active_turns.contains(&row.session_id) {
        SessionStatus::Running
    } else {
        SessionStatus::Idle
    };
    let preview = session_preview(conn, &row.session_id, row.leaf_id.as_deref())?;
    let title = row
        .name
        .clone()
        .or_else(|| preview.clone())
        .unwrap_or_else(|| fallback_session_title(&row.session_id));

    Ok(SessionSummary {
        session_id: row.session_id.clone(),
        title,
        source: SessionSource::Local,
        status,
        updated_at: row.updated_at.clone(),
        cwd: Some(row.cwd.clone()),
        project_id: None,
        peer_id: None,
        parent_session_id: row.parent_session_id.clone(),
        parent_session_message_id: row.parent_session_message_id.clone(),
        fork_count: fork_counts.get(&row.session_id).copied().unwrap_or(0),
        last_message_preview: preview,
        unread_count: 0,
    })
}

fn load_session_detail(
    state: &AppState,
    session_id: &str,
    active_turns: &HashSet<String>,
) -> Result<SessionDetail> {
    let conn = store::open_db(&state.sessions_db_path).with_context(|| {
        format!(
            "opening Kordi session store at {}",
            state.sessions_db_path.display()
        )
    })?;
    let cwd = state.cwd.display().to_string();
    let Some(row) = store::get_session(&conn, session_id)? else {
        anyhow::bail!("session {session_id} was not found for workspace {cwd}");
    };
    if row.cwd != cwd {
        anyhow::bail!("session {session_id} does not belong to workspace {cwd}");
    }
    let rows = store::list_sessions(&conn, &cwd)?;
    let fork_counts = fork_counts_by_parent(&rows);
    let session = session_summary_from_row(&conn, &row, active_turns, &fork_counts)?;
    let entries = store::get_entries(&conn, session_id)?
        .iter()
        .map(|entry| timeline_entry_from_row(entry))
        .collect::<Result<Vec<_>>>()?;
    Ok(SessionDetail {
        session,
        entries,
        has_more: false,
        next_cursor: None,
    })
}

fn load_session_forks(
    state: &AppState,
    session_id: &str,
    active_turns: &HashSet<String>,
) -> Result<SessionForksPage> {
    let conn = store::open_db(&state.sessions_db_path).with_context(|| {
        format!(
            "opening Kordi session store at {}",
            state.sessions_db_path.display()
        )
    })?;
    let cwd = state.cwd.display().to_string();
    let rows = store::list_sessions(&conn, &cwd)?;
    if !rows.iter().any(|row| row.session_id == session_id) {
        anyhow::bail!("session {session_id} was not found for workspace {cwd}");
    }
    let fork_counts = fork_counts_by_parent(&rows);
    let items = rows
        .iter()
        .filter(|row| row.parent_session_id.as_deref() == Some(session_id))
        .map(|row| session_summary_from_row(&conn, row, active_turns, &fork_counts))
        .collect::<Result<Vec<_>>>()?;
    Ok(SessionForksPage {
        items,
        next_cursor: None,
    })
}

fn fork_session(
    state: &AppState,
    source_session_id: &str,
    request: ForkSessionRequest,
) -> Result<ForkSessionResponse> {
    let source_entry_id = request.source_entry_id.trim();
    if source_entry_id.is_empty() {
        anyhow::bail!("source_entry_id must not be empty");
    }
    let conn = store::open_db(&state.sessions_db_path).with_context(|| {
        format!(
            "opening Kordi session store at {}",
            state.sessions_db_path.display()
        )
    })?;
    let cwd = state.cwd.display().to_string();
    let Some(source_session) = store::get_session(&conn, source_session_id)? else {
        anyhow::bail!("session {source_session_id} was not found for workspace {cwd}");
    };
    if source_session.cwd != cwd {
        anyhow::bail!("session {source_session_id} does not belong to workspace {cwd}");
    }
    let forked = store::fork_session_from_entry(&conn, source_session_id, source_entry_id, &cwd)?;
    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        store::set_session_name(&conn, &forked.session_id, Some(title))?;
    }
    let rows = store::list_sessions(&conn, &cwd)?;
    let fork_counts = fork_counts_by_parent(&rows);
    let fork_row = rows
        .iter()
        .find(|row| row.session_id == forked.session_id)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "fork session {} was not found after creation",
                forked.session_id
            )
        })?;
    let session = session_summary_from_row(&conn, fork_row, &HashSet::new(), &fork_counts)?;
    Ok(ForkSessionResponse {
        session,
        source_session_id: forked.source_session_id,
        source_entry_id: forked.source_entry_id,
    })
}

fn map_session_load_error(error: anyhow::Error, session_id: &str) -> AppError {
    let message = error.to_string();
    let normalized = message.to_lowercase();
    if normalized.contains("was not found") || normalized.contains("does not belong") {
        return AppError::not_found(format!("Unable to load session {session_id}: {message}"));
    }
    AppError::internal(message)
}

fn map_fork_error(error: anyhow::Error, session_id: &str) -> AppError {
    let message = error.to_string();
    let normalized = message.to_lowercase();
    if normalized.contains("source_entry_id must not be empty") {
        return AppError::bad_request(message);
    }
    if normalized.contains("invalid entry id")
        || normalized.contains("invalid entry id for forking")
        || normalized.contains("entry not found")
        || normalized.contains("was not found")
    {
        return AppError::not_found(format!("Unable to fork session {session_id}: {message}"));
    }
    AppError::internal(message)
}

fn timeline_entry_from_row(row: &store::EntryRow) -> Result<TimelineEntry> {
    let parsed = store::parse_entry(row)?;
    let (role, text, detail, state) = timeline_fields_from_entry(&parsed);
    Ok(TimelineEntry {
        session_id: row.session_id.clone(),
        entry_id: row.entry_id.clone(),
        parent_entry_id: row.parent_id.clone(),
        created_at: row.timestamp.clone(),
        kind: TimelineEntryKind::Message,
        role,
        text,
        detail,
        state,
        data: None,
    })
}

fn timeline_fields_from_entry(
    entry: &SessionEntry,
) -> (
    TimelineRole,
    Option<String>,
    Option<String>,
    Option<TimelineState>,
) {
    match entry {
        SessionEntry::Message { message, .. } => match message {
            AgentMessage::User(msg) => (
                TimelineRole::User,
                first_content_text(&msg.content),
                None,
                Some(TimelineState::Complete),
            ),
            AgentMessage::Assistant(msg) => (
                TimelineRole::Assistant,
                first_assistant_text(&msg.content),
                None,
                Some(TimelineState::Complete),
            ),
            AgentMessage::ToolResult(msg) => (
                TimelineRole::Tool,
                first_content_text(&msg.content),
                Some(if msg.is_error {
                    format!("Tool {} failed", msg.tool_name)
                } else {
                    format!("Tool {} completed", msg.tool_name)
                }),
                Some(if msg.is_error {
                    TimelineState::Error
                } else {
                    TimelineState::Complete
                }),
            ),
            AgentMessage::BashExecution(msg) => (
                TimelineRole::Tool,
                Some(msg.command.clone()),
                Some("Bash execution".to_string()),
                Some(if msg.cancelled {
                    TimelineState::Error
                } else {
                    TimelineState::Complete
                }),
            ),
            AgentMessage::Custom(msg) => (
                TimelineRole::System,
                first_content_text(&msg.content),
                Some(format!("Custom message: {}", msg.custom_type)),
                Some(TimelineState::Complete),
            ),
            AgentMessage::BranchSummary(msg) => (
                TimelineRole::System,
                Some(msg.summary.clone()),
                Some("Branch summary".to_string()),
                Some(TimelineState::Complete),
            ),
            AgentMessage::CompactionSummary(msg) => (
                TimelineRole::System,
                Some(msg.summary.clone()),
                Some("Compaction summary".to_string()),
                Some(TimelineState::Complete),
            ),
        },
        _ => (
            TimelineRole::System,
            entry_preview(entry),
            None,
            Some(TimelineState::Complete),
        ),
    }
}

fn validate_turn_request(
    state: &AppState,
    session_id: &str,
    request: &SubmitTurnRequest,
) -> AppResult<()> {
    if request.input.trim().is_empty() {
        return Err(AppError::bad_request("input must not be empty"));
    }

    if let Some(body_session_id) = request.session_id.as_deref() {
        if body_session_id != session_id {
            return Err(AppError::bad_request(format!(
                "session_id {} does not match route session {}",
                body_session_id, session_id
            )));
        }
    }

    if request.new_session.unwrap_or(false) {
        return Err(AppError::bad_request(
            "new_session is not supported on /v1/sessions/:id/turns",
        ));
    }

    if let Some(cwd) = request.cwd.as_deref() {
        let expected = state.cwd.display().to_string();
        if cwd != expected {
            return Err(AppError::bad_request(format!(
                "cwd {} does not match server workspace {}",
                cwd, expected
            )));
        }
    }

    if request.project_id.is_some() || request.peer_id.is_some() {
        return Err(AppError::bad_request(
            "project and peer routed turns are not supported yet",
        ));
    }

    if request
        .attachments
        .as_ref()
        .is_some_and(|attachments| !attachments.is_empty())
    {
        return Err(AppError::bad_request(
            "attachments are not supported yet for app-server turns",
        ));
    }

    Ok(())
}

fn session_preview(
    conn: &rusqlite::Connection,
    session_id: &str,
    leaf_id: Option<&str>,
) -> Result<Option<String>> {
    let Some(leaf_id) = leaf_id else {
        return Ok(None);
    };
    let Some(entry) = store::get_entry(conn, session_id, leaf_id)? else {
        return Ok(None);
    };
    let parsed = store::parse_entry(&entry)?;
    Ok(entry_preview(&parsed))
}

fn entry_preview(entry: &SessionEntry) -> Option<String> {
    let text = match entry {
        SessionEntry::Message { message, .. } => message_preview(message),
        SessionEntry::Compaction { summary, .. } => Some(summary.clone()),
        SessionEntry::BranchSummary { summary, .. } => Some(summary.clone()),
        SessionEntry::ModelChange {
            provider, model_id, ..
        } => Some(format!("Model changed to {provider}/{model_id}")),
        SessionEntry::ThinkingLevelChange { thinking_level, .. } => {
            Some(format!("Thinking level {}", thinking_level.as_str()))
        }
        SessionEntry::Custom { custom_type, .. } => Some(format!("Custom event: {custom_type}")),
        SessionEntry::CustomMessage { content, .. } => first_content_text(content),
        SessionEntry::SessionInfo { name, .. } => name.clone(),
        SessionEntry::Label { label, .. } => label.clone(),
    }?;

    Some(truncate_preview(&text))
}

fn message_preview(message: &AgentMessage) -> Option<String> {
    match message {
        AgentMessage::User(msg) => first_content_text(&msg.content),
        AgentMessage::Assistant(msg) => first_assistant_text(&msg.content),
        AgentMessage::ToolResult(msg) => first_content_text(&msg.content).or_else(|| {
            Some(if msg.is_error {
                format!("Tool {} failed", msg.tool_name)
            } else {
                format!("Tool {} completed", msg.tool_name)
            })
        }),
        AgentMessage::BashExecution(msg) => Some(format!(
            "bash {}{}",
            if msg.cancelled { "cancelled: " } else { "" },
            msg.command
        )),
        AgentMessage::Custom(msg) => first_content_text(&msg.content)
            .or_else(|| Some(format!("Custom message: {}", msg.custom_type))),
        AgentMessage::BranchSummary(msg) => Some(msg.summary.clone()),
        AgentMessage::CompactionSummary(msg) => Some(msg.summary.clone()),
    }
}

fn first_content_text(content: &[ContentBlock]) -> Option<String> {
    content.iter().find_map(|block| match block {
        ContentBlock::Text { text } => Some(text.clone()),
        ContentBlock::Image { .. } => None,
    })
}

fn first_assistant_text(content: &[AssistantContent]) -> Option<String> {
    content.iter().find_map(|block| match block {
        AssistantContent::Text { text } => Some(text.clone()),
        AssistantContent::Thinking { thinking } => Some(thinking.clone()),
        AssistantContent::ToolCall { name, .. } => Some(format!("Tool call: {name}")),
    })
}

fn truncate_preview(text: &str) -> String {
    const LIMIT: usize = 120;
    let trimmed = text.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }

    let truncated = trimmed.chars().take(LIMIT - 1).collect::<String>();
    format!("{truncated}...")
}

async fn build_services_snapshot(state: &AppState) -> ServiceSnapshot {
    let runtime = match store::open_db(&state.sessions_db_path) {
        Ok(_) => ServiceStatusSummary {
            state: ServiceState::Ready,
            detail: Some(format!(
                "session store available at {}",
                state.sessions_db_path.display()
            )),
            last_heartbeat_at: None,
        },
        Err(error) => ServiceStatusSummary {
            state: ServiceState::Error,
            detail: Some(format!(
                "unable to open session store {}: {error}",
                state.sessions_db_path.display()
            )),
            last_heartbeat_at: None,
        },
    };

    let bridges = match state.bridges_status.fetch_status().await {
        Ok(status) => map_bridges_status(status),
        Err(error) => ServiceStatusSummary {
            state: ServiceState::Unknown,
            detail: Some(error.to_string()),
            last_heartbeat_at: None,
        },
    };

    ServiceSnapshot {
        runtime,
        bridges,
        registry: None,
    }
}

fn map_bridges_status(status: BridgesStatusResponse) -> ServiceStatusSummary {
    let state = if status.healthy {
        ServiceState::Ready
    } else {
        ServiceState::Degraded
    };

    ServiceStatusSummary {
        state,
        detail: Some(format!(
            "node {} • daemon={} since {} • coordination={} • runtime={} • reachability={} (direct_hints={} derp={} mailbox={} durable={})",
            status.node_id,
            status.daemon.state,
            status.daemon.started_at,
            bridges_component_summary(&status.coordination),
            bridges_component_summary(&status.runtime),
            status.reachability.mode,
            status.reachability.endpoint_hints_published,
            status.reachability.derp_connected,
            status.reachability.mailbox_fallback,
            status.reachability.mailbox_durable,
        )),
        last_heartbeat_at: Some(
            status
                .coordination
                .checked_at
                .max(status.runtime.checked_at),
        ),
    }
}

fn bridges_component_summary(component: &BridgesComponentStatus) -> String {
    match &component.detail {
        Some(detail) if !detail.trim().is_empty() => format!("{} ({detail})", component.state),
        _ => component.state.clone(),
    }
}

fn client_metadata_from_headers(headers: &HeaderMap) -> ClientMetadata {
    ClientMetadata {
        client_id: header_value(headers, "x-kordi-client-id")
            .unwrap_or_else(|| "anonymous".to_string()),
        client_kind: parse_client_kind(header_value(headers, "x-kordi-client-kind").as_deref()),
        client_name: header_value(headers, "x-kordi-client-name")
            .unwrap_or_else(|| "unknown-client".to_string()),
        protocol_version: APP_PROTOCOL_VERSION.to_string(),
        supports_streaming: header_value(headers, "x-kordi-supports-streaming")
            .as_deref()
            .map(|value| value == "true")
            .unwrap_or(true),
        supports_rich_text: header_value(headers, "x-kordi-supports-rich-text")
            .as_deref()
            .map(|value| value == "true")
            .unwrap_or(true),
    }
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_client_kind(value: Option<&str>) -> ClientKind {
    match value.unwrap_or("desktop") {
        "desktop" => ClientKind::Desktop,
        "tui" => ClientKind::Tui,
        "automation" => ClientKind::Automation,
        "test" => ClientKind::Test,
        _ => ClientKind::Desktop,
    }
}

fn fallback_session_title(session_id: &str) -> String {
    let short = session_id.chars().take(8).collect::<String>();
    format!("Session {short}")
}

fn workspace_root_name(cwd: &Path) -> String {
    cwd.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| cwd.display().to_string())
}

async fn active_turn_sessions(state: &AppState) -> HashSet<String> {
    state.active_turns.lock().await.keys().cloned().collect()
}

fn resolve_bridges_base_url() -> String {
    let port = std::env::var("BRIDGES_DAEMON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or_else(load_bridges_local_api_port);
    format!("http://127.0.0.1:{port}")
}

fn load_bridges_local_api_port() -> u16 {
    let Some(base) = BaseDirs::new() else {
        return default_bridges_port();
    };
    let path = base.home_dir().join(".bridges").join("daemon.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return default_bridges_port();
    };
    serde_json::from_str::<BridgesDaemonConfig>(&raw)
        .map(|config| config.local_api_port)
        .unwrap_or_else(|_| default_bridges_port())
}

fn default_bridges_port() -> u16 {
    7070
}

fn resolve_turn_command() -> TurnCommand {
    // Preserve the legacy env var as a fallback while preferring the new Kordi name.
    for key in ["KORDI_BIN", "KORDI_BB_BIN"] {
        if let Ok(path) = std::env::var(key) {
            if !path.trim().is_empty() {
                return TurnCommand {
                    program: path,
                    base_args: Vec::new(),
                    current_dir: None,
                };
            }
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        let sibling = current_exe.with_file_name(format!("kordi{}", std::env::consts::EXE_SUFFIX));
        if sibling.is_file() {
            return TurnCommand {
                program: sibling.display().to_string(),
                base_args: Vec::new(),
                current_dir: None,
            };
        }
    }

    if let Some(repo_root) = compile_time_repo_root() {
        return TurnCommand {
            program: "cargo".to_string(),
            base_args: vec![
                "run".to_string(),
                "-p".to_string(),
                "kordi-cli".to_string(),
                "--".to_string(),
            ],
            current_dir: Some(repo_root),
        };
    }

    TurnCommand {
        program: "kordi".to_string(),
        base_args: Vec::new(),
        current_dir: None,
    }
}

fn compile_time_repo_root() -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent()?.parent()?.to_path_buf();
    if repo_root.join("agent/crates/cli/src/main.rs").is_file() {
        Some(repo_root)
    } else {
        None
    }
}

fn describe_turn_command(command: &TurnCommand) -> String {
    let mut parts = vec![command.program.clone()];
    parts.extend(command.base_args.iter().cloned());
    parts.join(" ")
}

fn format_cli_model(model: &ModelSelector) -> String {
    match model
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(provider) => format!("{provider}/{}", model.model_id),
        None => model.model_id.clone(),
    }
}

fn protocol_thinking_level(level: &ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::Xhigh => "xhigh",
        ThinkingLevel::Max => "max",
    }
}

fn trim_command_output(output: &str) -> String {
    const LIMIT: usize = 240;
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return "<empty>".to_string();
    }

    let text = trimmed.chars().take(LIMIT).collect::<String>();
    if trimmed.chars().count() > LIMIT {
        format!("{text}...")
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use chrono::Utc;
    use kordi_core::types::{EntryBase, EntryId, UserMessage};
    use tempfile::TempDir;
    use tokio::sync::Notify;
    use tower::util::ServiceExt;

    #[test]
    fn max_thinking_level_maps_to_cli_value() {
        assert_eq!(protocol_thinking_level(&ThinkingLevel::Max), "max");
    }

    #[derive(Clone)]
    struct FakeBridgesStatusProvider {
        response: std::result::Result<BridgesStatusResponse, String>,
    }

    #[async_trait]
    impl BridgesStatusProvider for FakeBridgesStatusProvider {
        async fn fetch_status(&self) -> Result<BridgesStatusResponse> {
            self.response.clone().map_err(anyhow::Error::msg)
        }
    }

    #[derive(Clone, Default)]
    struct FakeTurnExecutor {
        calls: Arc<Mutex<Vec<TurnExecution>>>,
        gate: Option<Arc<Notify>>,
    }

    #[async_trait]
    impl TurnExecutor for FakeTurnExecutor {
        async fn run_turn(&self, execution: TurnExecution) -> Result<()> {
            self.calls.lock().await.push(execution);
            if let Some(gate) = &self.gate {
                gate.notified().await;
            }
            Ok(())
        }
    }

    fn test_server(
        cwd: PathBuf,
        sessions_db_path: PathBuf,
        bridges_status: std::result::Result<BridgesStatusResponse, String>,
        turn_executor: FakeTurnExecutor,
    ) -> AppServer {
        AppServer {
            state: Arc::new(AppState {
                cwd,
                sessions_db_path,
                bridges_status: Arc::new(FakeBridgesStatusProvider {
                    response: bridges_status,
                }),
                turn_executor: Arc::new(turn_executor),
                active_turns: Arc::new(Mutex::new(HashMap::new())),
            }),
        }
    }

    fn create_session_with_message(
        conn: &rusqlite::Connection,
        cwd: &str,
        name: &str,
        message: &str,
    ) -> String {
        let session_id = store::create_session(conn, cwd).expect("create session");
        store::set_session_name(conn, &session_id, Some(name)).expect("set session name");
        let entry = SessionEntry::Message {
            base: EntryBase {
                id: EntryId::generate(),
                parent_id: None,
                timestamp: Utc::now(),
            },
            message: AgentMessage::User(UserMessage {
                content: vec![ContentBlock::Text {
                    text: message.to_string(),
                }],
                timestamp: Utc::now().timestamp(),
            }),
        };
        store::append_entry(conn, &session_id, &entry).expect("append entry");
        session_id
    }

    fn sample_bridges_status() -> BridgesStatusResponse {
        BridgesStatusResponse {
            node_id: "kd_test".to_string(),
            healthy: true,
            daemon: BridgesDaemonStatus {
                state: "online".to_string(),
                started_at: "2026-04-19T00:00:00Z".to_string(),
            },
            coordination: BridgesComponentStatus {
                state: "healthy".to_string(),
                detail: Some("coord ok".to_string()),
                checked_at: "2026-04-19T00:01:00Z".to_string(),
            },
            runtime: BridgesComponentStatus {
                state: "healthy".to_string(),
                detail: Some("runtime ok".to_string()),
                checked_at: "2026-04-19T00:02:00Z".to_string(),
            },
            reachability: BridgesReachabilityStatus {
                mode: "direct_and_relay".to_string(),
                endpoint_hints_published: 1,
                derp_connected: true,
                mailbox_fallback: true,
                mailbox_durable: true,
            },
        }
    }

    #[tokio::test]
    async fn bootstrap_reports_workspace_and_services() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let cwd_str = cwd.display().to_string();
        let session_id =
            create_session_with_message(&conn, &cwd_str, "First session", "hello from bootstrap");

        let app = test_server(
            cwd.clone(),
            db_path,
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );
        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/bootstrap")
                    .header("x-kordi-client-kind", "tui")
                    .header("x-kordi-client-name", "test-tui")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let snapshot: BootstrapSnapshot = serde_json::from_slice(&body).expect("bootstrap json");

        assert_eq!(snapshot.server.protocol_version, APP_PROTOCOL_VERSION);
        assert_eq!(snapshot.client.client_kind, ClientKind::Tui);
        assert_eq!(snapshot.client.client_name, "test-tui");
        assert_eq!(snapshot.services.runtime.state, ServiceState::Ready);
        assert_eq!(snapshot.services.bridges.state, ServiceState::Ready);
        assert_eq!(
            snapshot.current_session_id.as_deref(),
            Some(session_id.as_str())
        );
    }

    #[tokio::test]
    async fn sessions_endpoint_reads_existing_session_store() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let cwd_str = cwd.display().to_string();
        create_session_with_message(&conn, &cwd_str, "Alpha", "first preview");
        create_session_with_message(&conn, &cwd_str, "Beta", "second preview");

        let app = test_server(
            cwd,
            db_path,
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );
        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/sessions?limit=1")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let page: SessionsPage = serde_json::from_slice(&body).expect("sessions json");

        assert_eq!(page.items.len(), 1);
        assert!(page.next_cursor.is_none());
        assert_eq!(page.items[0].source, SessionSource::Local);
        assert_eq!(page.items[0].status, SessionStatus::Idle);
        assert!(
            page.items[0]
                .last_message_preview
                .as_deref()
                .unwrap_or_default()
                .contains("preview")
        );
    }

    #[tokio::test]
    async fn session_detail_exposes_entries_and_lineage() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let cwd_str = cwd.display().to_string();
        let source_session_id = create_session_with_message(&conn, &cwd_str, "Source", "fork me");
        let source_entry_id = store::get_entries(&conn, &source_session_id)
            .expect("entries")
            .first()
            .expect("entry")
            .entry_id
            .clone();
        let forked =
            store::fork_session_from_entry(&conn, &source_session_id, &source_entry_id, &cwd_str)
                .expect("fork session");

        let app = test_server(
            cwd,
            db_path,
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );
        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/sessions/{}", forked.session_id))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let detail: SessionDetail = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("detail json");

        assert_eq!(detail.session.session_id, forked.session_id);
        assert_eq!(
            detail.session.parent_session_id.as_deref(),
            Some(source_session_id.as_str())
        );
        assert_eq!(
            detail.session.parent_session_message_id.as_deref(),
            Some(source_entry_id.as_str())
        );
        assert_eq!(detail.entries.len(), 1);
        assert_eq!(detail.entries[0].entry_id, source_entry_id);
    }

    #[tokio::test]
    async fn fork_endpoint_creates_fork_and_lists_it_under_source() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let cwd_str = cwd.display().to_string();
        let source_session_id =
            create_session_with_message(&conn, &cwd_str, "Source", "make a fork");
        let source_entry_id = store::get_entries(&conn, &source_session_id)
            .expect("entries")
            .first()
            .expect("entry")
            .entry_id
            .clone();

        let app = test_server(
            cwd,
            db_path,
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );
        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/sessions/{source_session_id}/forks"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "source_entry_id": source_entry_id,
                            "title": "Forked task",
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::CREATED);
        let forked: ForkSessionResponse = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("fork json");
        assert_ne!(forked.session.session_id, source_session_id);
        assert_eq!(forked.session.title, "Forked task");
        assert_eq!(
            forked.session.parent_session_id.as_deref(),
            Some(source_session_id.as_str())
        );
        assert_eq!(
            forked.session.parent_session_message_id.as_deref(),
            Some(source_entry_id.as_str())
        );

        let list_response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/sessions/{source_session_id}/forks"))
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(list_response.status(), StatusCode::OK);
        let forks: SessionForksPage = serde_json::from_slice(
            &to_bytes(list_response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("fork list json");
        assert_eq!(forks.items.len(), 1);
        assert_eq!(forks.items[0].session_id, forked.session.session_id);
    }

    #[tokio::test]
    async fn fork_endpoint_rejects_unknown_source_entry() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let cwd_str = cwd.display().to_string();
        let source_session_id = create_session_with_message(&conn, &cwd_str, "Source", "ready");

        let app = test_server(
            cwd,
            db_path,
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );
        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/sessions/{source_session_id}/forks"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "source_entry_id": "missing-entry" }).to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn submit_turn_accepts_existing_session_and_marks_it_running() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let cwd_str = cwd.display().to_string();
        let session_id = create_session_with_message(&conn, &cwd_str, "Alpha", "ready");
        let gate = Arc::new(Notify::new());
        let executor = FakeTurnExecutor {
            calls: Arc::new(Mutex::new(Vec::new())),
            gate: Some(gate.clone()),
        };

        let app = test_server(cwd, db_path, Ok(sample_bridges_status()), executor.clone());

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/sessions/{session_id}/turns"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&SubmitTurnRequest {
                            session_id: Some(session_id.clone()),
                            title: Some("Renamed session".to_string()),
                            input: "Ship it".to_string(),
                            cwd: None,
                            project_id: None,
                            peer_id: None,
                            model: Some(ModelSelector {
                                provider: Some("openai".to_string()),
                                model_id: "gpt-5.4-mini".to_string(),
                                reasoning: Some(ThinkingLevel::Low),
                            }),
                            thinking: Some(ThinkingLevel::Medium),
                            new_session: None,
                            attachments: None,
                        })
                        .expect("request json"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let accepted: SubmitTurnAccepted = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("accepted json");
        assert_eq!(accepted.session_id, session_id);

        wait_for_turn_calls(&executor, 1).await;

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/sessions?limit=1")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        let page: SessionsPage = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("sessions json");

        assert_eq!(page.items[0].status, SessionStatus::Running);
        assert_eq!(page.items[0].title, "Renamed session");

        let calls = executor.calls.lock().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].input, "Ship it");
        assert_eq!(calls[0].session_id, session_id);
        drop(calls);

        gate.notify_waiters();
    }

    #[tokio::test]
    async fn submit_turn_rejects_concurrent_turns_for_the_same_session() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let cwd_str = cwd.display().to_string();
        let session_id = create_session_with_message(&conn, &cwd_str, "Alpha", "ready");
        let gate = Arc::new(Notify::new());
        let executor = FakeTurnExecutor {
            calls: Arc::new(Mutex::new(Vec::new())),
            gate: Some(gate.clone()),
        };

        let app = test_server(cwd, db_path, Ok(sample_bridges_status()), executor.clone());

        let first = submit_turn_request(&app, &session_id, "First turn").await;
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        wait_for_turn_calls(&executor, 1).await;

        let second = submit_turn_request(&app, &session_id, "Second turn").await;
        assert_eq!(second.status(), StatusCode::CONFLICT);

        gate.notify_waiters();
    }

    #[tokio::test]
    async fn submit_turn_rejects_unknown_session() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let app = test_server(
            cwd,
            db_path,
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = submit_turn_request(&app, "missing-session", "Hello").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    async fn submit_turn_request(
        app: &AppServer,
        session_id: &str,
        input: &str,
    ) -> axum::http::Response<Body> {
        app.router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/sessions/{session_id}/turns"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&SubmitTurnRequest {
                            session_id: None,
                            title: None,
                            input: input.to_string(),
                            cwd: None,
                            project_id: None,
                            peer_id: None,
                            model: None,
                            thinking: None,
                            new_session: None,
                            attachments: None,
                        })
                        .expect("request json"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response")
    }

    async fn wait_for_turn_calls(executor: &FakeTurnExecutor, expected: usize) {
        for _ in 0..50 {
            if executor.calls.lock().await.len() >= expected {
                return;
            }
            tokio::task::yield_now().await;
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {expected} turn calls");
    }
}
