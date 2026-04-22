use anyhow::{Context, Result};
use async_trait::async_trait;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bb_core::config;
use bb_core::settings::Settings;
use bb_core::types::{AgentMessage, AssistantContent, ContentBlock, SessionEntry};
use bb_session::store;
use directories::BaseDirs;
use kordi_protocol::{
    APP_PROTOCOL_VERSION, BootstrapSnapshot, ClientKind, ClientMetadata,
    EnvironmentConnectionState, EnvironmentKind, EnvironmentSummary, ExpandWorkspaceInputRequest,
    ExpandedWorkspaceInputSnapshot, FeatureFlags, ModelSelector, ServerMetadata, ServiceSnapshot,
    ServiceState, ServiceStatusSummary, SessionSource, SessionStatus, SessionSummary, SessionsPage,
    SshEnvironmentSummary, SubmitTurnAccepted, SubmitTurnRequest, ThinkingLevel,
    WorkspaceEntriesSnapshot, WorkspaceEntryKind, WorkspaceEntrySummary, WorkspaceFileTextSnapshot,
    WorkspaceFindSnapshot, WorkspaceGrepSnapshot, WorkspaceSummary,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::io::Write;
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

#[derive(Clone, Debug)]
pub enum AppServerEnvironmentConfig {
    Local { cwd: PathBuf },
    Ssh(SshEnvironmentConfig),
}

#[derive(Clone, Debug)]
pub struct SshEnvironmentConfig {
    pub environment_id: Option<String>,
    pub display_name: Option<String>,
    pub connection_state: EnvironmentConnectionState,
    pub alias: Option<String>,
    pub host: String,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub remote_root: String,
}

#[derive(Clone)]
struct AppState {
    environment: AppEnvironment,
    ssh_runner: Arc<dyn SshCommandRunner>,
    sessions_db_path: PathBuf,
    workspace_api_base_url: Option<String>,
    bridges_status: Arc<dyn BridgesStatusProvider>,
    turn_executor: Arc<dyn TurnExecutor>,
    active_turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug)]
enum AppEnvironment {
    Local(LocalEnvironment),
    Ssh(SshEnvironment),
}

#[derive(Clone, Debug)]
struct LocalEnvironment {
    cwd: PathBuf,
}

#[derive(Clone, Debug)]
struct SshEnvironment {
    environment_id: String,
    display_name: String,
    connection_state: EnvironmentConnectionState,
    alias: Option<String>,
    host: String,
    port: Option<u16>,
    user: Option<String>,
    remote_root: String,
}

impl AppEnvironment {
    fn from_config(config: AppServerEnvironmentConfig) -> Result<Self> {
        match config {
            AppServerEnvironmentConfig::Local { cwd } => Self::local(cwd),
            AppServerEnvironmentConfig::Ssh(config) => Self::ssh(config),
        }
    }

    fn local(cwd: PathBuf) -> Result<Self> {
        let cwd = std::fs::canonicalize(&cwd)
            .with_context(|| format!("canonicalizing cwd {}", cwd.display()))?;
        Ok(Self::Local(LocalEnvironment { cwd }))
    }

    fn ssh(config: SshEnvironmentConfig) -> Result<Self> {
        let host = config.host.trim();
        if host.is_empty() {
            anyhow::bail!("ssh host must not be empty");
        }

        let remote_root = config.remote_root.trim();
        if remote_root.is_empty() {
            anyhow::bail!("ssh remote_root must not be empty");
        }

        let alias = config
            .alias
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let user = config
            .user
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let environment_id = config
            .environment_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .or_else(|| alias.map(ToOwned::to_owned))
            .unwrap_or_else(|| host.to_string());
        let display_name = config
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                let authority = match user {
                    Some(user) => format!("{user}@{host}"),
                    None => host.to_string(),
                };
                format!("SSH {authority}")
            });

        Ok(Self::Ssh(SshEnvironment {
            environment_id,
            display_name,
            connection_state: config.connection_state,
            alias: alias.map(ToOwned::to_owned),
            host: host.to_string(),
            port: config.port,
            user: user.map(ToOwned::to_owned),
            remote_root: remote_root.to_string(),
        }))
    }

    fn settings(&self) -> Settings {
        match self {
            Self::Local(environment) => Settings::load_merged(&environment.cwd),
            Self::Ssh(_) => Settings::load_global(),
        }
    }

    fn workspace_summary(&self, execution_mode: String) -> WorkspaceSummary {
        WorkspaceSummary {
            cwd: self.workspace_locator(),
            root_name: self.workspace_root_name(),
            platform: self.platform(),
            execution_mode,
            environment: self.summary(),
        }
    }

    fn summary(&self) -> EnvironmentSummary {
        match self {
            Self::Local(_) => EnvironmentSummary {
                environment_id: "local".to_string(),
                kind: EnvironmentKind::Local,
                display_name: "Local".to_string(),
                connection_state: EnvironmentConnectionState::Connected,
                ssh: None,
            },
            Self::Ssh(environment) => EnvironmentSummary {
                environment_id: environment.environment_id.clone(),
                kind: EnvironmentKind::Ssh,
                display_name: environment.display_name.clone(),
                connection_state: environment.connection_state.clone(),
                ssh: Some(SshEnvironmentSummary {
                    alias: environment.alias.clone(),
                    host: environment.host.clone(),
                    port: environment.port,
                    user: environment.user.clone(),
                    remote_root: environment.remote_root.clone(),
                }),
            },
        }
    }

    fn workspace_locator(&self) -> String {
        match self {
            Self::Local(environment) => environment.cwd.display().to_string(),
            Self::Ssh(environment) => environment.remote_root.clone(),
        }
    }

    fn session_scope_key(&self) -> String {
        match self {
            Self::Local(environment) => environment.cwd.display().to_string(),
            Self::Ssh(environment) => {
                format!(
                    "ssh:{}:{}",
                    environment.environment_id, environment.remote_root
                )
            }
        }
    }

    fn workspace_root_name(&self) -> String {
        match self {
            Self::Local(environment) => workspace_root_name(&environment.cwd),
            Self::Ssh(environment) => {
                workspace_root_name_from_display_path(&environment.remote_root)
            }
        }
    }

    fn platform(&self) -> String {
        match self {
            Self::Local(_) => format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            Self::Ssh(_) => "ssh-remote".to_string(),
        }
    }

    fn supports_turn_execution(&self, workspace_api_base_url: Option<&str>) -> bool {
        match self {
            Self::Local(_) => true,
            Self::Ssh(_) => workspace_api_base_url.is_some(),
        }
    }

    fn list_workspace_entries(
        &self,
        ssh_runner: &dyn SshCommandRunner,
        path: &str,
    ) -> AppResult<WorkspaceEntriesSnapshot> {
        match self {
            Self::Local(environment) => list_local_workspace_entries(&environment.cwd, path),
            Self::Ssh(environment) => list_ssh_workspace_entries(ssh_runner, environment, path),
        }
    }

    fn read_workspace_file(
        &self,
        ssh_runner: &dyn SshCommandRunner,
        path: &str,
        offset: usize,
        limit: usize,
    ) -> AppResult<WorkspaceFileTextSnapshot> {
        match self {
            Self::Local(environment) => {
                read_local_workspace_file(&environment.cwd, path, offset, limit)
            }
            Self::Ssh(environment) => {
                read_ssh_workspace_file(ssh_runner, environment, path, offset, limit)
            }
        }
    }

    fn grep_workspace(
        &self,
        ssh_runner: &dyn SshCommandRunner,
        query: &WorkspaceGrepQuery,
    ) -> AppResult<WorkspaceGrepSnapshot> {
        match self {
            Self::Local(environment) => grep_local_workspace(&environment.cwd, query),
            Self::Ssh(environment) => grep_ssh_workspace(ssh_runner, environment, query),
        }
    }

    fn find_workspace(
        &self,
        ssh_runner: &dyn SshCommandRunner,
        query: &WorkspaceFindQuery,
    ) -> AppResult<WorkspaceFindSnapshot> {
        match self {
            Self::Local(environment) => find_local_workspace(&environment.cwd, query),
            Self::Ssh(environment) => find_ssh_workspace(ssh_runner, environment, query),
        }
    }
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
    environment: AppEnvironment,
    input: String,
    model: Option<ModelSelector>,
    thinking: Option<ThinkingLevel>,
    workspace_api_base_url: Option<String>,
}

const WORKSPACE_API_BASE_URL_ENV: &str = "KORDI_WORKSPACE_API_BASE_URL";
const WORKSPACE_SESSION_SCOPE_KEY_ENV: &str = "KORDI_WORKSPACE_SESSION_SCOPE_KEY";
const WORKSPACE_LOCATOR_ENV: &str = "KORDI_WORKSPACE_LOCATOR";
const WORKSPACE_ENVIRONMENT_KIND_ENV: &str = "KORDI_WORKSPACE_ENVIRONMENT_KIND";
const WORKSPACE_DISABLE_EXTENSIONS_ENV: &str = "KORDI_WORKSPACE_DISABLE_EXTENSIONS";
const SSH_REMOTE_TOOL_SELECTION: &str = "read,ls,grep,find,web_search";

#[derive(Clone, Debug, PartialEq, Eq)]
struct PreparedTurnCommand {
    args: Vec<String>,
    env: Vec<(String, Option<String>)>,
}

