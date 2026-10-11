//! Creating, listing, changing, and revoking share links. Only the
//! attachment owner manages links.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::access::{authorized_document, ShareRow, ShareTuple, SHARE_COLUMNS};
use super::model::{
    CreateShareRequest, DocumentShare, DocumentShareList, PatchShareRequest, Viewer,
};
use super::tokens::{
    hash_share_token, new_share_id, share_deep_link, share_secret, share_token, share_url,
};
use super::{db_error, err};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

const MAX_SESSION_ID_LEN: usize = 256;

pub(crate) fn share_response(secret: &[u8], row: &ShareRow) -> DocumentShare {
    let token = share_token(secret, &row.share_id);
    DocumentShare {
        share_id: row.share_id.clone(),
        attachment_id: row.attachment_id.clone(),
        share_url: share_url(&token),
        deep_link: share_deep_link(&token),
        access_mode: row.access_mode.clone(),
        readers_can_ask_agent: row.readers_can_ask_agent,
        created_at: row.created_at.clone(),
        revoked_at: row.revoked_at.clone(),
    }
}

fn unavailable() -> Response {
    err(
        "document_sharing_unavailable",
        "Sharing is not configured on this server.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

fn owner_only() -> Response {
    err(
        "document_share_forbidden",
        "Only the person who added this document can share it.",
        StatusCode::FORBIDDEN,
    )
}

fn share_not_found() -> Response {
    err("not_found", "Share not found.", StatusCode::NOT_FOUND)
}

/// Live shares `owner` holds for `attachment_id`, newest first.
pub(crate) async fn live_shares(
    pool: &PgPool,
    owner: &str,
    attachment_id: &str,
) -> Result<Vec<ShareRow>, sqlx_core::Error> {
    let rows: Vec<ShareTuple> = query_as(&format!(
        "SELECT {SHARE_COLUMNS} FROM cloud_document_shares \
         WHERE owner_account_id = $1 AND attachment_id = $2 AND revoked_at IS NULL \
         ORDER BY created_at DESC"
    ))
    .bind(owner)
    .bind(attachment_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(ShareRow::from).collect())
}

/// `POST /v1/cloud/documents/:attachment_id/shares`
pub(crate) async fn create_share(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    body: Option<Json<CreateShareRequest>>,
) -> Response {
    let req = body.map(|Json(req)| req).unwrap_or_default();
    let Some(secret) = share_secret() else {
        return unavailable();
    };
    let (record, viewer) = match authorized_document(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if viewer != Viewer::Owner {
        return owner_only();
    }
    let session_id = req
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= MAX_SESSION_ID_LEN);
    let pool = state.db_pool();
    match live_shares(pool, &session.account_id, &record.attachment_id).await {
        Ok(rows) => {
            if let Some(row) = rows.first() {
                return Json(share_response(&secret, row)).into_response();
            }
        }
        Err(_) => return db_error(),
    }
    let share_id = new_share_id();
    let token = share_token(&secret, &share_id);
    let inserted = query(
        "INSERT INTO cloud_document_shares \
         (share_id, token_hash, attachment_id, owner_account_id, session_id, access_mode, \
          readers_can_ask_agent, created_at) \
         VALUES ($1, $2, $3, $4, $5, 'link', $6, $7) \
         ON CONFLICT (owner_account_id, attachment_id) WHERE revoked_at IS NULL DO NOTHING",
    )
    .bind(&share_id)
    .bind(hash_share_token(&token))
    .bind(&record.attachment_id)
    .bind(&session.account_id)
    .bind(session_id)
    .bind(req.readers_can_ask_agent.unwrap_or(true))
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await;
    let created = match inserted {
        Ok(result) => result.rows_affected() > 0,
        Err(_) => return db_error(),
    };
    let row = match live_shares(pool, &session.account_id, &record.attachment_id).await {
        Ok(rows) => rows.into_iter().next(),
        Err(_) => return db_error(),
    };
    let Some(row) = row else {
        return db_error();
    };
    if created {
        let _ = super::write_audit(
            pool,
            Some(&session.account_id),
            Some(&session.device_id),
            "document.share.created",
            serde_json::json!({ "share_id": row.share_id, "attachment_id": row.attachment_id }),
        )
        .await;
    }
    Json(share_response(&secret, &row)).into_response()
}

/// `GET /v1/cloud/documents/:attachment_id/shares`
pub(crate) async fn list_shares(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let Some(secret) = share_secret() else {
        return unavailable();
    };
    let (record, viewer) = match authorized_document(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if viewer != Viewer::Owner {
        return owner_only();
    }
    match live_shares(state.db_pool(), &session.account_id, &record.attachment_id).await {
        Ok(rows) => Json(DocumentShareList {
            shares: rows
                .iter()
                .map(|row| share_response(&secret, row))
                .collect(),
        })
        .into_response(),
        Err(_) => db_error(),
    }
}

async fn owned_live_share(
    pool: &PgPool,
    owner: &str,
    share_id: &str,
) -> Result<Option<ShareRow>, sqlx_core::Error> {
    let row: Option<ShareTuple> = query_as(&format!(
        "SELECT {SHARE_COLUMNS} FROM cloud_document_shares \
         WHERE share_id = $1 AND owner_account_id = $2 AND revoked_at IS NULL"
    ))
    .bind(share_id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(ShareRow::from))
}

/// `PATCH /v1/cloud/documents/shares/:share_id`
pub(crate) async fn patch_share(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(share_id): Path<String>,
    Json(req): Json<PatchShareRequest>,
) -> Response {
    let Some(secret) = share_secret() else {
        return unavailable();
    };
    let pool = state.db_pool();
    let updated = query(
        "UPDATE cloud_document_shares SET readers_can_ask_agent = $3 \
         WHERE share_id = $1 AND owner_account_id = $2 AND revoked_at IS NULL",
    )
    .bind(&share_id)
    .bind(&session.account_id)
    .bind(req.readers_can_ask_agent)
    .execute(pool)
    .await;
    if updated.is_err() {
        return db_error();
    }
    match owned_live_share(pool, &session.account_id, &share_id).await {
        Ok(Some(row)) => Json(share_response(&secret, &row)).into_response(),
        Ok(None) => share_not_found(),
        Err(_) => db_error(),
    }
}

/// `DELETE /v1/cloud/documents/shares/:share_id`
pub(crate) async fn revoke_share(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(share_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let revoked: Result<Option<(String,)>, _> = query_as(
        "UPDATE cloud_document_shares SET revoked_at = $3 \
         WHERE share_id = $1 AND owner_account_id = $2 AND revoked_at IS NULL \
         RETURNING attachment_id",
    )
    .bind(&share_id)
    .bind(&session.account_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(pool)
    .await;
    match revoked {
        Ok(Some((attachment_id,))) => {
            let _ = super::write_audit(
                pool,
                Some(&session.account_id),
                Some(&session.device_id),
                "document.share.revoked",
                serde_json::json!({ "share_id": share_id, "attachment_id": attachment_id }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(None) => share_not_found(),
        Err(_) => db_error(),
    }
}
