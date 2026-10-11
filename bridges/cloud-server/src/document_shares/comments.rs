//! Block comments. Authors edit and delete their own; the attachment owner
//! or the author resolves.

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

use super::access::{
    authorized_document, clean_display_name, public_document, syncable_avatar_url, DocumentRecord,
};
use super::model::{
    CommentAuthor, CommentRequest, DocumentComment, PatchCommentRequest, PublicCommentRequest,
};
use super::validate::{clean_body, clean_reader_name, is_valid_reader_key, mentions_agent};
use super::{db_error, err, observe_public, require_block, Caller, PublicAccess};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

/// Live comments a document may carry before public writes stop.
pub(crate) const MAX_LIVE_COMMENTS: i64 = 500;

const COMMENT_SELECT: &str = "SELECT comment.comment_id, comment.block_id, \
        comment.parent_comment_id, comment.author_account_id, comment.author_reader_key, \
        comment.author_name, account.display_name, account.public_account_number, \
        account.avatar_url, comment.body, comment.mentions_agent, comment.created_at, \
        comment.edited_at, comment.resolved_at \
     FROM cloud_document_comments comment \
     LEFT JOIN cloud_accounts account ON account.account_id = comment.author_account_id";

type CommentRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
    String,
    bool,
    String,
    Option<String>,
    Option<String>,
);

/// Undeleted comments on the document, resolved ones included, oldest first.
pub(crate) async fn list_comments(
    pool: &PgPool,
    record: &DocumentRecord,
    caller: &Caller,
) -> Result<Vec<DocumentComment>, sqlx_core::Error> {
    let rows: Vec<CommentRow> = query_as(&format!(
        "{COMMENT_SELECT} WHERE comment.attachment_id = $1 AND comment.deleted_at IS NULL \
         ORDER BY comment.created_at ASC, comment.comment_id ASC"
    ))
    .bind(&record.attachment_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| comment_from_row(row, &record.owner_account_id, caller))
        .collect())
}

async fn load_comment(
    pool: &PgPool,
    comment_id: &str,
    owner_account_id: &str,
    caller: &Caller,
) -> Result<Option<DocumentComment>, sqlx_core::Error> {
    let row: Option<CommentRow> = query_as(&format!(
        "{COMMENT_SELECT} WHERE comment.comment_id = $1 AND comment.deleted_at IS NULL"
    ))
    .bind(comment_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| comment_from_row(row, owner_account_id, caller)))
}

/// Public responses carry no account ids, and a Kordi ID only for the
/// document author, whose profile the page already shows.
fn comment_from_row(row: CommentRow, document_owner: &str, caller: &Caller) -> DocumentComment {
    let (comment_id, block_id, parent, account_id, reader_key, author_name, name, number, avatar) = (
        row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8,
    );
    let mine = caller.owns(account_id.as_deref(), reader_key.as_deref());
    let author = match &account_id {
        Some(account) => CommentAuthor {
            account_id: (!caller.is_public()).then(|| account.clone()),
            display_name: clean_display_name(name.as_deref().or(Some(&author_name))),
            kordi_id: number
                .filter(|_| !caller.is_public() || account == document_owner)
                .map(|value| value.to_string()),
            avatar_url: avatar.as_deref().and_then(syncable_avatar_url),
        },
        None => CommentAuthor {
            account_id: None,
            display_name: clean_display_name(Some(&author_name)),
            kordi_id: None,
            avatar_url: None,
        },
    };
    DocumentComment {
        comment_id,
        block_id,
        parent_comment_id: parent,
        author,
        body: row.9,
        mentions_agent: row.10,
        mine,
        created_at: row.11,
        edited_at: row.12,
        resolved_at: row.13,
    }
}

struct NewComment<'a> {
    block_id: &'a str,
    body: &'a str,
    parent_comment_id: Option<&'a str>,
    author_name: &'a str,
}

