//! Switching organization: `POST /v1/cloud/auth/organization-token`
//! (docs/development/organization-requests.md).
//!
//! The account, its sign-in, its refresh token and its device stay the same.
//! A browser sign-in gets a new access token bound to the target
//! organization and remembers it for later refreshes. An older long-lived
//! session, or the web session cookie, changes the claim on its own row.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::handlers::valid_id;
use super::{not_found, server_error, ApiError};
use crate::auth::app_sign_in::tokens::switch_sign_in_organization;
use crate::auth::rate_limit::{AccountActionLimit, CloudRateLimiter, RateLimitDecision};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

pub const ORGANIZATION_TOKEN_PATH: &str = "/v1/cloud/auth/organization-token";

/// Switches one account may make. Far above what a person clicking an
/// organization switcher needs, and it bounds the access tokens a loop could
/// create.
const SWITCH_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "organization-token-switch",
    limit: 120,
    window: std::time::Duration::from_secs(10 * 60),
};

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new().route(ORGANIZATION_TOKEN_PATH, post(exchange))
}

#[derive(Debug, Deserialize)]
struct ExchangeRequest {
    #[serde(default, alias = "organizationId")]
    organization_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ExchangeResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_in: Option<i64>,
    account_id: String,
    device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sign_in_id: Option<String>,
    organization_id: String,
}

fn no_store(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert("Cache-Control", "no-store".parse().unwrap());
    headers.insert("Pragma", "no-cache".parse().unwrap());
    response
}

fn presented_bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
}

fn seconds_until(expires_at: DateTime<Utc>) -> i64 {
    (expires_at - Utc::now()).num_seconds().max(0)
}

async fn exchange(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    headers: HeaderMap,
    Json(request): Json<ExchangeRequest>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(SWITCH_LIMIT, &session.account_id)
        .await
    {
        let mut response = ApiError {
            code: "rate_limited",
            message: "Too many organization switches. Try again later.",
            status: StatusCode::TOO_MANY_REQUESTS,
        }
        .into_response();
        if let Ok(value) = retry_after.as_secs().max(1).to_string().parse() {
            response.headers_mut().insert("Retry-After", value);
        }
        return response;
    }
    let organization_id = request
        .organization_id
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    if !valid_id(organization_id) {
        return not_found().into_response();
    }
    match switch(
        &state,
        &session,
        presented_bearer(&headers),
        organization_id,
    )
    .await
    {
        Ok(response) => no_store((StatusCode::OK, Json(response)).into_response()),
        Err(error) => error.into_response(),
    }
}

async fn switch(
    state: &ServerState,
    session: &CloudSession,
    bearer: Option<&str>,
    organization_id: &str,
) -> Result<ExchangeResponse, ApiError> {
    let db_error = |error: sqlx_core::Error| {
        eprintln!("[organizations] organization token switch: {error}");
        server_error()
    };
    let mut transaction = state.db_pool().begin().await.map_err(db_error)?;
    let row: Option<(Option<String>, String)> = query_as(
        "SELECT app_sign_in_id, expires_at FROM cloud_refresh_tokens \
         WHERE token_id = $1 AND account_id = $2 AND device_id = $3 AND revoked_at IS NULL \
         FOR UPDATE",
    )
    .bind(&session.token_id)
    .bind(&session.account_id)
    .bind(&session.device_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(db_error)?;
    let Some((sign_in_id, expires_at)) = row else {
        return Err(ApiError {
            code: "invalid_session",
            message: "Session is expired or revoked.",
            status: StatusCode::UNAUTHORIZED,
        });
    };
    // One answer for an organization that does not exist and one the
    // account does not belong to, as everywhere else.
    let (member,): (bool,) = query_as("SELECT cloud_is_organization_member($1, $2)")
        .bind(organization_id)
        .bind(&session.account_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(db_error)?;
    if !member {
        return Err(not_found());
    }
    let mut response = ExchangeResponse {
        access_token: None,
        token_type: None,
        expires_in: None,
        account_id: session.account_id.clone(),
        device_id: session.device_id.clone(),
        sign_in_id: sign_in_id.clone(),
        organization_id: organization_id.to_string(),
    };
    match sign_in_id {
        Some(sign_in_id) => {
            let switched = switch_sign_in_organization(
                &mut transaction,
                &sign_in_id,
                &session.account_id,
                &session.device_id,
                organization_id,
            )
            .await
            .map_err(db_error)?
            .ok_or(ApiError {
                code: "invalid_session",
                message: "Session is expired or revoked.",
                status: StatusCode::UNAUTHORIZED,
            })?;
            response.access_token = Some(switched.access_token);
            response.token_type = Some("Bearer");
            response.expires_in = Some(seconds_until(switched.access_expires_at));
        }
        None => {
            query("UPDATE cloud_refresh_tokens SET organization_id = $1 WHERE token_id = $2")
                .bind(organization_id)
                .bind(&session.token_id)
                .execute(&mut *transaction)
                .await
                .map_err(db_error)?;
            if let Some(token) = bearer {
                response.access_token = Some(token.to_string());
                response.token_type = Some("Bearer");
                response.expires_in = DateTime::parse_from_rfc3339(&expires_at)
                    .ok()
                    .map(|expires_at| seconds_until(expires_at.with_timezone(&Utc)));
            }
        }
    }
    transaction.commit().await.map_err(db_error)?;
    Ok(response)
}
