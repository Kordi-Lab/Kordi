//! Wire types and errors for the account memory routes.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryResponse {
    pub memory_id: String,
    pub scope: String,
    pub scope_id: String,
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
    /// The account that saved the memory. Group memories are shared, so this
    /// can be another member of the group.
    pub owner_account_id: String,
    /// The owner's display name, when the owner has one.
    pub owner_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemorySettingsResponse {
    pub memory_enabled: bool,
    pub exclude_sensitive: bool,
}

impl Default for MemorySettingsResponse {
    fn default() -> Self {
        Self {
            memory_enabled: true,
            exclude_sensitive: true,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryListResponse {
    pub memories: Vec<MemoryResponse>,
    pub settings: MemorySettingsResponse,
}

#[derive(Debug, Serialize)]
pub(crate) struct MemoryEnvelope {
    pub memory: MemoryResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveMemoryRequest {
    pub scope: String,
    pub scope_id: String,
    #[serde(default)]
    pub scope_label: Option<String>,
    pub source: String,
    pub text: String,
    #[serde(default)]
    pub client_memory_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateMemoryRequest {
    pub text: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateMemorySettingsRequest {
    #[serde(default)]
    pub memory_enabled: Option<bool>,
    #[serde(default)]
    pub exclude_sensitive: Option<bool>,
}

/// A memory route failure with its HTTP status, error code, and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MemoryError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl MemoryError {
    pub(crate) fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn bad_request(code: &'static str, message: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub(crate) fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "memory_not_found",
            "Memory was not found.",
        )
    }

    pub(crate) fn not_a_group_member() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "not_a_group_member",
            "Only members of this group can change its memories.",
        )
    }

    pub(crate) fn scope_not_allowed() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "memory_scope_not_allowed",
            "Agents can only save memories in the current conversation's scopes.",
        )
    }

    pub(crate) fn server(message: &str) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "server_error", message)
    }
}

impl From<sqlx_core::Error> for MemoryError {
    fn from(error: sqlx_core::Error) -> Self {
        eprintln!("[memory_store] database error: {error}");
        Self::server("Could not update memory.")
    }
}

impl IntoResponse for MemoryError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "errorCode": self.code,
                "message": self.message,
            })),
        )
            .into_response()
    }
}

pub(crate) type MemoryResult<T> = Result<T, MemoryError>;

/// Result of a save: a new row, or the existing row for a retried client id.
#[derive(Debug)]
pub(crate) enum SaveOutcome {
    Created(MemoryResponse),
    Existing(MemoryResponse),
}

impl SaveOutcome {
    pub(crate) fn into_response(self) -> Response {
        match self {
            Self::Created(memory) => {
                (StatusCode::CREATED, Json(MemoryEnvelope { memory })).into_response()
            }
            Self::Existing(memory) => Json(MemoryEnvelope { memory }).into_response(),
        }
    }
}
