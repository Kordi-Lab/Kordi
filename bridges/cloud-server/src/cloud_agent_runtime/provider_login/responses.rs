//! Client-facing login responses. None of them carries credential material.

use std::time::Duration;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use super::store::SavedSnapshot;
use crate::cloud_agent_runtime::runs::error_response;

/// Why a login session could not be loaded. It stays small inside `Result`
/// and becomes a response at the route boundary.
pub(super) enum LookupFailure {
    NotFound,
    ServerError,
}

impl IntoResponse for LookupFailure {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound => login_not_found(),
            Self::ServerError => server_error(),
        }
    }
}

/// A login state in the worker's shape: the current step, the latest sign-in
/// link, and the version to pass back as `after` when long-polling.
pub(super) fn state_response(
    session_id: &str,
    status: &str,
    step: Value,
    auth: Value,
    version: Option<u64>,
    code: StatusCode,
) -> Response {
    (
        code,
        Json(json!({
            "sessionId": session_id,
            "status": status,
            "step": step,
            "auth": auth,
            "version": version,
        })),
    )
        .into_response()
}

/// A state recorded by the server, which has no worker step to show.
pub(super) fn stored_state(session_id: &str, status: &str) -> Response {
    state_response(
        session_id,
        status,
        Value::Null,
        Value::Null,
        None,
        StatusCode::OK,
    )
}

pub(super) fn completed_response(session_id: &str, snapshot: Option<&SavedSnapshot>) -> Response {
    let snapshot = snapshot.map(|snapshot| {
        json!({
            "snapshotId": snapshot.snapshot_id,
            "provider": snapshot.provider,
            "authChoice": snapshot.auth_choice,
            "label": snapshot.label,
        })
    });
    Json(json!({
        "sessionId": session_id,
        "status": "completed",
        "step": null,
        "auth": null,
        "version": null,
        "snapshot": snapshot,
    }))
    .into_response()
}

fn with_reason(
    code: &'static str,
    message: &'static str,
    status: StatusCode,
    reason: &str,
) -> Response {
    (
        status,
        Json(json!({ "errorCode": code, "message": message, "reason": reason })),
    )
        .into_response()
}

pub(super) fn login_failed(reason: &str) -> Response {
    with_reason(
        "login_failed",
        "Sign-in did not finish. Start again.",
        StatusCode::BAD_GATEWAY,
        reason,
    )
}

pub(super) fn login_unsupported(reason: &str) -> Response {
    with_reason(
        "login_unsupported",
        "This provider cannot be added this way.",
        StatusCode::UNPROCESSABLE_ENTITY,
        reason,
    )
}

pub(crate) fn rate_limited(retry_after: Duration) -> Response {
    let mut response = error_response(
        "rate_limited",
        "Too many sign-in attempts. Try again shortly.",
        StatusCode::TOO_MANY_REQUESTS,
    );
    if let Ok(value) = retry_after.as_secs().max(1).to_string().parse() {
        response.headers_mut().insert("Retry-After", value);
    }
    response
}

pub(super) fn invalid_input(message: &'static str) -> Response {
    error_response("invalid_login_input", message, StatusCode::BAD_REQUEST)
}

pub(super) fn not_awaiting_input() -> Response {
    error_response(
        "login_not_awaiting_input",
        "This sign-in is not waiting for input.",
        StatusCode::CONFLICT,
    )
}

pub(super) fn login_not_found() -> Response {
    error_response(
        "login_not_found",
        "This sign-in was not found.",
        StatusCode::NOT_FOUND,
    )
}

pub(super) fn login_expired() -> Response {
    error_response(
        "login_expired",
        "This sign-in expired. Start again.",
        StatusCode::GONE,
    )
}

/// The OMP worker is configured but could not answer: a transient failure
/// that clients retry.
pub(crate) fn omp_unavailable() -> Response {
    error_response(
        "omp_unavailable",
        "Provider sign-in is not available right now.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

/// This server has no OMP worker, or no key for saved accounts, configured,
/// so hosted provider sign-in does not exist on this backend.
pub(crate) fn omp_not_configured() -> Response {
    error_response(
        "provider_auth_not_configured",
        "Provider sign-in is not set up on this server.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

/// The account already holds the maximum number of live saved accounts.
pub(crate) fn provider_auth_limit_reached() -> Response {
    error_response(
        "provider_auth_limit_reached",
        "This account has the maximum number of saved accounts. Remove one first.",
        StatusCode::CONFLICT,
    )
}

pub(super) fn omp_busy() -> Response {
    error_response(
        "omp_busy",
        "Provider sign-in is busy. Try again shortly.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

pub(super) fn provider_auth_error() -> Response {
    error_response(
        "provider_auth_error",
        "Could not save this account.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

pub(super) fn server_error() -> Response {
    error_response(
        "server_error",
        "Could not update this sign-in.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}
