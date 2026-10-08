//! `POST /internal/connectors/call`: authenticates the lease holder (the
//! runner token or the owner's desktop session) and hands the call to the
//! broker.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::cloud_agent_runtime::routes::runner_authorized_for_connectors;
use crate::server::ServerState;

use super::broker::{self, codes};
use super::declined;
use super::delivery::LeaseHolder;
use super::models::{BrokerCallRequest, BrokerCallResponse};
use super::routes::{error, server_error};

/// HTTP status for a broker error code.
pub fn broker_status(response: &BrokerCallResponse) -> StatusCode {
    match response.error_code() {
        None => StatusCode::OK,
        Some(codes::BUDGET_EXCEEDED) => StatusCode::TOO_MANY_REQUESTS,
        Some(declined::DECLINED_BY_OWNER) => StatusCode::FORBIDDEN,
        Some(codes::INVALID_REQUEST) | Some(codes::UNKNOWN_TOOL) => StatusCode::BAD_REQUEST,
        Some(code) if codes::FORBIDDEN.contains(&code) => StatusCode::FORBIDDEN,
        Some(codes::NOT_FOUND) => StatusCode::NOT_FOUND,
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

pub(super) async fn broker_call(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(input): Json<BrokerCallRequest>,
) -> Response {
    let holder = match lease_holder(&state, &headers, &input).await {
        Ok(holder) => holder,
        Err(response) => return *response,
    };
    // A decline only writes the audit row; the tool never runs.
    let response = if input.declined_by_owner {
        declined::record_on_lease(state.db_pool(), state.connectors(), &holder, &input).await
    } else {
        broker::call_connector_tool(state.db_pool(), state.connectors(), &holder, &input).await
    };
    (broker_status(&response), Json(response)).into_response()
}
