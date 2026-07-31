use anyhow::Context;
use axum::Json;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use kordi_core::settings::Settings;
use kordi_protocol::{
    APP_PROTOCOL_VERSION, BootstrapSnapshot, FeatureFlags, ForkSessionRequest, ForkSessionResponse,
    ServerMetadata, SessionDetail, SessionForksPage, SessionsPage, SubmitTurnAccepted,
    SubmitTurnRequest, WorkspaceSummary,
};
use kordi_session::store;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

use crate::bridge_health::build_services_snapshot;
use crate::protocol_mapping::{client_metadata_from_headers, workspace_root_name};
use crate::session_projection::{
    SessionProjectionError, fork_session, load_session_detail, load_session_forks,
    load_sessions_page,
};
use crate::turn_execution::TurnExecution;
use crate::{ActiveTurn, AppState};

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ListSessionsQuery {
    limit: Option<usize>,
}

#[derive(Debug)]
pub(super) struct AppError {
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

pub(super) async fn handle_bootstrap(
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

pub(super) async fn handle_sessions(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListSessionsQuery>,
) -> AppResult<Json<SessionsPage>> {
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let active_turns = active_turn_sessions(&state).await;
    let page = load_sessions_page(&state.sessions_db_path, &state.cwd, limit, &active_turns)
        .map_err(AppError::internal)?;
    Ok(Json(page))
}

pub(super) async fn handle_session_detail(
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

pub(super) async fn handle_session_forks(
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

pub(super) async fn handle_fork_session(
    State(state): State<Arc<AppState>>,
    AxumPath(session_id): AxumPath<String>,
    Json(request): Json<ForkSessionRequest>,
) -> AppResult<(StatusCode, Json<ForkSessionResponse>)> {
    let response = fork_session(&state.sessions_db_path, &state.cwd, &session_id, request)
        .map_err(|error| map_fork_error(error, &session_id))?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub(super) async fn handle_submit_turn(
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
        .with_context(|| format!("looking up session {session_id}"))
        .map_err(AppError::internal)?
    else {
        return Err(AppError::not_found(format!(
            "session {session_id} was not found for workspace {cwd_display}"
        )));
    };

    if session.cwd != cwd_display {
        return Err(AppError::not_found(format!(
            "session {session_id} does not belong to workspace {cwd_display}"
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
                "turn {} is already running for session {session_id}",
                existing.turn_id
            )));
        }
        // Reserve the turn before changing title metadata. A request rejected
        // as concurrent must not rename the session from text that will never
        // be appended to its history or consume its one automatic refinement.
        if let Some(title) = requested_title {
            store::set_session_name(&conn, &session_id, Some(title))
                .with_context(|| format!("setting session title for {session_id}"))
                .map_err(AppError::internal)?;
        } else if let Some(title) = kordi_session::naming::derive_session_title(&request.input) {
            store::set_auto_session_name(&conn, &session_id, &title, None)
                .with_context(|| format!("automatically naming session {session_id}"))
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
            "session_id {body_session_id} does not match route session {session_id}"
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
                "cwd {cwd} does not match server workspace {expected}"
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
