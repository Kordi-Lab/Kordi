//! `GET /v1/cloud/common-ground/documents`: the account's own Kordi
//! documents a card can be built from. Only titles and sizes are read here;
//! a build reads the text of the ones picked.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::db_error;
use crate::{auth::routes::CloudSession, server::ServerState};

const MAX_LISTED: i64 = 50;

/// Documents a card may read: Markdown the account owns and finalized, not
/// a forwarded copy, and not written by an agent run someone else asked
/// for. The format rule matches `document_shares::render::document_format`,
/// with the file name an agent artifact, an agent document or the chat
/// message gave the attachment. `$2` narrows to these ids when not null.
const ELIGIBLE_SQL: &str = "
WITH owned AS MATERIALIZED (
    SELECT a.attachment_id, a.document_title, a.size_bytes, a.finalized_at,
           lower(btrim(split_part(COALESCE(a.content_type, a.detected_content_type, ''), ';', 1)))
               AS essence
    FROM cloud_attachments a
    WHERE a.owner_account_id = $1
      AND a.document_source_attachment_id IS NULL
      AND a.finalized_at IS NOT NULL
      AND ($2::text[] IS NULL OR a.attachment_id = ANY($2))
      AND lower(btrim(split_part(COALESCE(a.content_type, a.detected_content_type, ''), ';', 1)))
          IN ('text/markdown', 'text/x-markdown', '', 'text/plain', 'application/octet-stream')
      AND NOT EXISTS (
          SELECT 1 FROM cloud_agent_run_documents doc
          JOIN cloud_agent_fallback_runs run ON run.run_id = doc.run_id
          WHERE doc.attachment_id = a.attachment_id AND run.requester_account_id <> $1)
      AND NOT EXISTS (
          SELECT 1 FROM cloud_agent_run_artifacts artifact
          JOIN cloud_agent_fallback_runs run ON run.run_id = artifact.run_id
          WHERE artifact.attachment_id = a.attachment_id AND run.requester_account_id <> $1)
)
SELECT owned.attachment_id,
       COALESCE(NULLIF(btrim(owned.document_title), ''), NULLIF(btrim(doc.title), ''),
                NULLIF(regexp_replace(named.name, '\\.(md|markdown)$', '', 'i'), ''),
                'Untitled'),
       COALESCE(contents.updated_at, owned.finalized_at)::timestamptz AS updated_at,
       COALESCE(octet_length(contents.source)::bigint, owned.size_bytes)
FROM owned
LEFT JOIN cloud_agent_run_documents doc ON doc.attachment_id = owned.attachment_id
LEFT JOIN cloud_document_contents contents ON contents.attachment_id = owned.attachment_id
CROSS JOIN LATERAL (
    SELECT CASE WHEN char_length(btrim(found.name)) BETWEEN 1 AND 255
                THEN btrim(found.name) END AS name
    FROM (SELECT COALESCE(
        (SELECT artifact.name FROM cloud_agent_run_artifacts artifact
         WHERE artifact.attachment_id = owned.attachment_id
         ORDER BY artifact.created_at ASC LIMIT 1),
        doc.file_name,
        (SELECT item->>'name'
         FROM cloud_chat_message_attachments link
         JOIN cloud_chat_messages message ON message.message_id = link.message_id
         CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(message.content->'legacy_attachments') = 'array'
                  THEN message.content->'legacy_attachments' ELSE '[]'::jsonb END) item
         WHERE link.attachment_id = owned.attachment_id
           AND item->>'attachmentId' = owned.attachment_id
         ORDER BY message.created_at ASC LIMIT 1)) AS name) found
) named
WHERE owned.essence IN ('text/markdown', 'text/x-markdown')
   OR lower(named.name) ~ '\\.(md|markdown)$'
ORDER BY updated_at DESC, owned.attachment_id
LIMIT $3";

/// One document a card may read.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct EligibleDocument {
    pub attachment_id: String,
    pub title: String,
    pub updated_at: DateTime<Utc>,
    pub size_bytes: Option<i64>,
}

/// The account's eligible documents, newest first; only `ids` when given.
pub(super) async fn eligible(
    pool: &PgPool,
    account: &str,
    ids: Option<&[String]>,
) -> sqlx_core::Result<Vec<EligibleDocument>> {
    let rows: Vec<(String, String, DateTime<Utc>, Option<i64>)> = query_as(ELIGIBLE_SQL)
        .bind(account)
        .bind(ids)
        .bind(MAX_LISTED)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(attachment_id, title, updated_at, size_bytes)| EligibleDocument {
                attachment_id,
                title,
                updated_at,
                size_bytes,
            },
        )
        .collect())
}

/// `GET /v1/cloud/common-ground/documents`:
/// `{documents: [{attachmentId, title, updatedAt, sizeBytes}]}`.
pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match eligible(state.db_pool(), &session.account_id, None).await {
        Ok(documents) => {
            let documents: Vec<_> = documents
                .into_iter()
                .map(|document| {
                    json!({
                        "attachmentId": document.attachment_id,
                        "title": document.title,
                        "updatedAt": document.updated_at,
                        "sizeBytes": document.size_bytes,
                    })
                })
                .collect();
            (StatusCode::OK, Json(json!({ "documents": documents }))).into_response()
        }
        Err(error) => db_error(error),
    }
}
