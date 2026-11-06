//! `GET` and `PUT /v1/cloud/account/ai-consent`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::{load, unavailable, AiConsentStatus};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new().route(
        "/v1/cloud/account/ai-consent",
        get(read_consent).put(set_consent),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetConsentRequest {
    status: String,
}

async fn read_consent(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match load(state.db_pool(), &session.account_id).await {
        Ok(consent) => Json(consent).into_response(),
        Err(_) => unavailable(),
    }
}

async fn set_consent(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<SetConsentRequest>,
) -> Response {
    let status = match request.status.trim() {
        "allowed" => AiConsentStatus::Allowed,
        "declined" => AiConsentStatus::Declined,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "errorCode": "invalid_ai_consent",
                    "message": "status must be \"allowed\" or \"declined\".",
                })),
            )
                .into_response()
        }
    };
    let pool = state.db_pool();
    let Ok(mut tx) = pool.begin().await else {
        return unavailable();
    };
    // Repeating the current decision keeps its time.
    let updated = query(
        "UPDATE cloud_accounts SET ai_consent_status = $2, \
           ai_consent_decided_at = CASE WHEN ai_consent_status = $2 \
             THEN COALESCE(ai_consent_decided_at, now()) ELSE now() END \
         WHERE account_id = $1",
    )
    .bind(&session.account_id)
    .bind(status.as_str())
    .execute(&mut *tx)
    .await;
    if !matches!(updated, Ok(result) if result.rows_affected() == 1) {
        return unavailable();
    }
    let cancelled = if status == AiConsentStatus::Declined {
        match stop_runs(&mut tx, &session.account_id).await {
            Ok(cancelled) => cancelled,
            Err(_) => return unavailable(),
        }
    } else {
        Vec::new()
    };
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    let audited = query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, 'account.ai_consent.changed', $4, $5)",
    )
    .bind(&event_id)
    .bind(&session.account_id)
    .bind(&session.device_id)
    .bind(json!({ "status": status.as_str() }).to_string())
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&mut *tx)
    .await;
    if audited.is_err() {
        return unavailable();
    }
    let consent = match load(&mut *tx, &session.account_id).await {
        Ok(consent) => consent,
        Err(_) => return unavailable(),
    };
    if tx.commit().await.is_err() {
        return unavailable();
    }
    for run_id in &cancelled {
        crate::cloud_agent_runtime::runs::terminal_backfill::publish_after_cancel(&state, run_id)
            .await;
    }
    Json(consent).into_response()
}

/// Ends the account's agent runs, as owner or requester, when it declines
/// AI: queued runs are cancelled at once, so they never wait at the head of
/// a conversation's queue, and runs in progress are asked to stop, as the
/// stop button does. Returns the cancelled queued runs.
pub(super) async fn stop_runs(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
) -> sqlx_core::Result<Vec<String>> {
    let now = chrono::Utc::now().to_rfc3339();
    let cancelled: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', \
           cancel_requested_at = COALESCE(cancel_requested_at, now()), \
           completed_at = $2, updated_at = $2 \
         WHERE (owner_account_id = $1 OR requester_account_id = $1) \
           AND (status = 'queued' OR (status IN ('leased', 'running') \
             AND lease_expires_at IS NOT NULL AND lease_expires_at::timestamptz <= now())) \
         RETURNING run_id",
    )
    .bind(account_id)
    .bind(&now)
    .fetch_all(&mut **tx)
    .await?;
    query(
        "UPDATE cloud_agent_fallback_runs \
         SET cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = $2 \
         WHERE (owner_account_id = $1 OR requester_account_id = $1) \
           AND status IN ('leased', 'running')",
    )
    .bind(account_id)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(cancelled.into_iter().map(|(id,)| id).collect())
}
