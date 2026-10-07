//! HTTP routes under `/v1/cloud/connectors` plus the runner broker route.

use std::collections::HashSet;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use serde_json::json;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::cloud_agent_runtime::routes::runner_authorized_for_connectors;
use crate::server::ServerState;

use super::broker::{self, codes};
use super::delivery::LeaseHolder;
use super::models::{
    AuditQuery, BrokerCallRequest, BrokerCallResponse, ConnectorAuditResponse,
    ConnectorListResponse, ConnectorResponse, ConnectorStatus, DisconnectResponse,
    OAuthCallbackQuery, OAuthStartRequest, OAuthStartResponse, SetActRequest, SetAgentsRequest,
};
use super::oauth::{self, StartError};
use super::store;

pub const BROKER_CALL_PATH: &str = "/internal/connectors/call";
const MAX_AGENT_GRANTS: usize = 100;
const DEFAULT_AUDIT_LIMIT: i64 = 50;
const MAX_AUDIT_LIMIT: i64 = 200;

pub fn routes(state: Arc<ServerState>) -> Router {
    let account_routes = Router::new()
        .route("/v1/cloud/connectors", get(list_connectors))
        .route("/v1/cloud/connectors/:id/oauth/start", post(start_oauth))
        .route("/v1/cloud/connectors/:id/act", post(set_act))
        .route("/v1/cloud/connectors/:id/agents", put(set_agents))
        .route("/v1/cloud/connectors/:id/audit", get(list_audit))
        .route(
            "/v1/cloud/connectors/:id",
            axum::routing::delete(disconnect),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ));
    Router::new()
        .merge(account_routes)
        .route("/v1/cloud/connectors/oauth/callback", get(oauth_callback))
        .route(BROKER_CALL_PATH, post(broker_call))
        .with_state(state)
}

fn error(code: &str, message: impl Into<String>, status: StatusCode) -> Response {
    (
        status,
        Json(json!({ "errorCode": code, "message": message.into() })),
    )
        .into_response()
}

