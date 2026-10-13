//! Block reactions: one live reaction per actor, block, and emoji. Posting
//! the same reaction again removes it.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::access::{authorized_document, clean_display_name, public_document, DocumentRecord};
use super::events::{publish_document_updated, DocumentChange};
use super::model::{
    DocumentReaction, DocumentReactionList, PublicReactionRequest, ReactionActor, ReactionRequest,
};
use super::validate::{clean_reaction, clean_reader_name, is_valid_reader_key};
use super::{db_error, err, observe_public, require_block, Caller, PublicAccess};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

/// Live reactions a document may carry before public writes stop.
pub(crate) const MAX_LIVE_REACTIONS: i64 = 2000;

type ReactionRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

/// Live reactions on the document, optionally for one block, oldest first.
pub(crate) async fn list_reactions(
    pool: &PgPool,
    attachment_id: &str,
    block_id: Option<&str>,
    caller: &Caller,
) -> Result<Vec<DocumentReaction>, sqlx_core::Error> {
    let rows: Vec<ReactionRow> = query_as(
        "SELECT reaction.reaction_id, reaction.block_id, reaction.reaction, \
                reaction.actor_account_id, reaction.actor_reader_key, reaction.actor_name, \
                account.display_name, reaction.created_at \
         FROM cloud_document_reactions reaction \
         LEFT JOIN cloud_accounts account ON account.account_id = reaction.actor_account_id \
         WHERE reaction.attachment_id = $1 AND reaction.deleted_at IS NULL \
           AND ($2::text IS NULL OR reaction.block_id = $2) \
         ORDER BY reaction.created_at ASC, reaction.reaction_id ASC",
    )
    .bind(attachment_id)
    .bind(block_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| reaction_from_row(row, caller))
        .collect())
}

fn reaction_from_row(row: ReactionRow, caller: &Caller) -> DocumentReaction {
    let (reaction_id, block_id, reaction, account_id, reader_key, actor_name, account_name, at) =
        row;
    let mine = caller.owns(account_id.as_deref(), reader_key.as_deref());
    let display_name = match &account_id {
        Some(_) => clean_display_name(account_name.as_deref()),
        None => clean_display_name(actor_name.as_deref()),
    };
    DocumentReaction {
        reaction_id,
        block_id,
        reaction,
        actor: ReactionActor {
            account_id: account_id.filter(|_| !caller.is_public()),
            reader_key: reader_key.filter(|_| mine && caller.is_public()),
            display_name,
        },
        mine,
        created_at: at,
    }
}

/// Toggles `reaction` for the caller. Returns whether a reaction was added.
async fn toggle(
    pool: &PgPool,
    attachment_id: &str,
    block_id: &str,
    reaction: &str,
    caller: &Caller,
    reader_name: Option<&str>,
    cap: Option<i64>,
) -> Result<Result<(), Response>, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let (account_id, reader_key) = caller.columns();
    let removed = query(
        "UPDATE cloud_document_reactions SET deleted_at = $5 \
         WHERE attachment_id = $1 AND block_id = $2 AND reaction = $3 AND deleted_at IS NULL \
           AND (actor_account_id = $4 OR actor_reader_key = $6)",
    )
    .bind(attachment_id)
    .bind(block_id)
    .bind(reaction)
    .bind(account_id)
    .bind(&now)
    .bind(reader_key)
    .execute(pool)
    .await?
    .rows_affected();
    if removed > 0 {
        return Ok(Ok(()));
    }
    if let Some(cap) = cap {
        let (live,): (i64,) = query_as(
            "SELECT COUNT(*)::BIGINT FROM cloud_document_reactions \
             WHERE attachment_id = $1 AND deleted_at IS NULL",
        )
        .bind(attachment_id)
        .fetch_one(pool)
        .await?;
        if live >= cap {
            return Ok(Err(super::limit_reached()));
        }
    }
    query(
        "INSERT INTO cloud_document_reactions \
         (reaction_id, attachment_id, block_id, reaction, actor_account_id, actor_reader_key, \
          actor_name, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING",
    )
    .bind(format!("docrx_{}", uuid::Uuid::new_v4().simple()))
    .bind(attachment_id)
    .bind(block_id)
    .bind(reaction)
    .bind(account_id)
    .bind(reader_key)
    .bind(reader_name)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(Ok(()))
}

async fn toggle_and_list(
    state: &ServerState,
    record: &DocumentRecord,
    block_id: &str,
    reaction: &str,
    caller: &Caller,
    reader_name: Option<&str>,
    cap: Option<i64>,
) -> Response {
    let pool = state.db_pool();
    match toggle(
        pool,
        &record.attachment_id,
        block_id,
        reaction,
        caller,
        reader_name,
        cap,
    )
    .await
    {
        Ok(Ok(())) => {
            publish_document_updated(
                pool,
                record,
                None,
                DocumentChange::Annotations,
                caller.account_id(),
            )
            .await;
        }
        Ok(Err(response)) => return response,
        Err(_) => return db_error(),
    }
    match list_reactions(pool, &record.attachment_id, Some(block_id), caller).await {
        Ok(reactions) => Json(DocumentReactionList { reactions }).into_response(),
        Err(_) => db_error(),
    }
}

fn invalid_reaction() -> Response {
    err(
        "invalid_reaction",
        "Choose one emoji.",
        StatusCode::BAD_REQUEST,
    )
}

/// `POST /v1/cloud/documents/:attachment_id/reactions`
pub(crate) async fn react(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    Json(req): Json<ReactionRequest>,
) -> Response {
    let Some(reaction) = clean_reaction(&req.reaction) else {
        return invalid_reaction();
    };
    let (record, _) = match authorized_document(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(response) = require_block(&state, &record, &req.block_id).await {
        return *response;
    }
    let caller = Caller::Account(session.account_id.clone());
    toggle_and_list(
        &state,
        &record,
        &req.block_id,
        &reaction,
        &caller,
        None,
        None,
    )
    .await
}

/// `POST /v1/cloud/public/documents/:token/reactions`
pub(crate) async fn react_public(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path(token): Path<String>,
    Json(req): Json<PublicReactionRequest>,
) -> Response {
    if let Err(response) = observe_public(
        &rate_limiter,
        &headers,
        connect_info.as_ref(),
        PublicAccess::Write,
    )
    .await
    {
        return *response;
    }
    let Some(reaction) = clean_reaction(&req.reaction) else {
        return invalid_reaction();
    };
    if !is_valid_reader_key(&req.reader_key) {
        return super::invalid_reader_key();
    }
    let Some(reader_name) = clean_reader_name(&req.reader_name) else {
        return super::invalid_reader_name();
    };
    let (_, record) = match public_document(&state, &token).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(response) = require_block(&state, &record, &req.block_id).await {
        return *response;
    }
    let caller = Caller::Reader(Some(req.reader_key.clone()));
    toggle_and_list(
        &state,
        &record,
        &req.block_id,
        &reaction,
        &caller,
        Some(&reader_name),
        Some(MAX_LIVE_REACTIONS),
    )
    .await
}
