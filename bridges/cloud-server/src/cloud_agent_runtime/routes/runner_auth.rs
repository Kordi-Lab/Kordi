//! Runner credentials: the shared runner token identifies a runner, and
//! run-specific requests also need the run-scoped token of that run's lease.

use axum::extract::Request;
use axum::http::HeaderMap;
use axum::middleware::Next;
use axum::response::Response;

use crate::cloud_agent_runtime::runs::run_tokens::{
    run_token_matches, secrets_match, RUN_TOKEN_HEADER,
};
use crate::cloud_agent_runtime::runs::{
    run_error_response, run_token_unauthorized, runner_unauthorized,
};
use crate::server::ServerState;

pub(super) fn runner_authorized(headers: &HeaderMap) -> bool {
    let Ok(expected) = std::env::var("KORDI_CLOUD_RUNNER_TOKEN") else {
        return false;
    };
    if expected.trim().is_empty() {
        return false;
    }
    let Some(raw) = headers.get(axum::http::header::AUTHORIZATION) else {
        return false;
    };
    let Ok(value) = raw.to_str() else {
        return false;
    };
    let Some(presented) = value.strip_prefix("Bearer ") else {
        return false;
    };
    secrets_match(presented, &expected)
}

/// Refuses a runner route before its body is read or parsed unless the
/// request carries the shared runner token. Handlers still check the
/// run-scoped token of the run they act on.
pub(crate) async fn require_runner_token(request: Request, next: Next) -> Response {
    if !runner_authorized(request.headers()) {
        return runner_unauthorized();
    }
    next.run(request).await
}

/// Authorizes a run-specific runner request: the shared runner token and the
/// run-scoped token issued with this run's current lease are both required.
pub(crate) async fn runner_run_authorized(
    state: &ServerState,
    headers: &HeaderMap,
    run_id: &str,
) -> Result<(), Response> {
    if !runner_authorized(headers) {
        return Err(runner_unauthorized());
    }
    let presented = headers
        .get(RUN_TOKEN_HEADER)
        .and_then(|value| value.to_str().ok());
    match run_token_matches(state.db_pool(), run_id, presented).await {
        Ok(true) => Ok(()),
        Ok(false) => Err(run_token_unauthorized()),
        Err(error) => Err(run_error_response(
            "verify run token",
            "Could not verify the run credential.",
            error,
        )),
    }
}