fn server_error(context: &str, err: impl std::fmt::Display) -> Response {
    eprintln!("[connectors] {context}: {err}");
    error(
        "server_error",
        "Could not complete the connector request.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn not_found() -> Response {
    error(
        "connector_not_found",
        "Connector not found.",
        StatusCode::NOT_FOUND,
    )
}

async fn list_connectors(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match store::connector_summaries(state.db_pool(), &session.account_id).await {
        Ok(connectors) => Json(ConnectorListResponse { connectors }).into_response(),
        Err(err) => server_error("list connectors", err),
    }
}

async fn start_oauth(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(provider): Path<String>,
    Json(input): Json<OAuthStartRequest>,
) -> Response {
    match oauth::start_grant(
        state.db_pool(),
        state.connectors(),
        &session.account_id,
        &provider,
        input.grant,
        input.redirect_after.as_deref(),
    )
    .await
    {
        Ok(auth_url) => Json(OAuthStartResponse { auth_url }).into_response(),
        Err(StartError::UnknownProvider) => error(
            "unknown_provider",
            "Unknown connector provider.",
            StatusCode::NOT_FOUND,
        ),
        Err(StartError::NotYetAvailable) => error(
            "provider_not_available",
            "This connector is not yet available.",
            StatusCode::CONFLICT,
        ),
        Err(StartError::NotConfigured(message)) => error(
            "connector_not_configured",
            message,
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        Err(StartError::InvalidRedirect) => error(
            "invalid_redirect",
            "OAuth redirect target is not allowed.",
            StatusCode::BAD_REQUEST,
        ),
        Err(StartError::Database(err)) => server_error("start connector OAuth", err),
    }
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn oauth_callback(
    State(state): State<Arc<ServerState>>,
    Query(params): Query<OAuthCallbackQuery>,
) -> Response {
    let outcome = oauth::complete_grant(
        state.db_pool(),
        state.connectors(),
        params.state.as_deref(),
        params.code.as_deref(),
        params.error.as_deref(),
    )
    .await;
    if let Some(target) = outcome.redirect_after.as_deref() {
        return Redirect::to(&oauth::callback_redirect_url(target, &outcome)).into_response();
    }
    let (status, message) = match &outcome.result {
        Ok(_) => (
            StatusCode::OK,
            "Connected. You can close this window and return to Kordi.".to_string(),
        ),
        Err(err) => (StatusCode::BAD_REQUEST, err.message.clone()),
    };
    (
        status,
        Html(format!(
            "<!doctype html><meta charset=\"utf-8\"><title>Kordi</title><p>{}</p>",
            html_escape(&message)
        )),
    )
        .into_response()
}

async fn load_live(
    state: &ServerState,
    account_id: &str,
    connector_id: &str,
) -> Result<super::models::ConnectorRecord, Box<Response>> {
    match store::load_account_connector(state.db_pool(), account_id, connector_id).await {
        Ok(Some(record)) if record.status != ConnectorStatus::Revoked => Ok(record),
        Ok(_) => Err(Box::new(not_found())),
        Err(err) => Err(Box::new(server_error("load connector", err))),
    }
}

async fn set_act(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(connector_id): Path<String>,
    Json(input): Json<SetActRequest>,
) -> Response {
    let record = match load_live(&state, &session.account_id, &connector_id).await {
        Ok(record) => record,
        Err(response) => return *response,
    };
    if input.enabled && record.act_scopes.is_empty() {
        return error(
            "act_not_granted",
            "Grant act access for this connector before turning it on.",
            StatusCode::CONFLICT,
        );
    }
    let pool = state.db_pool();
    let updated = match store::set_act_enabled(pool, &record.connector_id, input.enabled).await {
        Ok(Some(updated)) => updated,
        Ok(None) => return not_found(),
        Err(err) => return server_error("set connector act", err),
    };
    if record.act_enabled != input.enabled {
        let (tool, summary) = if input.enabled {
            (
                "connector.act_on",
                "Turned on acting through this connector.",
            )
        } else {
            (
                "connector.act_off",
                "Turned off acting through this connector.",
            )
        };
        let _ = store::insert_audit(
            pool,
            store::NewAuditEntry {
                connector_id: &updated.connector_id,
                account_id: &updated.account_id,
                run_id: None,
                agent_id: None,
                tool,
                tool_group: super::models::ConnectorToolGroup::Act,
                outcome: super::models::AuditOutcome::Completed,
                summary,
            },
        )
        .await;
    }
    match store::summary_for(pool, updated).await {
        Ok(connector) => Json(ConnectorResponse { connector }).into_response(),
        Err(err) => server_error("load connector summary", err),
    }
}

async fn set_agents(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(connector_id): Path<String>,
    Json(input): Json<SetAgentsRequest>,
) -> Response {
    let record = match load_live(&state, &session.account_id, &connector_id).await {
        Ok(record) => record,
        Err(response) => return *response,
    };
    let mut seen = HashSet::new();
    let mut agent_ids = Vec::new();
    for raw in &input.agent_ids {
        let agent_id = raw.trim();
        if agent_id.is_empty() || agent_id.len() > 256 {
            return error(
                "invalid_agent",
                "Agent ids must be non-empty.",
                StatusCode::BAD_REQUEST,
            );
        }
        if seen.insert(agent_id.to_string()) {
            agent_ids.push(agent_id.to_string());
        }
    }
    if agent_ids.len() > MAX_AGENT_GRANTS {
        return error(
            "too_many_agents",
            format!("At most {MAX_AGENT_GRANTS} agents can use one connector."),
            StatusCode::BAD_REQUEST,
        );
    }
    let pool = state.db_pool();
    for agent_id in &agent_ids {
        match store::agent_owned_by_account(pool, &session.account_id, agent_id).await {
            Ok(true) => {}
            Ok(false) => {
                return error(
                    "unknown_agent",
                    "Every agent must be one of your agents.",
                    StatusCode::BAD_REQUEST,
                )
            }
            Err(err) => return server_error("check agent owner", err),
        }
    }
    if let Err(err) = store::replace_agent_grants(pool, &record.connector_id, &agent_ids).await {
        return server_error("replace connector grants", err);
    }
    match store::summary_for(pool, record).await {
        Ok(connector) => Json(ConnectorResponse { connector }).into_response(),
        Err(err) => server_error("load connector summary", err),
    }
}

async fn list_audit(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(connector_id): Path<String>,
    Query(params): Query<AuditQuery>,
) -> Response {
    let pool = state.db_pool();
    // Audit stays readable after a disconnect, so revoked rows are included.
    match store::load_account_connector(pool, &session.account_id, &connector_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return not_found(),
        Err(err) => return server_error("load connector", err),
    }
    let limit = params
        .limit
        .unwrap_or(DEFAULT_AUDIT_LIMIT)
        .clamp(1, MAX_AUDIT_LIMIT);
    let before = match params.before.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => match chrono::DateTime::parse_from_rfc3339(raw) {
            Ok(value) => Some(value.with_timezone(&chrono::Utc)),
            Err(_) => {
                return error(
                    "invalid_cursor",
                    "before must be an RFC 3339 timestamp.",
                    StatusCode::BAD_REQUEST,
                )
            }
        },
    };
    match store::list_audit(pool, &connector_id, limit, before).await {
        Ok(entries) => {
            let next_before = (entries.len() as i64 == limit)
                .then(|| entries.last().map(|entry| entry.created_at.clone()))
                .flatten();
            Json(ConnectorAuditResponse {
                entries,
                next_before,
            })
            .into_response()
        }
        Err(err) => server_error("list connector audit", err),
    }
}

async fn disconnect(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(connector_id): Path<String>,
) -> Response {
    let record = match load_live(&state, &session.account_id, &connector_id).await {
        Ok(record) => record,
        Err(response) => return *response,
    };
    match oauth::disconnect_connector(state.db_pool(), state.connectors(), &record).await {
        Ok(deleted_events) => Json(DisconnectResponse { deleted_events }).into_response(),
        Err(err) => server_error("disconnect connector", err),
    }
}

/// HTTP status for a broker error code.
pub fn broker_status(response: &BrokerCallResponse) -> StatusCode {
    match response.error_code() {
        None => StatusCode::OK,
        Some(codes::INVALID_REQUEST) | Some(codes::UNKNOWN_TOOL) => StatusCode::BAD_REQUEST,
        Some(codes::LEASE_INVALID) | Some(codes::NOT_ON_LEASE) => StatusCode::FORBIDDEN,
        Some(codes::NOT_FOUND) => StatusCode::NOT_FOUND,
        Some(codes::AGENT_NOT_GRANTED)
        | Some(codes::ACT_DISABLED)
        | Some(codes::BLOCKED_BACKGROUND) => StatusCode::FORBIDDEN,
        Some(codes::NOT_CONNECTED) => StatusCode::CONFLICT,
        Some(codes::UNAVAILABLE) => StatusCode::SERVICE_UNAVAILABLE,
        Some(codes::PROVIDER_FAILED) => StatusCode::BAD_GATEWAY,
        Some(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Who holds the lease named in a broker call: a cloud runner presenting the
/// runner token, or the owner's desktop presenting its cloud session and the
/// claim id of its execution lease.
async fn lease_holder(
    state: &ServerState,
    headers: &HeaderMap,
    input: &BrokerCallRequest,
) -> Result<LeaseHolder, Box<Response>> {
    let unauthorized = || {
        Box::new(error(
            "runner_unauthorized",
            "Runner token or session is missing or invalid.",
            StatusCode::UNAUTHORIZED,
        ))
    };
    let missing = |name: &str| {
        Box::new(error(
            codes::INVALID_REQUEST,
            format!("{name} is required."),
            StatusCode::BAD_REQUEST,
        ))
    };
    let nonblank = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(str::to_string)
    };
    if runner_authorized_for_connectors(headers) {
        let runner_id = nonblank(&input.runner_id).ok_or_else(|| missing("runnerId"))?;
        return Ok(LeaseHolder::Runner { runner_id });
    }
    let token = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|token| token.starts_with(crate::auth::session::SESSION_TOKEN_PREFIX))
        .ok_or_else(unauthorized)?;
    let session = match crate::auth::session::lookup_session(state.db_pool(), token).await {
        Ok(Some(session)) => session,
        Ok(None) => return Err(unauthorized()),
        Err(err) => return Err(Box::new(server_error("broker session", err))),
    };
    let claim_id = nonblank(&input.claim_id)
        .and_then(|claim| uuid::Uuid::parse_str(&claim).ok())
        .ok_or_else(|| missing("claimId"))?;
    Ok(LeaseHolder::Desktop {
        executor: format!("desktop:{}:{claim_id}", session.device_id),
        account_id: session.account_id,
    })
}

async fn broker_call(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(input): Json<BrokerCallRequest>,
) -> Response {
    let holder = match lease_holder(&state, &headers, &input).await {
        Ok(holder) => holder,
        Err(response) => return *response,
    };
    let response =
        broker::call_connector_tool(state.db_pool(), state.connectors(), &holder, &input).await;
    (broker_status(&response), Json(response)).into_response()
}