#[derive(Debug, Clone, Deserialize)]
struct ListSessionsQuery {
    limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkspaceEntriesQuery {
    path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkspaceFileQuery {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkspaceGrepQuery {
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
    #[serde(rename = "ignoreCase")]
    ignore_case: Option<bool>,
    literal: Option<bool>,
    context: Option<usize>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkspaceFindQuery {
    pattern: String,
    path: Option<String>,
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

    fn not_implemented(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_IMPLEMENTED,
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum SshCommandError {
    Remote { code: String, detail: String },
    Transport { detail: String },
}

trait SshCommandRunner: Send + Sync {
    fn run_script(
        &self,
        environment: &SshEnvironment,
        script: &str,
        args: &[String],
    ) -> Result<Vec<u8>, SshCommandError>;
}

#[derive(Clone, Default)]
struct ProcessSshCommandRunner;

impl SshCommandRunner for ProcessSshCommandRunner {
    fn run_script(
        &self,
        environment: &SshEnvironment,
        script: &str,
        args: &[String],
    ) -> Result<Vec<u8>, SshCommandError> {
        let target = ssh_destination(environment);
        let remote_command = build_ssh_remote_command(args);
        let mut command = std::process::Command::new("ssh");
        command
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=10");
        if let Some(port) = environment.port {
            command.arg("-p").arg(port.to_string());
        }
        command
            .arg(target)
            .arg(remote_command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| SshCommandError::Transport {
                detail: format!("spawning ssh: {error}"),
            })?;
        let Some(stdin) = child.stdin.as_mut() else {
            return Err(SshCommandError::Transport {
                detail: "ssh stdin was unavailable".to_string(),
            });
        };
        stdin
            .write_all(script.as_bytes())
            .map_err(|error| SshCommandError::Transport {
                detail: format!("writing ssh script to stdin: {error}"),
            })?;

        let output = child
            .wait_with_output()
            .map_err(|error| SshCommandError::Transport {
                detail: format!("waiting for ssh command: {error}"),
            })?;
        if output.status.success() {
            return Ok(output.stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if let Some(error) = parse_ssh_remote_error(&stderr) {
            return Err(error);
        }

        let detail = if stderr.is_empty() {
            format!("ssh exited with status {}", output.status)
        } else {
            stderr
        };
        Err(SshCommandError::Transport { detail })
    }
}

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
        let prepared = build_prepared_turn_command(&self.command, &execution)?;
        let mut command = tokio::process::Command::new(&self.command.program);
        command.args(&prepared.args);
        if let Some(current_dir) = &self.command.current_dir {
            command.current_dir(current_dir);
        }
        for (name, value) in prepared.env {
            match value {
                Some(value) => {
                    command.env(name, value);
                }
                None => {
                    command.env_remove(name);
                }
            }
        }

        command.stdout(Stdio::piped()).stderr(Stdio::piped());

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

fn build_prepared_turn_command(
    command: &TurnCommand,
    execution: &TurnExecution,
) -> Result<PreparedTurnCommand> {
    let mut args = command.base_args.clone();
    let mut env = vec![
        (WORKSPACE_API_BASE_URL_ENV.to_string(), None),
        (WORKSPACE_SESSION_SCOPE_KEY_ENV.to_string(), None),
        (WORKSPACE_LOCATOR_ENV.to_string(), None),
        (WORKSPACE_ENVIRONMENT_KIND_ENV.to_string(), None),
        (WORKSPACE_DISABLE_EXTENSIONS_ENV.to_string(), None),
    ];

    let launch_cwd = match &execution.environment {
        AppEnvironment::Local(environment) => environment.cwd.clone(),
        AppEnvironment::Ssh(_) => {
            let Some(base_url) = execution.workspace_api_base_url.as_ref() else {
                anyhow::bail!("workspace API base URL is required for ssh turn execution")
            };
            env = vec![
                (
                    WORKSPACE_API_BASE_URL_ENV.to_string(),
                    Some(base_url.clone()),
                ),
                (
                    WORKSPACE_SESSION_SCOPE_KEY_ENV.to_string(),
                    Some(execution.environment.session_scope_key()),
                ),
                (
                    WORKSPACE_LOCATOR_ENV.to_string(),
                    Some(execution.environment.workspace_locator()),
                ),
                (
                    WORKSPACE_ENVIRONMENT_KIND_ENV.to_string(),
                    Some("ssh".to_string()),
                ),
                (
                    WORKSPACE_DISABLE_EXTENSIONS_ENV.to_string(),
                    Some("1".to_string()),
                ),
            ];
            args.push("--tools".to_string());
            args.push(SSH_REMOTE_TOOL_SELECTION.to_string());
            resolve_remote_turn_launch_cwd(command)
        }
    };

    args.push("-C".to_string());
    args.push(launch_cwd.display().to_string());
    args.push("-p".to_string());
    args.push("--session".to_string());
    args.push(execution.session_id.clone());

    if let Some(model) = &execution.model {
        args.push("--model".to_string());
        args.push(format_cli_model(model));
    }

    let thinking = execution.thinking.clone().or_else(|| {
        execution
            .model
            .as_ref()
            .and_then(|model| model.reasoning.clone())
    });
    if let Some(thinking) = thinking {
        args.push("--thinking".to_string());
        args.push(protocol_thinking_level(&thinking).to_string());
    }

    args.push(execution.input.clone());

    Ok(PreparedTurnCommand { args, env })
}

fn resolve_remote_turn_launch_cwd(command: &TurnCommand) -> PathBuf {
    command
        .current_dir
        .clone()
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| {
            let fallback = config::global_dir();
            let _ = std::fs::create_dir_all(&fallback);
            fallback
        })
}

impl AppServer {
    pub fn from_cwd(cwd: PathBuf) -> Result<Self> {
        Self::from_environment_config(AppServerEnvironmentConfig::Local { cwd })
    }

    pub fn from_environment_config(config: AppServerEnvironmentConfig) -> Result<Self> {
        Self::from_environment_config_with_workspace_api_base_url(config, None)
    }

    pub fn from_environment_config_with_workspace_api_base_url(
        config: AppServerEnvironmentConfig,
        workspace_api_base_url: Option<String>,
    ) -> Result<Self> {
        let environment = AppEnvironment::from_config(config)?;
        let sessions_db_path = config::global_dir().join("sessions.db");
        let bridges_base_url = resolve_bridges_base_url();
        let turn_command = resolve_turn_command();

        Ok(Self {
            state: Arc::new(AppState {
                environment,
                ssh_runner: Arc::new(ProcessSshCommandRunner),
                sessions_db_path,
                workspace_api_base_url,
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
            .route("/v1/workspace/entries", get(handle_workspace_entries))
            .route("/v1/workspace/file", get(handle_workspace_file))
            .route("/v1/workspace/grep", get(handle_workspace_grep))
            .route("/v1/workspace/find", get(handle_workspace_find))
            .route(
                "/v1/workspace/expand-input",
                post(handle_expand_workspace_input),
            )
            .route("/v1/sessions", get(handle_sessions))
            .route("/v1/sessions/:session_id/turns", post(handle_submit_turn))
            .with_state(self.state.clone())
    }
}

async fn handle_bootstrap(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> AppResult<Json<BootstrapSnapshot>> {
    let settings = state.environment.settings();
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
        workspace: state
            .environment
            .workspace_summary(settings.resolved_execution_mode().as_str().to_string()),
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

async fn handle_workspace_entries(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WorkspaceEntriesQuery>,
) -> AppResult<Json<WorkspaceEntriesSnapshot>> {
    let path = query.path.as_deref().unwrap_or(".");
    let snapshot = state
        .environment
        .list_workspace_entries(state.ssh_runner.as_ref(), path)?;
    Ok(Json(snapshot))
}

async fn handle_workspace_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WorkspaceFileQuery>,
) -> AppResult<Json<WorkspaceFileTextSnapshot>> {
    let offset = query.offset.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(2000).max(1);
    let snapshot = state.environment.read_workspace_file(
        state.ssh_runner.as_ref(),
        &query.path,
        offset,
        limit,
    )?;
    Ok(Json(snapshot))
}

async fn handle_workspace_grep(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WorkspaceGrepQuery>,
) -> AppResult<Json<WorkspaceGrepSnapshot>> {
    let snapshot = state
        .environment
        .grep_workspace(state.ssh_runner.as_ref(), &query)?;
    Ok(Json(snapshot))
}

async fn handle_workspace_find(
    State(state): State<Arc<AppState>>,
    Query(query): Query<WorkspaceFindQuery>,
) -> AppResult<Json<WorkspaceFindSnapshot>> {
    let snapshot = state
        .environment
        .find_workspace(state.ssh_runner.as_ref(), &query)?;
    Ok(Json(snapshot))
}

async fn handle_expand_workspace_input(
    State(state): State<Arc<AppState>>,
    Json(request): Json<ExpandWorkspaceInputRequest>,
) -> AppResult<Json<ExpandedWorkspaceInputSnapshot>> {
    Ok(Json(expand_workspace_input(&state, &request.input)))
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

async fn handle_submit_turn(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<SubmitTurnRequest>,
) -> AppResult<(StatusCode, Json<SubmitTurnAccepted>)> {
    validate_turn_request(&state, &session_id, &request)?;

    let workspace_locator = state.environment.workspace_locator();
    let session_scope_key = state.environment.session_scope_key();
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
            session_id, workspace_locator
        )));
    };

    if session.cwd != session_scope_key {
        return Err(AppError::not_found(format!(
            "session {} does not belong to workspace {}",
            session_id, workspace_locator
        )));
    }

    let expanded_input = expand_workspace_input(&state, &request.input);
    for warning in &expanded_input.warnings {
        tracing::warn!(session_id = %session_id, warning = %warning, "workspace input expansion warning");
    }
    let prompt_input = expanded_input.text.trim().to_string();
    if prompt_input.is_empty() {
        return Err(AppError::bad_request(
            "input must not be empty after workspace expansion",
        ));
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
        environment: state.environment.clone(),
        input: prompt_input,
        model: request.model,
        thinking: request.thinking,
        workspace_api_base_url: state.workspace_api_base_url.clone(),
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
    let session_scope_key = state.environment.session_scope_key();
    let workspace_locator = state.environment.workspace_locator();
    let rows = store::list_sessions(&conn, &session_scope_key)
        .with_context(|| format!("listing sessions for {}", session_scope_key))?;

    let items = rows
        .into_iter()
        .take(limit)
        .map(|row| {
            let status = if active_turns.contains(&row.session_id) {
                SessionStatus::Running
            } else {
                SessionStatus::Idle
            };
            let preview = session_preview(&conn, &row.session_id, row.leaf_id.as_deref())?;
            let title = row
                .name
                .clone()
                .or_else(|| preview.clone())
                .unwrap_or_else(|| fallback_session_title(&row.session_id));

            Ok(SessionSummary {
                session_id: row.session_id,
                title,
                source: SessionSource::Local,
                status,
                updated_at: row.updated_at,
                cwd: Some(workspace_locator.clone()),
                project_id: None,
                peer_id: None,
                last_message_preview: preview,
                unread_count: 0,
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(SessionsPage {
        items,
        next_cursor: None,
    })
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

    if !state
        .environment
        .supports_turn_execution(state.workspace_api_base_url.as_deref())
    {
        return Err(AppError::bad_request(
            "turn submission is not configured for the active ssh environment",
        ));
    }

    if let Some(cwd) = request.cwd.as_deref() {
        let expected = state.environment.workspace_locator();
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

const WORKSPACE_LISTING_MAX_ENTRIES: usize = 200;
const WORKSPACE_FILE_MAX_LINES: usize = 200;
const WORKSPACE_FILE_MAX_CHARS: usize = 16_000;

fn list_local_workspace_entries(root: &Path, path: &str) -> AppResult<WorkspaceEntriesSnapshot> {
    let (absolute_path, display_path) = resolve_local_workspace_path(root, path)?;
    if !absolute_path.is_dir() {
        return Err(AppError::bad_request(format!(
            "workspace path {} is not a directory",
            display_path
        )));
    }

    let mut items = std::fs::read_dir(&absolute_path)
        .map_err(|error| map_workspace_io_error(error, &display_path))?
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(error) => {
                tracing::warn!(path = %display_path, error = %error, "skipping workspace entry");
                None
            }
        })
        .filter_map(|entry| {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    tracing::warn!(
                        path = %entry.path().display(),
                        error = %error,
                        "skipping workspace entry without file type"
                    );
                    return None;
                }
            };

            if file_type.is_symlink() {
                return None;
            }

            let name = entry.file_name().to_string_lossy().to_string();
            let child_path = workspace_child_path(&display_path, &name);
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(error) => {
                    tracing::warn!(path = %child_path, error = %error, "skipping workspace entry without metadata");
                    return None;
                }
            };
            let kind = if metadata.is_dir() {
                WorkspaceEntryKind::Directory
            } else {
                WorkspaceEntryKind::File
            };
            let size = metadata.is_file().then_some(metadata.len());

            Some(WorkspaceEntrySummary {
                path: child_path,
                name,
                kind,
                size,
            })
        })
        .take(WORKSPACE_LISTING_MAX_ENTRIES)
        .collect::<Vec<_>>();

    items.sort_by(|left, right| {
        workspace_entry_sort_key(&left.kind, &left.name)
            .cmp(&workspace_entry_sort_key(&right.kind, &right.name))
    });

    Ok(WorkspaceEntriesSnapshot {
        workspace_root: root.display().to_string(),
        path: display_path,
        items,
    })
}

fn read_local_workspace_file(
    root: &Path,
    path: &str,
    offset: usize,
    limit: usize,
) -> AppResult<WorkspaceFileTextSnapshot> {
    let (absolute_path, display_path) = resolve_local_workspace_path(root, path)?;
    if !absolute_path.is_file() {
        return Err(AppError::bad_request(format!(
            "workspace path {} is not a file",
            display_path
        )));
    }

    let bytes = std::fs::read(&absolute_path)
        .map_err(|error| map_workspace_io_error(error, &display_path))?;
    let byte_size = bytes.len() as u64;
    let text = String::from_utf8(bytes).map_err(|_| {
        AppError::not_implemented(format!(
            "workspace file {} is not valid utf-8 yet",
            display_path
        ))
    })?;
    build_workspace_file_snapshot(
        root.display().to_string(),
        display_path,
        &text,
        byte_size,
        offset,
        limit,
    )
}

fn grep_local_workspace(
    root: &Path,
    query: &WorkspaceGrepQuery,
) -> AppResult<WorkspaceGrepSnapshot> {
    let requested = query.path.as_deref().unwrap_or(".");
    let (absolute_path, display_path) = resolve_local_workspace_path(root, requested)?;
    let limit = query.limit.unwrap_or(100).clamp(1, 2000);
    if !absolute_path.exists() {
        return Err(AppError::not_found(format!(
            "workspace path {} was not found",
            display_path
        )));
    }

    let mut command = std::process::Command::new("rg");
    command
        .arg("--line-number")
        .arg("--no-heading")
        .arg("--max-count")
        .arg(limit.to_string());
    if query.ignore_case.unwrap_or(false) {
        command.arg("--ignore-case");
    }
    if query.literal.unwrap_or(false) {
        command.arg("--fixed-strings");
    }
    if let Some(context) = query.context.filter(|value| *value > 0) {
        command.arg("--context").arg(context.to_string());
    }
    if let Some(glob) = query.glob.as_deref() {
        command.arg("--glob").arg(glob);
    }
    command.arg(&query.pattern).arg(&absolute_path);

    let output = command.output().map_err(|error| {
        AppError::internal(format!(
            "running local grep for {}: {}",
            display_path, error
        ))
    })?;
    let output = if output.status.success() || output.status.code() == Some(1) {
        output
    } else {
        let mut fallback = std::process::Command::new("grep");
        fallback.arg("-rn");
        if query.ignore_case.unwrap_or(false) {
            fallback.arg("-i");
        }
        if query.literal.unwrap_or(false) {
            fallback.arg("-F");
        }
        if let Some(context) = query.context.filter(|value| *value > 0) {
            fallback.arg("-C").arg(context.to_string());
        }
        fallback.arg(&query.pattern).arg(&absolute_path);
        fallback.output().map_err(|error| {
            AppError::internal(format!(
                "running fallback grep for {}: {}",
                display_path, error
            ))
        })?
    };

    let items = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| strip_workspace_prefix(line, root))
        .collect::<Vec<_>>();
    let truncated = items.len() >= limit;
    Ok(WorkspaceGrepSnapshot {
        workspace_root: root.display().to_string(),
        path: display_path,
        match_count: items.len() as u64,
        truncated,
        items,
    })
}

fn find_local_workspace(
    root: &Path,
    query: &WorkspaceFindQuery,
) -> AppResult<WorkspaceFindSnapshot> {
    let requested = query.path.as_deref().unwrap_or(".");
    let (absolute_path, display_path) = resolve_local_workspace_path(root, requested)?;
    let limit = query.limit.unwrap_or(1000).clamp(1, 5000);
    if !absolute_path.exists() {
        return Err(AppError::not_found(format!(
            "workspace path {} was not found",
            display_path
        )));
    }

    let output = std::process::Command::new("fd")
        .arg("--glob")
        .arg(&query.pattern)
        .arg("--max-results")
        .arg(limit.to_string())
        .arg("--type")
        .arg("f")
        .current_dir(&absolute_path)
        .output()
        .map_err(|error| {
            AppError::internal(format!(
                "running local find for {}: {}",
                display_path, error
            ))
        })?;
    let output = if output.status.success() {
        output
    } else {
        std::process::Command::new("find")
            .arg(&absolute_path)
            .arg("-type")
            .arg("f")
            .arg("-name")
            .arg(&query.pattern)
            .output()
            .map_err(|error| {
                AppError::internal(format!(
                    "running fallback find for {}: {}",
                    display_path, error
                ))
            })?
    };

    let absolute_display = absolute_path.display().to_string().replace('\\', "/");
    let items = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let line = line.replace('\\', "/");
            if line.starts_with(&absolute_display) {
                strip_workspace_prefix(&line, root)
            } else if display_path == "." {
                line
            } else {
                format!("{display_path}/{}", line)
            }
        })
        .collect::<Vec<_>>();
    let truncated = items.len() >= limit;
    Ok(WorkspaceFindSnapshot {
        workspace_root: root.display().to_string(),
        path: display_path,
        match_count: items.len() as u64,
        truncated,
        items,
    })
}

fn build_workspace_file_snapshot(
    workspace_root: String,
    display_path: String,
    text: &str,
    byte_size: u64,
    offset: usize,
    limit: usize,
) -> AppResult<WorkspaceFileTextSnapshot> {
    let lines = text.lines().collect::<Vec<_>>();
    let total_lines = lines.len();
    let start = offset.saturating_sub(1).min(total_lines);
    let end = (start + limit).min(total_lines);
    let selected = if start >= total_lines {
        String::new()
    } else {
        lines[start..end].join("\n")
    };
    let (text, truncated) = truncate_workspace_text(&selected);

    Ok(WorkspaceFileTextSnapshot {
        workspace_root,
        path: display_path,
        text,
        truncated,
        byte_size,
        line_count: total_lines as u64,
        start_line: if total_lines == 0 {
            0
        } else {
            start as u64 + 1
        },
        end_line: end as u64,
    })
}

fn strip_workspace_prefix(line: &str, root: &Path) -> String {
    let root = root.display().to_string().replace('\\', "/");
    line.replacen(&format!("{root}/"), "", 1)
}

fn resolve_local_workspace_path(root: &Path, path: &str) -> AppResult<(PathBuf, String)> {
    let requested = normalize_workspace_request_path(path)?;
    let candidate = root.join(&requested);
    let absolute_path = std::fs::canonicalize(&candidate)
        .map_err(|error| map_workspace_io_error(error, &requested))?;

    if !absolute_path.starts_with(root) {
        return Err(AppError::bad_request(format!(
            "workspace path {} escapes the workspace root",
            requested
        )));
    }

    let display_path = relative_workspace_path(root, &absolute_path);
    Ok((absolute_path, display_path))
}

fn normalize_workspace_request_path(path: &str) -> AppResult<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "." {
        return Ok(".".to_string());
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(AppError::bad_request(
            "workspace paths must be relative to the active workspace root",
        ));
    }

    Ok(trimmed.to_string())
}

fn relative_workspace_path(root: &Path, absolute_path: &Path) -> String {
    match absolute_path.strip_prefix(root) {
        Ok(path) if path.as_os_str().is_empty() => ".".to_string(),
        Ok(path) => path.to_string_lossy().replace('\\', "/"),
        Err(_) => absolute_path.display().to_string(),
    }
}

fn workspace_child_path(parent: &str, name: &str) -> String {
    if parent == "." {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn workspace_entry_sort_key(kind: &WorkspaceEntryKind, name: &str) -> (u8, String) {
    let order = match kind {
        WorkspaceEntryKind::Directory => 0,
        WorkspaceEntryKind::File => 1,
    };
    (order, name.to_ascii_lowercase())
}

fn truncate_workspace_text(text: &str) -> (String, bool) {
    let line_count = text.lines().count();
    let char_count = text.chars().count();
    if line_count <= WORKSPACE_FILE_MAX_LINES && char_count <= WORKSPACE_FILE_MAX_CHARS {
        return (text.to_string(), false);
    }

    let limited_by_lines = text
        .lines()
        .take(WORKSPACE_FILE_MAX_LINES)
        .collect::<Vec<_>>()
        .join("\n");
    if limited_by_lines.chars().count() <= WORKSPACE_FILE_MAX_CHARS {
        return (limited_by_lines, true);
    }

    let truncated = limited_by_lines
        .chars()
        .take(WORKSPACE_FILE_MAX_CHARS)
        .collect::<String>();
    (truncated, true)
}

fn map_workspace_io_error(error: std::io::Error, path: &str) -> AppError {
    match error.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::not_found(format!("workspace path {} was not found", path))
        }
        std::io::ErrorKind::PermissionDenied => AppError::bad_request(format!(
            "permission denied while accessing workspace path {}",
            path
        )),
        _ => AppError::internal(format!("accessing workspace path {}: {}", path, error)),
    }
}

const SSH_WORKSPACE_ERROR_PREFIX: &str = "__KORDI_WORKSPACE_ERROR__:";
const SSH_LIST_SCRIPT: &str = r#"
set -eu

err() {
  code=$1
  message=$2
  printf '__KORDI_WORKSPACE_ERROR__:%s:%s\n' "$code" "$message" >&2
  exit 64
}

root_input=$1
requested=$2

case "$requested" in
  ""|".") requested="." ;;
esac

root_abs=$(cd "$root_input" 2>/dev/null && pwd -P) || err root_not_found "$root_input"

if [ "$requested" = "." ]; then
  target_abs="$root_abs"
else
  case "$requested" in
    /*) err absolute_path "$requested" ;;
    *) target_input="$root_abs/$requested" ;;
  esac

  if [ ! -e "$target_input" ]; then
    err not_found "$requested"
  fi

  target_abs=$(cd "$target_input" 2>/dev/null && pwd -P) || err not_found "$requested"
fi

case "$target_abs" in
  "$root_abs"|"$root_abs"/*) ;;
  *) err outside_root "$requested" ;;
esac

[ -d "$target_abs" ] || err not_directory "$requested"

find "$target_abs" -mindepth 1 -maxdepth 1 -exec sh -c '
  root_abs=$1
  shift
  for p do
    if [ -L "$p" ]; then
      continue
    fi
    name=$(basename "$p")
    rel=${p#"$root_abs"/}
    if [ "$p" = "$root_abs" ]; then
      rel="."
    fi
    if [ -d "$p" ]; then
      kind=directory
      size=""
    elif [ -f "$p" ]; then
      kind=file
      size=$(wc -c < "$p" | tr -d "[:space:]")
    else
      continue
    fi
    printf "%s\0%s\0%s\0%s\0" "$rel" "$name" "$kind" "$size"
  done
' sh "$root_abs" {} +
"#;

const SSH_READ_FILE_SCRIPT: &str = r#"
set -eu

err() {
  code=$1
  message=$2
  printf '__KORDI_WORKSPACE_ERROR__:%s:%s\n' "$code" "$message" >&2
  exit 64
}

root_input=$1
requested=$2
start_line=$3
limit=$4

[ -n "$requested" ] || err not_found "$requested"
[ "$requested" != "." ] || err not_file "$requested"

root_abs=$(cd "$root_input" 2>/dev/null && pwd -P) || err root_not_found "$root_input"

case "$requested" in
  /*) err absolute_path "$requested" ;;
  *) target_input="$root_abs/$requested" ;;
esac

[ -e "$target_input" ] || err not_found "$requested"
[ ! -L "$target_input" ] || err symlink_not_supported "$requested"

parent=$(dirname "$target_input")
name=$(basename "$target_input")
parent_abs=$(cd "$parent" 2>/dev/null && pwd -P) || err not_found "$requested"
target_abs="$parent_abs/$name"

case "$target_abs" in
  "$root_abs"|"$root_abs"/*) ;;
  *) err outside_root "$requested" ;;
esac

[ -f "$target_abs" ] || err not_file "$requested"
line_count=$(wc -l < "$target_abs" | tr -d '[:space:]')
byte_size=$(wc -c < "$target_abs" | tr -d '[:space:]')
end_line=$((start_line + limit - 1))
printf '%s\0%s\0' "$line_count" "$byte_size"
sed -n "${start_line},${end_line}p" "$target_abs"
"#;

const SSH_GREP_SCRIPT: &str = r#"
set -eu

err() {
  code=$1
  message=$2
  printf '__KORDI_WORKSPACE_ERROR__:%s:%s\n' "$code" "$message" >&2
  exit 64
}

root_input=$1
requested=$2
pattern=$3
glob=$4
ignore_case=$5
literal=$6
context_lines=$7
limit=$8

case "$requested" in
  ""|".") requested="." ;;
esac

root_abs=$(cd "$root_input" 2>/dev/null && pwd -P) || err root_not_found "$root_input"
if [ "$requested" = "." ]; then
  target_abs="$root_abs"
else
  case "$requested" in
    /*) err absolute_path "$requested" ;;
    *) target_input="$root_abs/$requested" ;;
  esac
  [ -e "$target_input" ] || err not_found "$requested"
  target_abs=$(cd "$target_input" 2>/dev/null && pwd -P) || target_abs="$target_input"
fi

case "$target_abs" in
  "$root_abs"|"$root_abs"/*) ;;
  *) err outside_root "$requested" ;;
esac

flags='-n'
if [ "$ignore_case" = 'true' ]; then
  flags="$flags -i"
fi
if [ "$literal" = 'true' ]; then
  flags="$flags -F"
fi
if [ "$context_lines" -gt 0 ]; then
  flags="$flags -C $context_lines"
fi

run_grep_file() {
  file=$1
  grep $flags -- "$pattern" "$file" || true
}

count=0
if [ -d "$target_abs" ]; then
  find "$target_abs" -type f -exec sh -c '
    root_abs=$1
    glob=$2
    pattern=$3
    flags=$4
    limit=$5
    count=0
    shift 5
    for file do
      rel=${file#"$root_abs"/}
      if [ -n "$glob" ]; then
        case "$rel" in
          $glob) ;;
          *) continue ;;
        esac
      fi
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        line=${line#"$file"}
        printf "%s%s\n" "$rel" "$line"
        count=$((count + 1))
        [ "$count" -lt "$limit" ] || exit 0
      done <<EOF
$(grep $flags -- "$pattern" "$file" || true)
EOF
    done
  ' sh "$root_abs" "$glob" "$pattern" "$flags" "$limit" {} +
else
  rel=${target_abs#"$root_abs"/}
  case "$glob" in
    '') ;;
    *) case "$rel" in $glob) ;; *) exit 0 ;; esac ;;
  esac
  grep $flags -- "$pattern" "$target_abs" | sed "s#^#$rel:#" | head -n "$limit" || true
fi
"#;

const SSH_FIND_SCRIPT: &str = r#"
set -eu

err() {
  code=$1
  message=$2
  printf '__KORDI_WORKSPACE_ERROR__:%s:%s\n' "$code" "$message" >&2
  exit 64
}

root_input=$1
requested=$2
pattern=$3
limit=$4

case "$requested" in
  ""|".") requested="." ;;
esac

root_abs=$(cd "$root_input" 2>/dev/null && pwd -P) || err root_not_found "$root_input"
if [ "$requested" = "." ]; then
  target_abs="$root_abs"
else
  case "$requested" in
    /*) err absolute_path "$requested" ;;
    *) target_input="$root_abs/$requested" ;;
  esac
  [ -e "$target_input" ] || err not_found "$requested"
  target_abs=$(cd "$target_input" 2>/dev/null && pwd -P) || target_abs="$target_input"
fi

case "$target_abs" in
  "$root_abs"|"$root_abs"/*) ;;
  *) err outside_root "$requested" ;;
esac

count=0
find "$target_abs" -type f -exec sh -c '
  root_abs=$1
  pattern=$2
  limit=$3
  count=0
  shift 3
  for file do
    rel=${file#"$root_abs"/}
    case "$rel" in
      $pattern)
        printf "%s\n" "$rel"
        count=$((count + 1))
        [ "$count" -lt "$limit" ] || exit 0
        ;;
    esac
  done
' sh "$root_abs" "$pattern" "$limit" {} +
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspaceReferenceExpansion {
    replacement_text: String,
}

fn ssh_destination(environment: &SshEnvironment) -> String {
    match &environment.user {
        Some(user) => format!("{user}@{}", environment.host),
        None => environment.host.clone(),
    }
}

fn build_ssh_remote_command(args: &[String]) -> String {
    let mut command = String::from("sh -s --");
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    command
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn parse_ssh_remote_error(stderr: &str) -> Option<SshCommandError> {
    stderr.lines().find_map(|line| {
        let payload = line.strip_prefix(SSH_WORKSPACE_ERROR_PREFIX)?;
        let mut parts = payload.splitn(2, ':');
        let code = parts.next()?.trim();
        let detail = parts.next().unwrap_or("").trim();
        Some(SshCommandError::Remote {
            code: code.to_string(),
            detail: detail.to_string(),
        })
    })
}

fn list_ssh_workspace_entries(
    ssh_runner: &dyn SshCommandRunner,
    environment: &SshEnvironment,
    path: &str,
) -> AppResult<WorkspaceEntriesSnapshot> {
    let requested = normalize_workspace_request_path(path)?;
    let payload = ssh_runner
        .run_script(
            environment,
            SSH_LIST_SCRIPT,
            &[environment.remote_root.clone(), requested.clone()],
        )
        .map_err(|error| map_ssh_command_error(error, &requested))?;
    parse_ssh_workspace_entries_payload(&environment.remote_root, &requested, &payload)
}

fn parse_ssh_workspace_entries_payload(
    workspace_root: &str,
    requested: &str,
    payload: &[u8],
) -> AppResult<WorkspaceEntriesSnapshot> {
    let mut raw_fields = payload.split(|byte| *byte == 0).collect::<Vec<_>>();
    if raw_fields.last().is_some_and(|field| field.is_empty()) {
        raw_fields.pop();
    }
    let fields = raw_fields
        .into_iter()
        .map(|field| {
            String::from_utf8(field.to_vec()).map_err(|error| {
                AppError::internal(format!("decoding ssh workspace entry: {error}"))
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    if fields.len() % 4 != 0 {
        return Err(AppError::internal(
            "ssh workspace listing returned a malformed payload",
        ));
    }

    let mut items = Vec::new();
    for chunk in fields.chunks_exact(4) {
        let kind = match chunk[2].as_str() {
            "directory" => WorkspaceEntryKind::Directory,
            "file" => WorkspaceEntryKind::File,
            other => {
                return Err(AppError::internal(format!(
                    "ssh workspace listing returned an unknown entry kind {other}"
                )));
            }
        };
        let size = if chunk[3].trim().is_empty() {
            None
        } else {
            Some(chunk[3].parse::<u64>().map_err(|error| {
                AppError::internal(format!("decoding ssh workspace entry size: {error}"))
            })?)
        };
        items.push(WorkspaceEntrySummary {
            path: chunk[0].clone(),
            name: chunk[1].clone(),
            kind,
            size,
        });
    }

    items.sort_by(|left, right| {
        workspace_entry_sort_key(&left.kind, &left.name)
            .cmp(&workspace_entry_sort_key(&right.kind, &right.name))
    });

    Ok(WorkspaceEntriesSnapshot {
        workspace_root: workspace_root.to_string(),
        path: requested.to_string(),
        items,
    })
}

fn read_ssh_workspace_file(
    ssh_runner: &dyn SshCommandRunner,
    environment: &SshEnvironment,
    path: &str,
    offset: usize,
    limit: usize,
) -> AppResult<WorkspaceFileTextSnapshot> {
    let requested = normalize_workspace_request_path(path)?;
    let payload = ssh_runner
        .run_script(
            environment,
            SSH_READ_FILE_SCRIPT,
            &[
                environment.remote_root.clone(),
                requested.clone(),
                offset.to_string(),
                limit.to_string(),
            ],
        )
        .map_err(|error| map_ssh_command_error(error, &requested))?;
    let mut parts = payload.splitn(3, |byte| *byte == 0);
    let line_count = parts
        .next()
        .ok_or_else(|| AppError::internal("missing ssh file line count"))
        .and_then(|value| {
            String::from_utf8(value.to_vec())
                .map_err(|error| AppError::internal(format!("decoding ssh line count: {error}")))
        })?
        .parse::<u64>()
        .map_err(|error| AppError::internal(format!("parsing ssh line count: {error}")))?;
    let byte_size = parts
        .next()
        .ok_or_else(|| AppError::internal("missing ssh file byte size"))
        .and_then(|value| {
            String::from_utf8(value.to_vec())
                .map_err(|error| AppError::internal(format!("decoding ssh byte size: {error}")))
        })?
        .parse::<u64>()
        .map_err(|error| AppError::internal(format!("parsing ssh byte size: {error}")))?;
    let body = parts.next().unwrap_or_default().to_vec();
    let text = String::from_utf8(body).map_err(|_| {
        AppError::not_implemented(format!(
            "workspace file {} is not valid utf-8 yet",
            requested
        ))
    })?;
    let (text, truncated) = truncate_workspace_text(&text);
    let start_line = if line_count == 0 { 0 } else { offset as u64 };
    let end_line = if line_count == 0 {
        0
    } else {
        ((offset + limit).saturating_sub(1)).min(line_count as usize) as u64
    };

    Ok(WorkspaceFileTextSnapshot {
        workspace_root: environment.remote_root.clone(),
        path: requested,
        text,
        truncated,
        byte_size,
        line_count,
        start_line,
        end_line,
    })
}

fn grep_ssh_workspace(
    ssh_runner: &dyn SshCommandRunner,
    environment: &SshEnvironment,
    query: &WorkspaceGrepQuery,
) -> AppResult<WorkspaceGrepSnapshot> {
    let requested = query.path.as_deref().unwrap_or(".");
    let requested = normalize_workspace_request_path(requested)?;
    let limit = query.limit.unwrap_or(100).clamp(1, 2000);
    let payload = ssh_runner
        .run_script(
            environment,
            SSH_GREP_SCRIPT,
            &[
                environment.remote_root.clone(),
                requested.clone(),
                query.pattern.clone(),
                query.glob.clone().unwrap_or_default(),
                query.ignore_case.unwrap_or(false).to_string(),
                query.literal.unwrap_or(false).to_string(),
                query.context.unwrap_or(0).to_string(),
                limit.to_string(),
            ],
        )
        .map_err(|error| map_ssh_command_error(error, &requested))?;
    let items = String::from_utf8(payload)
        .map_err(|error| AppError::internal(format!("decoding ssh grep output: {error}")))?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    Ok(WorkspaceGrepSnapshot {
        workspace_root: environment.remote_root.clone(),
        path: requested,
        match_count: items.len() as u64,
        truncated: items.len() >= limit,
        items,
    })
}

fn find_ssh_workspace(
    ssh_runner: &dyn SshCommandRunner,
    environment: &SshEnvironment,
    query: &WorkspaceFindQuery,
) -> AppResult<WorkspaceFindSnapshot> {
    let requested = query.path.as_deref().unwrap_or(".");
    let requested = normalize_workspace_request_path(requested)?;
    let limit = query.limit.unwrap_or(1000).clamp(1, 5000);
    let payload = ssh_runner
        .run_script(
            environment,
            SSH_FIND_SCRIPT,
            &[
                environment.remote_root.clone(),
                requested.clone(),
                query.pattern.clone(),
                limit.to_string(),
            ],
        )
        .map_err(|error| map_ssh_command_error(error, &requested))?;
    let items = String::from_utf8(payload)
        .map_err(|error| AppError::internal(format!("decoding ssh find output: {error}")))?
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    Ok(WorkspaceFindSnapshot {
        workspace_root: environment.remote_root.clone(),
        path: requested,
        match_count: items.len() as u64,
        truncated: items.len() >= limit,
        items,
    })
}

fn map_ssh_command_error(error: SshCommandError, path: &str) -> AppError {
    match error {
        SshCommandError::Remote { code, detail } => match code.as_str() {
            "not_found" => AppError::not_found(format!("workspace path {} was not found", path)),
            "absolute_path" | "outside_root" => AppError::bad_request(format!(
                "workspace path {} escapes the workspace root",
                detail.if_empty_then(path)
            )),
            "not_directory" => {
                AppError::bad_request(format!("workspace path {} is not a directory", path))
            }
            "not_file" => AppError::bad_request(format!("workspace path {} is not a file", path)),
            "symlink_not_supported" => AppError::bad_request(format!(
                "workspace path {} points to a symlink, which is not supported yet",
                path
            )),
            "root_not_found" => AppError::bad_gateway(format!(
                "ssh workspace root {} was not found on the remote host",
                detail
            )),
            _ => AppError::bad_gateway(format!(
                "ssh workspace access failed for {}: {} ({})",
                path, code, detail
            )),
        },
        SshCommandError::Transport { detail } => AppError::bad_gateway(format!(
            "ssh workspace access failed for {}: {}",
            path, detail
        )),
    }
}

fn render_workspace_entries_reference(snapshot: &WorkspaceEntriesSnapshot) -> String {
    let display_path = if snapshot.path == "." {
        snapshot.workspace_root.as_str()
    } else {
        snapshot.path.as_str()
    };
    let mut out = format!("Directory listing for {display_path}:\n```text\n{display_path}/\n");
    for item in &snapshot.items {
        out.push_str("  ");
        out.push_str(&item.name);
        if item.kind == WorkspaceEntryKind::Directory {
            out.push('/');
        }
        out.push('\n');
    }
    out.push_str("```");
    out
}

fn render_workspace_file_reference(snapshot: &WorkspaceFileTextSnapshot) -> String {
    let suffix = if snapshot.truncated {
        " (truncated)"
    } else {
        ""
    };
    format!(
        "Contents of {}{}:\n```\n{}\n```",
        snapshot.path, suffix, snapshot.text
    )
}

fn load_workspace_reference_expansion(
    state: &AppState,
    path: &str,
) -> Result<Option<WorkspaceReferenceExpansion>, String> {
    match state.environment.read_workspace_file(
        state.ssh_runner.as_ref(),
        path,
        1,
        WORKSPACE_FILE_MAX_LINES,
    ) {
        Ok(snapshot) => {
            return Ok(Some(WorkspaceReferenceExpansion {
                replacement_text: render_workspace_file_reference(&snapshot),
            }));
        }
        Err(error) if error.status == StatusCode::NOT_FOUND => return Ok(None),
        Err(error)
            if error.status == StatusCode::BAD_REQUEST
                && error.message.contains("is not a file") => {}
        Err(error) => return Err(error.message),
    }

    match state
        .environment
        .list_workspace_entries(state.ssh_runner.as_ref(), path)
    {
        Ok(snapshot) => Ok(Some(WorkspaceReferenceExpansion {
            replacement_text: render_workspace_entries_reference(&snapshot),
        })),
        Err(error) if error.status == StatusCode::NOT_FOUND => Ok(None),
        Err(error) => Err(error.message),
    }
}

fn expand_workspace_input(state: &AppState, input: &str) -> ExpandedWorkspaceInputSnapshot {
    let mut text = String::new();
    let mut expanded_paths = Vec::new();
    let mut warnings = Vec::new();
    let mut cursor = 0usize;

    while cursor < input.len() {
        let Some(ch) = input[cursor..].chars().next() else {
            break;
        };

        if ch == '@'
            && is_at_reference_boundary(input, cursor)
            && let Some((end, raw_path)) = parse_workspace_reference(input, cursor)
        {
            match load_workspace_reference_expansion(state, &raw_path) {
                Ok(Some(expanded)) => {
                    text.push_str(&expanded.replacement_text);
                    expanded_paths.push(raw_path);
                    cursor = end;
                    continue;
                }
                Ok(None) => {}
                Err(message) => warnings.push(message),
            }
        }

        text.push(ch);
        cursor += ch.len_utf8();
    }

    ExpandedWorkspaceInputSnapshot {
        text,
        expanded_paths,
        warnings,
    }
}

fn is_at_reference_boundary(text: &str, at_pos: usize) -> bool {
    text[..at_pos]
        .chars()
        .next_back()
        .is_none_or(|ch| ch.is_whitespace() || matches!(ch, '(' | '[' | '{' | ':' | ','))
}

fn parse_workspace_reference(text: &str, at_pos: usize) -> Option<(usize, String)> {
    let rest = &text[at_pos + 1..];
    if rest.is_empty() {
        return None;
    }

    let mut chars = rest.char_indices();
    let (_, first) = chars.next()?;
    if first == '"' || first == '\'' {
        let quote = first;
        let mut value = String::new();
        for (offset, ch) in chars {
            if ch == quote {
                return Some((at_pos + 1 + offset + ch.len_utf8(), value));
            }
            value.push(ch);
        }
        return None;
    }

    let mut end = rest.len();
    for (offset, ch) in rest.char_indices() {
        if ch.is_whitespace() || matches!(ch, ')' | ']' | '}' | ',' | ';') {
            end = offset;
            break;
        }
    }
    if end == 0 {
        return None;
    }

    Some((at_pos + 1 + end, rest[..end].to_string()))
}

trait EmptyFallback {
    fn if_empty_then<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl EmptyFallback for str {
    fn if_empty_then<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.trim().is_empty() {
            fallback
        } else {
            self
        }
    }
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

fn workspace_root_name_from_display_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(|ch| ch == '/' || ch == '\\');
    if trimmed.is_empty() {
        return path.to_string();
    }

    trimmed
        .rsplit(|ch| ch == '/' || ch == '\\')
        .next()
        .unwrap_or(trimmed)
        .to_string()
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
    if let Ok(path) = std::env::var("KORDI_BB_BIN") {
        if !path.trim().is_empty() {
            return TurnCommand {
                program: path,
                base_args: Vec::new(),
                current_dir: None,
            };
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
    use bb_core::types::{EntryBase, EntryId, UserMessage};
    use chrono::Utc;
    use tempfile::TempDir;
    use tokio::sync::Notify;
    use tower::util::ServiceExt;

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

    #[derive(Clone, Default)]
    struct FakeSshCommandRunner {
        responses: Arc<
            std::sync::Mutex<
                HashMap<(String, String), std::result::Result<Vec<u8>, SshCommandError>>,
            >,
        >,
    }

    impl FakeSshCommandRunner {
        fn with_success(operation: &str, path: &str, payload: Vec<u8>) -> Self {
            let runner = Self::default();
            runner
                .responses
                .lock()
                .expect("responses lock")
                .insert((operation.to_string(), path.to_string()), Ok(payload));
            runner
        }

        fn with_error(operation: &str, path: &str, error: SshCommandError) -> Self {
            let runner = Self::default();
            runner
                .responses
                .lock()
                .expect("responses lock")
                .insert((operation.to_string(), path.to_string()), Err(error));
            runner
        }
    }

    impl SshCommandRunner for FakeSshCommandRunner {
        fn run_script(
            &self,
            _environment: &SshEnvironment,
            script: &str,
            args: &[String],
        ) -> Result<Vec<u8>, SshCommandError> {
            let operation = if script == SSH_LIST_SCRIPT {
                "list"
            } else if script == SSH_READ_FILE_SCRIPT {
                "read"
            } else if script == SSH_GREP_SCRIPT {
                "grep"
            } else if script == SSH_FIND_SCRIPT {
                "find"
            } else {
                panic!("unexpected ssh script")
            };
            let path = args.get(1).cloned().unwrap_or_else(|| ".".to_string());
            self.responses
                .lock()
                .expect("responses lock")
                .get(&(operation.to_string(), path.clone()))
                .cloned()
                .unwrap_or_else(|| {
                    Err(SshCommandError::Remote {
                        code: "not_found".to_string(),
                        detail: path,
                    })
                })
        }
    }

    fn test_server(
        environment: AppEnvironment,
        sessions_db_path: PathBuf,
        bridges_status: std::result::Result<BridgesStatusResponse, String>,
        turn_executor: FakeTurnExecutor,
    ) -> AppServer {
        test_server_with_ssh_runner(
            environment,
            Arc::new(FakeSshCommandRunner::default()),
            sessions_db_path,
            bridges_status,
            turn_executor,
        )
    }

    fn test_server_with_ssh_runner(
        environment: AppEnvironment,
        ssh_runner: Arc<dyn SshCommandRunner>,
        sessions_db_path: PathBuf,
        bridges_status: std::result::Result<BridgesStatusResponse, String>,
        turn_executor: FakeTurnExecutor,
    ) -> AppServer {
        test_server_with_workspace_api_base_url(
            environment,
            ssh_runner,
            sessions_db_path,
            bridges_status,
            turn_executor,
            Some("http://127.0.0.1:7080".to_string()),
        )
    }

    fn test_server_with_workspace_api_base_url(
        environment: AppEnvironment,
        ssh_runner: Arc<dyn SshCommandRunner>,
        sessions_db_path: PathBuf,
        bridges_status: std::result::Result<BridgesStatusResponse, String>,
        turn_executor: FakeTurnExecutor,
        workspace_api_base_url: Option<String>,
    ) -> AppServer {
        AppServer {
            state: Arc::new(AppState {
                environment,
                ssh_runner,
                sessions_db_path,
                workspace_api_base_url,
                bridges_status: Arc::new(FakeBridgesStatusProvider {
                    response: bridges_status,
                }),
                turn_executor: Arc::new(turn_executor),
                active_turns: Arc::new(Mutex::new(HashMap::new())),
            }),
        }
    }

    fn local_test_environment(cwd: PathBuf) -> AppEnvironment {
        AppEnvironment::local(cwd).expect("local environment")
    }

    fn sample_ssh_environment() -> AppEnvironment {
        AppEnvironment::Ssh(SshEnvironment {
            environment_id: "prod-kordi".to_string(),
            display_name: "SSH prod-kordi".to_string(),
            connection_state: EnvironmentConnectionState::Connected,
            alias: Some("prod-kordi".to_string()),
            host: "prod.example.com".to_string(),
            port: Some(22),
            user: Some("ubuntu".to_string()),
            remote_root: "/srv/prod/kordi".to_string(),
        })
    }

    fn ssh_file_payload(text: &str) -> Vec<u8> {
        let line_count = text.lines().count().to_string();
        let byte_size = text.len().to_string();
        [
            line_count.as_bytes(),
            b"\0".as_slice(),
            byte_size.as_bytes(),
            b"\0".as_slice(),
            text.as_bytes(),
        ]
        .concat()
    }

    #[test]
    fn from_environment_config_builds_ssh_environment() {
        let server = AppServer::from_environment_config(AppServerEnvironmentConfig::Ssh(
            SshEnvironmentConfig {
                environment_id: None,
                display_name: None,
                connection_state: EnvironmentConnectionState::Disconnected,
                alias: Some("prod-kordi".to_string()),
                host: "prod.example.com".to_string(),
                port: Some(2222),
                user: Some("ubuntu".to_string()),
                remote_root: "/srv/prod/kordi".to_string(),
            },
        ))
        .expect("ssh environment config");

        let summary = server.state.environment.summary();
        assert_eq!(summary.environment_id, "prod-kordi");
        assert_eq!(summary.kind, EnvironmentKind::Ssh);
        assert_eq!(
            summary.connection_state,
            EnvironmentConnectionState::Disconnected
        );
        let ssh = summary.ssh.expect("ssh summary");
        assert_eq!(ssh.host, "prod.example.com");
        assert_eq!(ssh.port, Some(2222));
        assert_eq!(ssh.user.as_deref(), Some("ubuntu"));
    }

    #[test]
    fn build_prepared_turn_command_for_ssh_sets_workspace_api_env_and_safe_tools() {
        let prepared = build_prepared_turn_command(
            &TurnCommand {
                program: "kordi".to_string(),
                base_args: vec!["--verbose".to_string()],
                current_dir: Some(PathBuf::from("/tmp/kordi-launch")),
            },
            &TurnExecution {
                turn_id: "turn-1".to_string(),
                session_id: "session-1".to_string(),
                environment: sample_ssh_environment(),
                input: "Summarize the deployment plan".to_string(),
                model: None,
                thinking: None,
                workspace_api_base_url: Some("http://127.0.0.1:7080".to_string()),
            },
        )
        .expect("prepared command");

        assert_eq!(prepared.args[0], "--verbose");
        assert!(
            prepared
                .args
                .windows(2)
                .any(|pair| pair == ["--tools", SSH_REMOTE_TOOL_SELECTION])
        );
        assert!(
            prepared
                .args
                .windows(2)
                .any(|pair| pair == ["-C", "/tmp/kordi-launch"])
        );
        assert!(
            prepared
                .args
                .windows(2)
                .any(|pair| pair == ["--session", "session-1"])
        );
        assert_eq!(
            prepared.args.last().map(|value| value.as_str()),
            Some("Summarize the deployment plan")
        );

        let env = prepared
            .env
            .into_iter()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect::<HashMap<_, _>>();
        assert_eq!(
            env.get(WORKSPACE_API_BASE_URL_ENV).map(String::as_str),
            Some("http://127.0.0.1:7080")
        );
        assert_eq!(
            env.get(WORKSPACE_SESSION_SCOPE_KEY_ENV).map(String::as_str),
            Some("ssh:prod-kordi:/srv/prod/kordi")
        );
        assert_eq!(
            env.get(WORKSPACE_LOCATOR_ENV).map(String::as_str),
            Some("/srv/prod/kordi")
        );
        assert_eq!(
            env.get(WORKSPACE_ENVIRONMENT_KIND_ENV).map(String::as_str),
            Some("ssh")
        );
        assert_eq!(
            env.get(WORKSPACE_DISABLE_EXTENSIONS_ENV)
                .map(String::as_str),
            Some("1")
        );
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
        let environment = local_test_environment(cwd.clone());
        let session_scope_key = environment.session_scope_key();
        let session_id = create_session_with_message(
            &conn,
            &session_scope_key,
            "First session",
            "hello from bootstrap",
        );

        let app = test_server(
            environment,
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
        assert_eq!(snapshot.workspace.environment.environment_id, "local");
        assert_eq!(snapshot.workspace.environment.kind, EnvironmentKind::Local);
        assert_eq!(
            snapshot.workspace.environment.connection_state,
            EnvironmentConnectionState::Connected
        );
        assert!(snapshot.workspace.environment.ssh.is_none());
        assert_eq!(snapshot.services.runtime.state, ServiceState::Ready);
        assert_eq!(snapshot.services.bridges.state, ServiceState::Ready);
        assert_eq!(
            snapshot.current_session_id.as_deref(),
            Some(session_id.as_str())
        );
    }

    #[tokio::test]
    async fn bootstrap_reports_ssh_environment_metadata_and_scoped_sessions() {
        let temp = TempDir::new().expect("tempdir");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let environment = sample_ssh_environment();
        let session_scope_key = environment.session_scope_key();
        let session_id = create_session_with_message(
            &conn,
            &session_scope_key,
            "Remote session",
            "hello from remote bootstrap",
        );

        let app = test_server(
            environment.clone(),
            db_path,
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );
        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/bootstrap")
                    .header("x-kordi-client-kind", "desktop")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: BootstrapSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("bootstrap json");

        assert_eq!(snapshot.workspace.cwd, "/srv/prod/kordi");
        assert_eq!(snapshot.workspace.root_name, "kordi");
        assert_eq!(snapshot.workspace.platform, "ssh-remote");
        assert_eq!(snapshot.workspace.environment.environment_id, "prod-kordi");
        assert_eq!(snapshot.workspace.environment.kind, EnvironmentKind::Ssh);
        let ssh = snapshot
            .workspace
            .environment
            .ssh
            .as_ref()
            .expect("ssh environment summary");
        assert_eq!(ssh.alias.as_deref(), Some("prod-kordi"));
        assert_eq!(ssh.host, "prod.example.com");
        assert_eq!(ssh.port, Some(22));
        assert_eq!(ssh.user.as_deref(), Some("ubuntu"));
        assert_eq!(ssh.remote_root, "/srv/prod/kordi");
        assert_eq!(
            snapshot.current_session_id.as_deref(),
            Some(session_id.as_str())
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
        let page: SessionsPage = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("sessions json");

        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].cwd.as_deref(), Some("/srv/prod/kordi"));
    }

    #[tokio::test]
    async fn workspace_entries_endpoint_reads_local_workspace() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        std::fs::create_dir_all(cwd.join("src")).expect("create src");
        std::fs::write(cwd.join("README.md"), "# Hello\n").expect("write readme");
        std::fs::write(cwd.join("src").join("main.rs"), "fn main() {}\n").expect("write main");

        let app = test_server(
            local_test_environment(cwd),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/entries?path=.")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: WorkspaceEntriesSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("workspace entries json");

        assert_eq!(snapshot.path, ".");
        assert_eq!(snapshot.items.len(), 2);
        assert_eq!(snapshot.items[0].kind, WorkspaceEntryKind::Directory);
        assert_eq!(snapshot.items[0].path, "src");
        assert_eq!(snapshot.items[1].kind, WorkspaceEntryKind::File);
        assert_eq!(snapshot.items[1].path, "README.md");
    }

    #[tokio::test]
    async fn workspace_file_endpoint_reads_local_text_file() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        std::fs::create_dir_all(cwd.join("src")).expect("create src");
        std::fs::write(
            cwd.join("src").join("main.rs"),
            "fn main() {\n    println!(\"hi\");\n}\n",
        )
        .expect("write main");

        let app = test_server(
            local_test_environment(cwd),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/file?path=src/main.rs")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: WorkspaceFileTextSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("workspace file json");

        assert_eq!(snapshot.path, "src/main.rs");
        assert!(!snapshot.truncated);
        assert!(snapshot.text.contains("println!"));
        assert_eq!(snapshot.line_count, 3);
        assert_eq!(snapshot.start_line, 1);
        assert_eq!(snapshot.end_line, 3);
    }

    #[tokio::test]
    async fn workspace_grep_endpoint_reads_local_workspace() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        std::fs::create_dir_all(cwd.join("src")).expect("create src");
        std::fs::write(cwd.join("README.md"), "hello remote\n").expect("write readme");
        std::fs::write(
            cwd.join("src").join("main.rs"),
            "println!(\"hello remote\");\n",
        )
        .expect("write main");

        let app = test_server(
            local_test_environment(cwd),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/grep?pattern=hello%20remote&literal=true&limit=10")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: WorkspaceGrepSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("workspace grep json");

        assert!(snapshot.match_count >= 2);
        assert!(snapshot.items.iter().any(|line| line.contains("README.md")));
    }

    #[tokio::test]
    async fn workspace_find_endpoint_reads_local_workspace() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        std::fs::create_dir_all(cwd.join("src")).expect("create src");
        std::fs::write(cwd.join("src").join("main.rs"), "fn main() {}\n").expect("write main");
        std::fs::write(cwd.join("src").join("lib.rs"), "pub fn lib() {}\n").expect("write lib");

        let app = test_server(
            local_test_environment(cwd),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/find?pattern=*.rs&limit=10")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: WorkspaceFindSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("workspace find json");

        assert!(snapshot.match_count >= 2);
        assert!(
            snapshot
                .items
                .iter()
                .any(|path| path.ends_with("src/main.rs"))
        );
    }

    #[tokio::test]
    async fn workspace_entries_endpoint_reads_ssh_workspace() {
        let temp = TempDir::new().expect("tempdir");
        let payload = [
            b"logs\0logs\0directory\0\0".as_slice(),
            b"README.md\0README.md\0file\0".as_slice(),
            b"12\0".as_slice(),
        ]
        .concat();
        let app = test_server_with_ssh_runner(
            sample_ssh_environment(),
            Arc::new(FakeSshCommandRunner::with_success("list", ".", payload)),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/entries?path=.")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: WorkspaceEntriesSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("workspace entries json");

        assert_eq!(snapshot.workspace_root, "/srv/prod/kordi");
        assert_eq!(snapshot.items.len(), 2);
        assert_eq!(snapshot.items[0].kind, WorkspaceEntryKind::Directory);
        assert_eq!(snapshot.items[0].path, "logs");
        assert_eq!(snapshot.items[1].kind, WorkspaceEntryKind::File);
        assert_eq!(snapshot.items[1].path, "README.md");
    }

    #[tokio::test]
    async fn workspace_file_endpoint_reads_ssh_text_file() {
        let temp = TempDir::new().expect("tempdir");
        let app = test_server_with_ssh_runner(
            sample_ssh_environment(),
            Arc::new(FakeSshCommandRunner::with_success(
                "read",
                "src/main.rs",
                ssh_file_payload("fn main() {\n    println!(\"hi\");\n}\n"),
            )),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/file?path=src/main.rs")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: WorkspaceFileTextSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("workspace file json");

        assert_eq!(snapshot.workspace_root, "/srv/prod/kordi");
        assert_eq!(snapshot.path, "src/main.rs");
        assert_eq!(snapshot.line_count, 3);
        assert!(snapshot.text.contains("println!"));
    }

    #[tokio::test]
    async fn workspace_grep_endpoint_reads_ssh_workspace() {
        let temp = TempDir::new().expect("tempdir");
        let app = test_server_with_ssh_runner(
            sample_ssh_environment(),
            Arc::new(FakeSshCommandRunner::with_success(
                "grep",
                ".",
                b"README.md:1:hello remote\nsrc/main.rs:1:hello remote\n".to_vec(),
            )),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/grep?pattern=hello%20remote&literal=true&limit=10")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: WorkspaceGrepSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("workspace grep json");

        assert_eq!(snapshot.match_count, 2);
        assert!(snapshot.items.iter().any(|line| line.contains("README.md")));
    }

    #[tokio::test]
    async fn workspace_find_endpoint_reads_ssh_workspace() {
        let temp = TempDir::new().expect("tempdir");
        let app = test_server_with_ssh_runner(
            sample_ssh_environment(),
            Arc::new(FakeSshCommandRunner::with_success(
                "find",
                ".",
                b"src/main.rs\nsrc/lib.rs\n".to_vec(),
            )),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/find?pattern=*.rs&limit=10")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: WorkspaceFindSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("workspace find json");

        assert_eq!(snapshot.match_count, 2);
        assert!(snapshot.items.iter().any(|path| path == "src/main.rs"));
    }

    #[tokio::test]
    async fn workspace_file_endpoint_surfaces_ssh_missing_path() {
        let temp = TempDir::new().expect("tempdir");
        let app = test_server_with_ssh_runner(
            sample_ssh_environment(),
            Arc::new(FakeSshCommandRunner::with_error(
                "read",
                "missing.txt",
                SshCommandError::Remote {
                    code: "not_found".to_string(),
                    detail: "missing.txt".to_string(),
                },
            )),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .uri("/v1/workspace/file?path=missing.txt")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn expand_input_endpoint_expands_ssh_file_references() {
        let temp = TempDir::new().expect("tempdir");
        let app = test_server_with_ssh_runner(
            sample_ssh_environment(),
            Arc::new(FakeSshCommandRunner::with_success(
                "read",
                "README.md",
                ssh_file_payload("# Remote readme\n"),
            )),
            temp.path().join("sessions.db"),
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
        );

        let response = app
            .router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/workspace/expand-input")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&ExpandWorkspaceInputRequest {
                            input: "Summarize @README.md".to_string(),
                        })
                        .expect("request json"),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");

        assert_eq!(response.status(), StatusCode::OK);
        let snapshot: ExpandedWorkspaceInputSnapshot = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body"),
        )
        .expect("expanded input json");

        assert_eq!(snapshot.expanded_paths, vec!["README.md"]);
        assert!(snapshot.text.contains("Contents of README.md"));
        assert!(snapshot.text.contains("Remote readme"));
        assert!(snapshot.warnings.is_empty());
    }

    #[tokio::test]
    async fn sessions_endpoint_reads_existing_session_store() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let environment = local_test_environment(cwd);
        let session_scope_key = environment.session_scope_key();
        create_session_with_message(&conn, &session_scope_key, "Alpha", "first preview");
        create_session_with_message(&conn, &session_scope_key, "Beta", "second preview");

        let app = test_server(
            environment,
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
    async fn submit_turn_accepts_existing_session_and_marks_it_running() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let environment = local_test_environment(cwd);
        let session_scope_key = environment.session_scope_key();
        let session_id = create_session_with_message(&conn, &session_scope_key, "Alpha", "ready");
        let gate = Arc::new(Notify::new());
        let executor = FakeTurnExecutor {
            calls: Arc::new(Mutex::new(Vec::new())),
            gate: Some(gate.clone()),
        };

        let app = test_server(
            environment,
            db_path,
            Ok(sample_bridges_status()),
            executor.clone(),
        );

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
    async fn submit_turn_expands_workspace_file_references_before_execution() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        std::fs::write(cwd.join("note.txt"), "ship the patch\n").expect("write note");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let environment = local_test_environment(cwd);
        let session_scope_key = environment.session_scope_key();
        let session_id = create_session_with_message(&conn, &session_scope_key, "Alpha", "ready");
        let gate = Arc::new(Notify::new());
        let executor = FakeTurnExecutor {
            calls: Arc::new(Mutex::new(Vec::new())),
            gate: Some(gate.clone()),
        };

        let app = test_server(
            environment,
            db_path,
            Ok(sample_bridges_status()),
            executor.clone(),
        );

        let response = submit_turn_request(&app, &session_id, "Review @note.txt").await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        wait_for_turn_calls(&executor, 1).await;

        let calls = executor.calls.lock().await;
        assert_eq!(calls.len(), 1);
        assert!(calls[0].input.contains("Contents of note.txt"));
        assert!(calls[0].input.contains("ship the patch"));
        drop(calls);
        gate.notify_waiters();
    }

    #[tokio::test]
    async fn submit_turn_rejects_concurrent_turns_for_the_same_session() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let environment = local_test_environment(cwd);
        let session_scope_key = environment.session_scope_key();
        let session_id = create_session_with_message(&conn, &session_scope_key, "Alpha", "ready");
        let gate = Arc::new(Notify::new());
        let executor = FakeTurnExecutor {
            calls: Arc::new(Mutex::new(Vec::new())),
            gate: Some(gate.clone()),
        };

        let app = test_server(
            environment,
            db_path,
            Ok(sample_bridges_status()),
            executor.clone(),
        );

        let first = submit_turn_request(&app, &session_id, "First turn").await;
        assert_eq!(first.status(), StatusCode::ACCEPTED);
        wait_for_turn_calls(&executor, 1).await;

        let second = submit_turn_request(&app, &session_id, "Second turn").await;
        assert_eq!(second.status(), StatusCode::CONFLICT);

        gate.notify_waiters();
    }

    #[tokio::test]
    async fn submit_turn_accepts_ssh_environment_when_workspace_api_is_configured() {
        let temp = TempDir::new().expect("tempdir");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let environment = sample_ssh_environment();
        let session_scope_key = environment.session_scope_key();
        let session_id = create_session_with_message(&conn, &session_scope_key, "Alpha", "ready");
        let gate = Arc::new(Notify::new());
        let executor = FakeTurnExecutor {
            calls: Arc::new(Mutex::new(Vec::new())),
            gate: Some(gate.clone()),
        };
        let app = test_server(
            environment,
            db_path,
            Ok(sample_bridges_status()),
            executor.clone(),
        );

        let response = submit_turn_request(&app, &session_id, "Hello from ssh").await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        wait_for_turn_calls(&executor, 1).await;

        let calls = executor.calls.lock().await;
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].session_id, session_id);
        assert_eq!(
            calls[0].workspace_api_base_url.as_deref(),
            Some("http://127.0.0.1:7080")
        );
        drop(calls);
        gate.notify_waiters();
    }

    #[tokio::test]
    async fn submit_turn_rejects_ssh_environment_without_workspace_api_configuration() {
        let temp = TempDir::new().expect("tempdir");
        let db_path = temp.path().join("sessions.db");
        let conn = store::open_db(&db_path).expect("open db");
        let environment = sample_ssh_environment();
        let session_scope_key = environment.session_scope_key();
        let session_id = create_session_with_message(&conn, &session_scope_key, "Alpha", "ready");
        let app = test_server_with_workspace_api_base_url(
            environment,
            Arc::new(FakeSshCommandRunner::default()),
            db_path,
            Ok(sample_bridges_status()),
            FakeTurnExecutor::default(),
            None,
        );

        let response = submit_turn_request(&app, &session_id, "Hello from ssh").await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("error json");
        assert_eq!(
            payload["error"],
            serde_json::Value::String(
                "turn submission is not configured for the active ssh environment".to_string(),
            )
        );
    }

    #[tokio::test]
    async fn submit_turn_rejects_unknown_session() {
        let temp = TempDir::new().expect("tempdir");
        let cwd = std::fs::canonicalize(temp.path()).expect("canonical cwd");
        let db_path = temp.path().join("sessions.db");
        let app = test_server(
            local_test_environment(cwd),
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
