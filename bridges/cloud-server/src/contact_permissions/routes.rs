//! `GET|PUT /v1/cloud/contacts/:account_id/permissions`: what you allow one
//! person. Available for an accepted contact, someone you share an active
//! conversation with, or anyone you already set permissions for (so a
//! removed contact's restrictions can still be read and lifted). Anything
//! else is a 404, so the route never confirms that an account exists.
//!
//! `GET /v1/cloud/contacts/permissions` lists the people you restricted, so
//! your Mac can apply the same rules to the runs it executes.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::{load, Permissions};
use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::server::ServerState;

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/contacts/permissions", get(list))
        .route(
            "/v1/cloud/contacts/:account_id/permissions",
            get(read).put(update),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UpdateRequest {
    #[serde(default)]
    agent_access: Option<bool>,
    #[serde(default)]
    card_access: Option<bool>,
}

fn err(code: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({ "errorCode": code, "message": message })),
    )
        .into_response()
}

fn not_found() -> Response {
    err(
        "contact_not_found",
        "This contact isn't available.",
        StatusCode::NOT_FOUND,
    )
}

fn db_error(error: sqlx_core::Error) -> Response {
    eprintln!("[contact-permissions] Database error: {error}");
    err(
        "server_error",
        "Could not update permissions. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

/// Whether `owner` may read and set permissions for `subject`.
pub(super) async fn reachable(
    pool: &PgPool,
    owner: &str,
    subject: &str,
) -> sqlx_core::Result<bool> {
    if subject.is_empty() || owner == subject || crate::system_account::is_service_account(subject)
    {
        return Ok(false);
    }
    let (reachable,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_accounts WHERE account_id = $2) AND (
             EXISTS (SELECT 1 FROM cloud_contacts
                     WHERE account_id = $1 AND peer_account_id = $2)
             OR EXISTS (SELECT 1 FROM cloud_contact_permissions
                        WHERE owner_account_id = $1 AND subject_account_id = $2)
             OR EXISTS (SELECT 1 FROM cloud_chat_conversation_members mine
                        JOIN cloud_chat_conversation_members theirs
                          ON theirs.conversation_id = mine.conversation_id
                         AND theirs.account_id = $2 AND theirs.membership_state = 'active'
                        WHERE mine.account_id = $1 AND mine.membership_state = 'active'))",
    )
    .bind(owner)
    .bind(subject)
    .fetch_one(pool)
    .await?;
    Ok(reachable)
}

async fn view(pool: &PgPool, owner: &str, subject: &str) -> sqlx_core::Result<serde_json::Value> {
    let permissions = load(pool, owner, subject).await?;
    let updated_at: Option<(chrono::DateTime<chrono::Utc>,)> = query_as(
        "SELECT updated_at FROM cloud_contact_permissions
         WHERE owner_account_id = $1 AND subject_account_id = $2",
    )
    .bind(owner)
    .bind(subject)
    .fetch_optional(pool)
    .await?;
    Ok(json!({
        "accountId": subject,
        "agentAccess": permissions.agent_access,
        "cardAccess": permissions.card_access,
        "updatedAt": updated_at.map(|(at,)| at),
    }))
}

type RestrictionRow = (String, bool, bool, chrono::DateTime<chrono::Utc>);

/// `GET /v1/cloud/contacts/permissions`: everyone the signed-in owner
/// restricted in any way, newest change first.
pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: sqlx_core::Result<Vec<RestrictionRow>> = query_as(
        "SELECT subject_account_id, agent_access, card_access, updated_at
         FROM cloud_contact_permissions
         WHERE owner_account_id = $1 AND NOT (agent_access AND card_access)
         ORDER BY updated_at DESC, subject_account_id",
    )
    .bind(&session.account_id)
    .fetch_all(state.db_pool())
    .await;
    match rows {
        Ok(rows) => {
            let people: Vec<serde_json::Value> = rows
                .into_iter()
                .map(|(account_id, agent_access, card_access, updated_at)| {
                    json!({
                        "accountId": account_id,
                        "agentAccess": agent_access,
                        "cardAccess": card_access,
                        "updatedAt": updated_at,
                    })
                })
                .collect();
            (StatusCode::OK, Json(json!({ "people": people }))).into_response()
        }
        Err(error) => db_error(error),
    }
}

pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(subject): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let subject = subject.trim();
    match reachable(pool, &session.account_id, subject).await {
        Ok(true) => {}
        Ok(false) => return not_found(),
        Err(error) => return db_error(error),
    }
    match view(pool, &session.account_id, subject).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => db_error(error),
    }
}

pub(super) async fn update(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(subject): Path<String>,
    Json(input): Json<UpdateRequest>,
) -> Response {
    let pool = state.db_pool();
    let owner = session.account_id.as_str();
    let subject = subject.trim();
    match reachable(pool, owner, subject).await {
        Ok(true) => {}
        Ok(false) => return not_found(),
        Err(error) => return db_error(error),
    }
    match save(pool, owner, subject, &input).await {
        Ok(refused) => {
            for run_id in refused {
                super::publish_refusal(pool, &run_id).await;
            }
        }
        Err(error) => return db_error(error),
    }
    match view(pool, owner, subject).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(error) => db_error(error),
    }
}

/// Writes the keys present in `input`; missing keys keep their value. Taking
/// agent access away also ends the subject's waiting and running requests
/// to the owner's agents; their ids are returned for the refusal reply.
pub(super) async fn save(
    pool: &PgPool,
    owner: &str,
    subject: &str,
    input: &UpdateRequest,
) -> sqlx_core::Result<Vec<String>> {
    let mut tx = pool.begin().await?;
    super::lock_pair(&mut tx, owner, subject).await?;
    let current: Option<(bool, bool)> = query_as(
        "SELECT agent_access, card_access FROM cloud_contact_permissions
         WHERE owner_account_id = $1 AND subject_account_id = $2 FOR UPDATE",
    )
    .bind(owner)
    .bind(subject)
    .fetch_optional(&mut *tx)
    .await?;
    let current = current
        .map(|(agent_access, card_access)| Permissions {
            agent_access,
            card_access,
        })
        .unwrap_or_default();
    let next = Permissions {
        agent_access: input.agent_access.unwrap_or(current.agent_access),
        card_access: input.card_access.unwrap_or(current.card_access),
    };
    query(
        "INSERT INTO cloud_contact_permissions
             (owner_account_id, subject_account_id, agent_access, card_access, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (owner_account_id, subject_account_id) DO UPDATE
         SET agent_access = EXCLUDED.agent_access, card_access = EXCLUDED.card_access,
             updated_at = CASE
                 WHEN cloud_contact_permissions.agent_access = EXCLUDED.agent_access
                  AND cloud_contact_permissions.card_access = EXCLUDED.card_access
                 THEN cloud_contact_permissions.updated_at ELSE now() END",
    )
    .bind(owner)
    .bind(subject)
    .bind(next.agent_access)
    .bind(next.card_access)
    .execute(&mut *tx)
    .await?;
    let refused = if next.agent_access {
        Vec::new()
    } else {
        stop_requests(&mut tx, owner, subject).await?
    };
    tx.commit().await?;
    Ok(refused)
}

/// Ends the subject's requests to the owner's agents, waiting or running.
/// An executor still holding one finds it cancelled at its next renewal and
/// can no longer publish.
async fn stop_requests(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    owner: &str,
    subject: &str,
) -> sqlx_core::Result<Vec<String>> {
    let rows: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, now()),
             completed_at = now()::text, updated_at = now()::text
         WHERE owner_account_id = $1 AND requester_account_id = $2
           AND status IN ('queued', 'leased', 'running')
         RETURNING run_id",
    )
    .bind(owner)
    .bind(subject)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().map(|(run_id,)| run_id).collect())
}
