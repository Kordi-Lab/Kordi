//! Typed failures exposed by the Cloud run domain boundary.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("Cloud agent run was not found for the requested transition")]
    NotFound,
    #[error("Cloud agent run idempotency key is bound to a different request")]
    IdempotencyConflict,
    #[error("Cloud agent run persistence failed: {0}")]
    Persistence(#[from] sqlx_core::Error),
}

pub type RunResult<T> = Result<T, RunError>;

impl RunError {
    /// Preserve scheduled-task store compatibility while that adapter still
    /// exposes `sqlx::Error` as its public persistence boundary.
    pub fn into_persistence_error(self) -> sqlx_core::Error {
        match self {
            Self::Persistence(error) => error,
            Self::NotFound | Self::IdempotencyConflict => {
                sqlx_core::Error::Protocol(self.to_string())
            }
        }
    }
}

pub(crate) fn error_response(
    error_code: &'static str,
    message: &'static str,
    status: StatusCode,
) -> Response {
    (
        status,
        Json(json!({
            "errorCode": error_code,
            "message": message,
        })),
    )
        .into_response()
}

pub(crate) fn runner_unauthorized() -> Response {
    error_response(
        "invalid_runner_token",
        "Missing or invalid Cloud runner token.",
        StatusCode::UNAUTHORIZED,
    )
}

pub(crate) fn run_error_response(
    context: &'static str,
    persistence_message: &'static str,
    error: RunError,
) -> Response {
    match error {
        RunError::NotFound => error_response(
            "agent_run_not_found",
            "Cloud agent run was not found for this runner.",
            StatusCode::NOT_FOUND,
        ),
        RunError::IdempotencyConflict => error_response(
            "agent_run_idempotency_conflict",
            "This Cloud agent run key is already bound to a different request.",
            StatusCode::CONFLICT,
        ),
        RunError::Persistence(source) => {
            eprintln!("[cloud_agent_runtime] {context}: {source}");
            error_response(
                "server_error",
                persistence_message,
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}
