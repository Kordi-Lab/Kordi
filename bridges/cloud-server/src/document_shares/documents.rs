//! Reading documents: the authenticated and public JSON routes, the
//! authenticated raw HTML route, and the response assembly they share.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};

use super::access::{
    authorized_document, document_session, public_document, DocumentRecord, ShareRow,
};
use super::canonical::can_edit;
use super::comments::list_comments;
use super::contents::{document_source, DocumentSource};
use super::model::{
    DocumentAgent, DocumentFormat, DocumentResponse, PublicReadQuery, Viewer, ViewerCan,
};
use super::reactions::list_reactions;
use super::render::document_blocks;
use super::shares::{live_shares, share_response};
use super::tokens::{public_raw_path, share_secret};
use super::validate::is_valid_reader_key;
use super::{db_error, err, observe_public, Caller, PublicAccess};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

/// CSP for raw HTML documents: no script, no network except images and
/// fonts, and a unique origin.
pub(crate) const RAW_HTML_CSP: &str = "sandbox; default-src 'none'; img-src data: https:; \
     style-src 'unsafe-inline'; font-src https: data:";

/// Builds the response for `viewer`. `share` is the owner's live share, or
/// the share a public reader came through.
pub(crate) async fn document_response(
    state: &ServerState,
    record: &DocumentRecord,
    document: &DocumentSource,
    viewer: Viewer,
    caller: &Caller,
    share: Option<&ShareRow>,
    raw_path: Option<String>,
) -> Result<DocumentResponse, Box<Response>> {
    let pool = state.db_pool();
    let source = document.text.as_str();
    let session = match (viewer, caller) {
        (Viewer::Public, _) | (_, Caller::Reader(_)) => None,
        (_, Caller::Account(account)) => {
            let own = document_session(pool, &record.attachment_id, Some(account))
                .await
                .map_err(|_| db_error())?;
            match own {
                Some(found) => Some(found),
                None if viewer == Viewer::Owner => {
                    document_session(pool, &record.attachment_id, None)
                        .await
                        .map_err(|_| db_error())?
                }
                None => None,
            }
        }
    };
    let reactions = list_reactions(pool, &record.attachment_id, None, caller)
        .await
        .map_err(|_| db_error())?;
    let comments = list_comments(pool, record, caller)
        .await
        .map_err(|_| db_error())?;
    let mut author = record.author.clone();
    if viewer == Viewer::Public {
        // Public payloads carry the author's public profile, not the account id.
        author.account_id = String::new();
    }
    let owner_share = match (viewer, share, share_secret()) {
        (Viewer::Owner, Some(row), Some(secret)) => Some(share_response(&secret, row)),
        _ => None,
    };
    let readers_can_ask_agent = share.is_some_and(|row| row.readers_can_ask_agent);
    let edit = match caller {
        Caller::Account(account) => can_edit(pool, record, viewer, account)
            .await
            .map_err(|_| db_error())?,
        Caller::Reader(_) => false,
    };
    let (session_id, session_title) = session.map_or((None, None), |(id, title)| (Some(id), title));
    Ok(DocumentResponse {
        attachment_id: record.attachment_id.clone(),
        requested_attachment_id: (record.requested_attachment_id != record.attachment_id
            && !record.requested_attachment_id.is_empty())
        .then(|| record.requested_attachment_id.clone()),
        title: record.title(source),
        file_name: record.file_name.clone(),
        format: record.format,
        content_type: record.content_type.clone(),
        size_bytes: record.size_bytes,
        created_at: record.created_at.clone(),
        updated_at: document
            .updated_at
            .clone()
            .unwrap_or_else(|| record.created_at.clone()),
        session_id,
        session_title,
        author,
        agent: record
            .agent_name
            .clone()
            .map(|display_name| DocumentAgent { display_name }),
        blocks: document_blocks(record.format, source),
        raw_path: (record.format == DocumentFormat::Html)
            .then_some(raw_path)
            .flatten(),
        revision: document.revision,
        reactions,
        comments,
        share: owner_share,
        viewer,
        viewer_can: ViewerCan {
            share: viewer == Viewer::Owner,
            react: true,
            comment: true,
            ask_agent: viewer != Viewer::Public || readers_can_ask_agent,
            edit,
        },
    })
}

/// `GET /v1/cloud/documents/:attachment_id`
pub(crate) async fn get_document(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    let (record, viewer) = match authorized_document(&state, &session, &attachment_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let source = match document_source(&state, &record).await {
        Ok(source) => source,
        Err(response) => return *response,
    };
    match signed_in_response(&state, &session, &record, viewer, &source).await {
        Ok(response) => Json(response).into_response(),
        Err(response) => *response,
    }
}

/// The response a signed-in viewer gets for `source`, with the owner's live
/// share when the viewer owns the document.
pub(crate) async fn signed_in_response(
    state: &ServerState,
    session: &CloudSession,
    record: &DocumentRecord,
    viewer: Viewer,
    source: &DocumentSource,
) -> Result<DocumentResponse, Box<Response>> {
    let share = if viewer == Viewer::Owner {
        live_shares(state.db_pool(), &session.account_id, &record.attachment_id)
            .await
            .map_err(|_| db_error())?
            .into_iter()
            .next()
    } else {
        None
    };
    let caller = Caller::Account(session.account_id.clone());
    let raw_path = format!("/v1/cloud/documents/{}/raw", record.requested_attachment_id);
    document_response(
        state,
        record,
        source,
        viewer,
        &caller,
        share.as_ref(),
        Some(raw_path),
    )
    .await
}

/// `GET /v1/cloud/public/documents/:token`
pub(crate) async fn get_public_document(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    Path(token): Path<String>,
    Query(query): Query<PublicReadQuery>,
) -> Response {
    if let Err(response) = observe_public(
        &rate_limiter,
        &headers,
        connect_info.as_ref(),
        PublicAccess::Read,
    )
    .await
    {
        return *response;
    }
    let (share, record) = match public_document(&state, &token).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let source = match document_source(&state, &record).await {
        Ok(source) => source,
        Err(response) => return *response,
    };
    let reader_key = query
        .reader_key
        .or_else(|| {
            headers
                .get("x-kordi-reader-key")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .filter(|key| is_valid_reader_key(key));
    let caller = Caller::Reader(reader_key);
    match document_response(
        &state,
        &record,
        &source,
        Viewer::Public,
        &caller,
        Some(&share),
        Some(public_raw_path(&token)),
    )
    .await
    {
        Ok(response) => Json(response).into_response(),
        Err(response) => *response,
    }
}

/// Serves HTML document bytes under the sandbox CSP; Markdown answers 404.
pub(crate) async fn raw_html_response(state: &ServerState, record: &DocumentRecord) -> Response {
    if record.format != DocumentFormat::Html {
        return err(
            "not_found",
            "This document has no raw view.",
            StatusCode::NOT_FOUND,
        );
    }
    let source = match document_source(state, record).await {
        Ok(source) => source,
        Err(response) => return *response,
    };
    let mut response = source.text.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(RAW_HTML_CSP),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `GET /v1/cloud/documents/:attachment_id/raw`
pub(crate) async fn get_raw(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    match authorized_document(&state, &session, &attachment_id).await {
        Ok((record, _)) => raw_html_response(&state, &record).await,
        Err(response) => *response,
    }
}