async fn create(
    state: &ServerState,
    record: &DocumentRecord,
    caller: &Caller,
    input: NewComment<'_>,
    cap: Option<i64>,
) -> Response {
    let pool = state.db_pool();
    let Some(body) = clean_body(input.body) else {
        return err(
            "invalid_comment",
            "Comments are 1 to 4000 characters.",
            StatusCode::BAD_REQUEST,
        );
    };
    if let Err(response) = require_block(state, record, input.block_id).await {
        return *response;
    }
    if let Some(parent) = input.parent_comment_id {
        let found: Result<Option<(String,)>, _> = query_as(
            "SELECT block_id FROM cloud_document_comments \
             WHERE comment_id = $1 AND attachment_id = $2 AND deleted_at IS NULL",
        )
        .bind(parent)
        .bind(&record.attachment_id)
        .fetch_optional(pool)
        .await;
        match found {
            Ok(Some((block,))) if block == input.block_id => {}
            Ok(_) => {
                return err(
                    "invalid_comment",
                    "The comment you are replying to is gone.",
                    StatusCode::BAD_REQUEST,
                )
            }
            Err(_) => return db_error(),
        }
    }
    if let Some(cap) = cap {
        let live: Result<(i64,), _> = query_as(
            "SELECT COUNT(*)::BIGINT FROM cloud_document_comments \
             WHERE attachment_id = $1 AND deleted_at IS NULL",
        )
        .bind(&record.attachment_id)
        .fetch_one(pool)
        .await;
        match live {
            Ok((live,)) if live >= cap => return super::limit_reached(),
            Ok(_) => {}
            Err(_) => return db_error(),
        }
    }
    let comment_id = format!("doccmt_{}", uuid::Uuid::new_v4().simple());
    let (account_id, reader_key) = caller.columns();
    let inserted = query(
        "INSERT INTO cloud_document_comments \
         (comment_id, attachment_id, block_id, parent_comment_id, author_account_id, \
          author_reader_key, author_name, body, mentions_agent, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(&comment_id)
    .bind(&record.attachment_id)
    .bind(input.block_id)
    .bind(input.parent_comment_id)
    .bind(account_id)
    .bind(reader_key)
    .bind(input.author_name)
    .bind(&body)
    .bind(mentions_agent(&body, record.agent_name.as_deref()))
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await;
    if inserted.is_err() {
        return db_error();
    }
    match load_comment(pool, &comment_id, &record.owner_account_id, caller).await {
        Ok(Some(comment)) => Json(comment).into_response(),
        Ok(None) | Err(_) => db_error(),
    }
}

/// `POST /v1/cloud/documents/:attachment_id/comments`
pub(crate) async fn comment(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
    Json(req): Json<CommentRequest>,
) -> Response {
    let (record, _) = match authorized_document(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let author = match super::access::load_author(state.db_pool(), &session.account_id).await {
        Ok(author) => author,
        Err(_) => return db_error(),
    };
    let caller = Caller::Account(session.account_id.clone());
    let input = NewComment {
        block_id: &req.block_id,
        body: &req.body,
        parent_comment_id: req.parent_comment_id.as_deref(),
        author_name: &author.display_name,
    };
    create(&state, &record, &caller, input, None).await
}

/// `POST /v1/cloud/public/documents/:token/comments`
pub(crate) async fn comment_public(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path(token): Path<String>,
    Json(req): Json<PublicCommentRequest>,
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
    let caller = Caller::Reader(Some(req.reader_key.clone()));
    let input = NewComment {
        block_id: &req.block_id,
        body: &req.body,
        parent_comment_id: req.parent_comment_id.as_deref(),
        author_name: &reader_name,
    };
    create(&state, &record, &caller, input, Some(MAX_LIVE_COMMENTS)).await
}

/// The comment's document for a signed-in caller who can read it, plus the
/// comment's author account.
async fn comment_for_caller(
    state: &ServerState,
    session: &CloudSession,
    comment_id: &str,
) -> Result<(DocumentRecord, Option<String>), Box<Response>> {
    let row: Option<(String, Option<String>)> = query_as(
        "SELECT attachment_id, author_account_id FROM cloud_document_comments \
         WHERE comment_id = $1 AND deleted_at IS NULL",
    )
    .bind(comment_id)
    .fetch_optional(state.db_pool())
    .await
    .map_err(|_| db_error())?;
    let not_found = || err("not_found", "Comment not found.", StatusCode::NOT_FOUND);
    let (attachment_id, author) = row.ok_or_else(not_found)?;
    let (record, _) = authorized_document(state, session, &attachment_id)
        .await
        .map_err(|_| not_found())?;
    Ok((record, author))
}

fn forbidden() -> Response {
    err(
        "document_comment_forbidden",
        "You can only change your own comments.",
        StatusCode::FORBIDDEN,
    )
}

/// `PATCH /v1/cloud/documents/comments/:comment_id`
pub(crate) async fn patch_comment(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(comment_id): Path<String>,
    Json(req): Json<PatchCommentRequest>,
) -> Response {
    let (record, author) = match comment_for_caller(&state, &session, &comment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let is_author = author.as_deref() == Some(session.account_id.as_str());
    let is_owner = record.owner_account_id == session.account_id;
    let body = match req.body.as_deref() {
        Some(_) if !is_author => return forbidden(),
        Some(value) => match clean_body(value) {
            Some(body) => Some(body),
            None => {
                return err(
                    "invalid_comment",
                    "Comments are 1 to 4000 characters.",
                    StatusCode::BAD_REQUEST,
                )
            }
        },
        None => None,
    };
    if req.resolved.is_some() && !is_author && !is_owner {
        return forbidden();
    }
    let now = Utc::now().to_rfc3339();
    let mentions = body
        .as_deref()
        .map(|body| mentions_agent(body, record.agent_name.as_deref()));
    let updated = query(
        "UPDATE cloud_document_comments SET \
           body = COALESCE($2, body), \
           mentions_agent = COALESCE($3, mentions_agent), \
           edited_at = CASE WHEN $2::text IS NULL THEN edited_at ELSE $4 END, \
           resolved_at = CASE WHEN $5::boolean IS NULL THEN resolved_at \
                              WHEN $5 THEN COALESCE(resolved_at, $4) ELSE NULL END \
         WHERE comment_id = $1 AND deleted_at IS NULL",
    )
    .bind(&comment_id)
    .bind(body.as_deref())
    .bind(mentions)
    .bind(&now)
    .bind(req.resolved)
    .execute(state.db_pool())
    .await;
    if updated.is_err() {
        return db_error();
    }
    let caller = Caller::Account(session.account_id.clone());
    match load_comment(
        state.db_pool(),
        &comment_id,
        &record.owner_account_id,
        &caller,
    )
    .await
    {
        Ok(Some(comment)) => Json(comment).into_response(),
        Ok(None) => err("not_found", "Comment not found.", StatusCode::NOT_FOUND),
        Err(_) => db_error(),
    }
}

/// `DELETE /v1/cloud/documents/comments/:comment_id`
pub(crate) async fn delete_comment(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(comment_id): Path<String>,
) -> Response {
    let (_, author) = match comment_for_caller(&state, &session, &comment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if author.as_deref() != Some(session.account_id.as_str()) {
        return forbidden();
    }
    match query(
        "UPDATE cloud_document_comments SET deleted_at = $2 \
         WHERE comment_id = $1 AND deleted_at IS NULL",
    )
    .bind(&comment_id)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db_pool())
    .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => db_error(),
    }
}
