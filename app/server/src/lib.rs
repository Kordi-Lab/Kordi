use anyhow::{Context, Result};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use kordi_core::config;
use kordi_core::settings::Settings;
use kordi_protocol::{
    APP_PROTOCOL_VERSION, BootstrapSnapshot, FeatureFlags, ForkSessionRequest, ForkSessionResponse,
    ServerMetadata, SessionDetail, SessionForksPage, SessionsPage, SubmitTurnAccepted,
    SubmitTurnRequest, WorkspaceSummary,
};
use kordi_session::store;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

mod bridge_health;
mod configuration;
mod protocol_mapping;
mod session_projection;
mod turn_execution;

use bridge_health::{BridgesStatusProvider, HttpBridgesStatusProvider, build_services_snapshot};
use configuration::{resolve_bridges_base_url, resolve_turn_command};
use protocol_mapping::{client_metadata_from_headers, workspace_root_name};
use session_projection::{
    SessionProjectionError, fork_session, load_session_detail, load_session_forks,
    load_sessions_page,
};
use turn_execution::{ProcessTurnExecutor, TurnExecution, TurnExecutor};

#[cfg(test)]
use async_trait::async_trait;
#[cfg(test)]
use bridge_health::{
    BridgesComponentStatus, BridgesDaemonStatus, BridgesReachabilityStatus, BridgesStatusResponse,
};
#[cfg(test)]
use kordi_core::types::{AgentMessage, ContentBlock, SessionEntry};
#[cfg(test)]
use kordi_protocol::ServiceState;
#[cfg(test)]
use kordi_protocol::{ClientKind, ModelSelector, SessionSource, SessionStatus, ThinkingLevel};
#[cfg(test)]
use turn_execution::protocol_thinking_level;

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

#[derive(Debug, Clone, Deserialize)]
struct ListSessionsQuery {
    limit: Option<usize>,
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
                bridges_status: Arc::new(HttpBridgesStatusProvider::new(bridges_base_url)),
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
    let sessions = load_sessions_page(&state.sessions_db_path, &state.cwd, 1, &active_turns)
        .map_err(AppError::internal)?;
    let services =
        build_services_snapshot(&state.sessions_db_path, state.bridges_status.as_ref()).await;

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
    let page = load_sessions_page(&state.sessions_db_path, &state.cwd, limit, &active_turns)
        .map_err(AppError::internal)?;
    Ok(Json(page))
}

async fn handle_session_detail(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<SessionDetail>> {
    let active_turns = active_turn_sessions(&state).await;
    let detail = load_session_detail(
        &state.sessions_db_path,
        &state.cwd,
        &session_id,
        &active_turns,
    )
    .map_err(|error| map_session_load_error(error, &session_id))?;
    Ok(Json(detail))
}

async fn handle_session_forks(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
) -> AppResult<Json<SessionForksPage>> {
    let active_turns = active_turn_sessions(&state).await;
    let page = load_session_forks(
        &state.sessions_db_path,
        &state.cwd,
        &session_id,
        &active_turns,
    )
    .map_err(|error| map_session_load_error(error, &session_id))?;
    Ok(Json(page))
}

async fn handle_fork_session(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<ForkSessionRequest>,
) -> AppResult<(StatusCode, Json<ForkSessionResponse>)> {
    let response = fork_session(&state.sessions_db_path, &state.cwd, &session_id, request)
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

    let requested_title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty());
    let turn_id = Uuid::new_v4().to_string();
    {
        let mut active_turns = state.active_turns.lock().await;
        if let Some(existing) = active_turns.get(&session_id) {
            return Err(AppError::conflict(format!(
                "turn {} is already running for session {}",
                existing.turn_id, session_id
            )));
        }
        // Reserve the turn before changing title metadata. A request rejected
        // as concurrent must not rename the session from text that will never
        // be appended to its history or consume its one automatic refinement.
        if let Some(title) = requested_title {
            store::set_session_name(&conn, &session_id, Some(title))
                .with_context(|| format!("setting session title for {}", session_id))
                .map_err(AppError::internal)?;
        } else if let Some(title) = kordi_session::naming::derive_session_title(&request.input) {
            store::set_auto_session_name(&conn, &session_id, &title, None)
                .with_context(|| format!("automatically naming session {}", session_id))
                .map_err(AppError::internal)?;
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

fn map_session_load_error(error: SessionProjectionError, session_id: &str) -> AppError {
    match error {
        SessionProjectionError::BadRequest(message) => AppError::bad_request(message),
        SessionProjectionError::NotFound(message) => {
            AppError::not_found(format!("Unable to load session {session_id}: {message}"))
        }
        SessionProjectionError::Internal(error) => AppError::internal(error),
    }
}

fn map_fork_error(error: SessionProjectionError, session_id: &str) -> AppError {
    match error {
        SessionProjectionError::BadRequest(message) => AppError::bad_request(message),
        SessionProjectionError::NotFound(message) => {
            AppError::not_found(format!("Unable to fork session {session_id}: {message}"))
        }
        SessionProjectionError::Internal(error) => AppError::internal(error),
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

    if let Some(body_session_id) = request.session_id.as_deref()
        && body_session_id != session_id
    {
        return Err(AppError::bad_request(format!(
            "session_id {} does not match route session {}",
            body_session_id, session_id
        )));
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

async fn active_turn_sessions(state: &AppState) -> HashSet<String> {
    state.active_turns.lock().await.keys().cloned().collect()
}

#[cfg(test)]
mod tests;
