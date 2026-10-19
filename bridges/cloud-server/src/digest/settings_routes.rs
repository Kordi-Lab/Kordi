//! The owner's digest model setting.

use super::model_choice::{self, Preference, DIGEST_THINKING};
use super::routes::{error, failed};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::json;
use sqlx_core::query::query;
use std::sync::Arc;

/// The saved choice with the models it can resolve to for the owner's
/// current provider route.
pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    let account = &session.account_id;
    let (Ok(preference), Ok(route)) = (
        model_choice::preference(pool, account).await,
        super::fallback::route(pool, account, &format!("digest:{account}")).await,
    ) else {
        return failed();
    };
    let provider = route
        .as_ref()
        .and_then(|route| route.default_auth_provider.clone());
    Json(json!({
        "model": preference.model.unwrap_or_else(|| "fast".into()),
        "thinking": preference.thinking.unwrap_or_else(|| DIGEST_THINKING.into()),
        "provider": provider,
        "fastModel": provider.as_deref().and_then(model_choice::fast_model),
        "chatModel": route.and_then(|route| route.default_model),
    }))
    .into_response()
}

pub(super) async fn save(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(preference): Json<Preference>,
) -> Response {
    let preference = match preference.validated() {
        Ok(preference) => preference,
        Err(message) => return error("invalid_setting", message, StatusCode::BAD_REQUEST),
    };
    let value = (preference != Preference::default()).then(|| json!(preference));
    match query("UPDATE cloud_account_digests SET model_preference=$2 WHERE account_id=$1")
        .bind(&session.account_id)
        .bind(value)
        .execute(state.db_pool())
        .await
    {
        Ok(result) if result.rows_affected() == 1 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => error(
            "not_found",
            "Open your digest first.",
            StatusCode::NOT_FOUND,
        ),
        Err(_) => failed(),
    }
}
