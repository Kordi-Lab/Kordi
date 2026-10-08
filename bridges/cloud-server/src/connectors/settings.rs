//! `PUT /v1/cloud/connectors/:id/settings`: provider settings such as the
//! Slack channels a person chose for Kordi.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{json, Value};

use crate::auth::routes::CloudSession;
use crate::server::ServerState;

use super::models::{ConnectorResponse, ConnectorStatus};
use super::store;

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

/// Replaces the settings of a live connector after its provider validates
/// and normalizes them.
pub(super) async fn set_settings(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(connector_id): Path<String>,
    Json(input): Json<Value>,
) -> Response {
    let pool = state.db_pool();
    let record = match store::load_account_connector(pool, &session.account_id, &connector_id).await
    {
        Ok(Some(record)) if record.status != ConnectorStatus::Revoked => record,
        Ok(_) => return not_found(),
        Err(err) => return server_error("load connector", err),
    };
    let Some(provider) = state.connectors().providers.get(&record.provider) else {
        return not_found();
    };
    let settings = match provider.validate_settings(&input) {
        Ok(settings) => settings,
        Err(message) => return error("invalid_settings", message, StatusCode::BAD_REQUEST),
    };
    match store::set_settings(pool, &record.connector_id, &settings).await {
        Ok(Some(updated)) => match store::summary_for(pool, updated).await {
            Ok(connector) => Json(ConnectorResponse { connector }).into_response(),
            Err(err) => server_error("load connector summary", err),
        },
        Ok(None) => not_found(),
        Err(err) => server_error("set connector settings", err),
    }
}
