//! Resolving a document for a viewer and looking up shares by token.
//!
//! Authenticated reads use the attachment rule in `attachments/access.rs`:
//! the owner, or an active member of a conversation that carries the
//! attachment. Public reads need a live, unrevoked share.

use axum::http::StatusCode;
use axum::response::Response;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::canonical::{canonical_attachment_id, readable_family_attachment, FAMILY_CTE};
use super::model::{DocumentAuthor, DocumentFormat, Viewer};
use super::tokens::{hash_share_token, is_well_formed_token};
use super::{db_error, err, link_off};
use crate::attachments::access::attachment_access_row;
use crate::auth::routes::CloudSession;
use crate::cloud_agent_runtime::artifacts::MAX_ARTIFACT_EXPORT_BYTES;
use crate::server::ServerState;

/// Largest document the server renders or serves raw.
pub(crate) const MAX_DOCUMENT_BYTES: usize = MAX_ARTIFACT_EXPORT_BYTES;

#[derive(Debug, Clone)]
pub(crate) struct DocumentRecord {
    /// The canonical attachment.
    pub attachment_id: String,
    /// The id the caller asked for; a forwarded copy or the canonical id.
    pub requested_attachment_id: String,
    pub object_key: String,
    pub owner_account_id: String,
    pub content_type: String,
    pub size_bytes: Option<i64>,
    pub created_at: String,
    pub format: DocumentFormat,
    pub file_name: String,
    /// The title a member renamed the document to, if any.
    pub stored_title: Option<String>,
    pub author: DocumentAuthor,
    pub agent_name: Option<String>,
}

impl DocumentRecord {
    /// The title readers see for `source` (see [`super::render::document_title`]).
    pub(crate) fn title(&self, source: &str) -> String {
        super::render::document_title(
            self.format,
            source,
            self.stored_title.as_deref(),
            &self.file_name,
        )
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ShareRow {
    pub share_id: String,
    pub attachment_id: String,
    pub owner_account_id: String,
    pub access_mode: String,
    pub readers_can_ask_agent: bool,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

pub(crate) type ShareTuple = (String, String, String, String, bool, String, Option<String>);

type AttachmentTuple = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<i64>,
    String,
    Option<String>,
);

pub(crate) const SHARE_COLUMNS: &str = "share_id, attachment_id, owner_account_id, access_mode, \
     readers_can_ask_agent, created_at, revoked_at";

impl From<ShareTuple> for ShareRow {
    fn from(row: ShareTuple) -> Self {
        Self {
            share_id: row.0,
            attachment_id: row.1,
            owner_account_id: row.2,
            access_mode: row.3,
            readers_can_ask_agent: row.4,
            created_at: row.5,
            revoked_at: row.6,
        }
    }
}

/// A live share for `token`, or `None` for revoked, unknown, and malformed
/// tokens alike.
pub(crate) async fn live_share_for_token(
    pool: &PgPool,
    token: &str,
) -> Result<Option<ShareRow>, sqlx_core::Error> {
    if !is_well_formed_token(token) {
        return Ok(None);
    }
    let row: Option<ShareTuple> = query_as(&format!(
        "SELECT {SHARE_COLUMNS} FROM cloud_document_shares \
         WHERE token_hash = $1 AND revoked_at IS NULL"
    ))
    .bind(hash_share_token(token))
    .fetch_optional(pool)
    .await?;
    Ok(row.map(ShareRow::from))
}

/// The document behind a token, or `404 document_link_off`.
pub(crate) async fn public_document(
    state: &ServerState,
    token: &str,
) -> Result<(ShareRow, DocumentRecord), Box<Response>> {
    let pool = state.db_pool();
    let share = live_share_for_token(pool, token)
        .await
        .map_err(|_| db_error())?
        .ok_or_else(link_off)?;
    let canonical = canonical_attachment_id(pool, &share.attachment_id)
        .await
        .map_err(|_| db_error())?;
    let facts = attachment_facts(pool, &canonical)
        .await?
        .ok_or_else(link_off)?;
    if facts.owner_account_id != share.owner_account_id {
        return Err(Box::new(link_off()));
    }
    let mut record = load_record(pool, facts).await?.ok_or_else(link_off)?;
    record.requested_attachment_id = record.attachment_id.clone();
    Ok((share, record))
}

/// A finalized attachment's facts, or `None`.
async fn attachment_facts(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<Option<AttachmentFacts>, Box<Response>> {
    let row: Option<AttachmentTuple> = query_as(
        "SELECT object_key, owner_account_id, content_type, detected_content_type, \
                size_bytes, finalized_at, document_title \
         FROM cloud_attachments WHERE attachment_id = $1 AND finalized_at IS NOT NULL",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| db_error())?;
    Ok(row.map(
        |(object_key, owner, content_type, detected, size_bytes, finalized_at, document_title)| {
            AttachmentFacts {
                attachment_id: attachment_id.to_string(),
                object_key,
                owner_account_id: owner,
                content_type: content_type.or(detected),
                size_bytes,
                created_at: finalized_at,
                document_title,
            }
        },
    ))
}

/// The canonical document for a signed-in viewer of `attachment_id`.
/// Access is checked on the requested id (a forwarded copy the caller was
/// sent counts), then the canonical document is loaded. Only the owner of
/// the canonical attachment is `owner`; the owner of a forwarded copy is a
/// member.
pub(crate) async fn authorized_document(
    state: &ServerState,
    session: &CloudSession,
    attachment_id: &str,
) -> Result<(DocumentRecord, Viewer), Box<Response>> {
    attachment_access_row(state, session, attachment_id)
        .await
        .map_err(|response| *response)?;
    let pool = state.db_pool();
    let canonical = canonical_attachment_id(pool, attachment_id)
        .await
        .map_err(|_| db_error())?;
    let facts = attachment_facts(pool, &canonical)
        .await?
        .ok_or_else(|| err("not_found", "Attachment not found.", StatusCode::NOT_FOUND))?;
    let viewer = if facts.owner_account_id == session.account_id {
        Viewer::Owner
    } else {
        Viewer::Member
    };
    let mut record = load_record(pool, facts).await?.ok_or_else(unsupported)?;
    record.requested_attachment_id = attachment_id.to_string();
    Ok((record, viewer))
}

/// Like [`authorized_document`] for routes that only know the canonical id
/// (comment edits): the caller may reach it through any copy they can read.
pub(crate) async fn authorized_canonical_document(
    state: &ServerState,
    session: &CloudSession,
    canonical: &str,
) -> Result<(DocumentRecord, Viewer), Box<Response>> {
    let readable = readable_family_attachment(state.db_pool(), canonical, &session.account_id)
        .await
        .map_err(|_| db_error())?
        .unwrap_or_else(|| canonical.to_string());
    authorized_document(state, session, &readable).await
}

/// The canonical document behind `attachment_id` with no viewer: for agent
/// runs, whose access is checked against the run's accounts by the caller.
pub(crate) async fn canonical_record(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<Option<DocumentRecord>, Box<Response>> {
    let canonical = canonical_attachment_id(pool, attachment_id)
        .await
        .map_err(|_| db_error())?;
    let Some(facts) = attachment_facts(pool, &canonical).await? else {
        return Ok(None);
    };
    let record = load_record(pool, facts).await?;
    Ok(record.map(|mut record| {
        record.requested_attachment_id = attachment_id.to_string();
        record
    }))
}

fn unsupported() -> Response {
    err(
        "document_unsupported",
        "Only Markdown and HTML files open as documents.",
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
    )
}

pub(crate) struct AttachmentFacts {
    pub attachment_id: String,
    pub object_key: String,
    pub owner_account_id: String,
    pub content_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub created_at: String,
    pub document_title: Option<String>,
}

/// Loads file name, author, and agent. `None` when the attachment is not a
/// Markdown or HTML document.
async fn load_record(
    pool: &PgPool,
    facts: AttachmentFacts,
) -> Result<Option<DocumentRecord>, Box<Response>> {
    let artifact: Option<(String, String)> = query_as(
        "SELECT artifact.name, \
                COALESCE((SELECT definition.name FROM cloud_agent_definitions definition \
                          WHERE definition.agent_id = run.execution_agent_id \
                            AND definition.owner_account_id = run.owner_account_id), \
                         profile.display_name, 'Kordi') \
         FROM cloud_agent_run_artifacts artifact \
         JOIN cloud_agent_fallback_runs run ON run.run_id = artifact.run_id \
         LEFT JOIN cloud_default_agent_profiles profile \
           ON profile.owner_account_id = run.owner_account_id \
         WHERE artifact.attachment_id = $1 \
         ORDER BY artifact.created_at ASC LIMIT 1",
    )
    .bind(&facts.attachment_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| db_error())?;
    let envelope_name = if artifact.is_none() {
        message_envelope_name(pool, &facts.attachment_id)
            .await
            .map_err(|_| db_error())?
    } else {
        None
    };
    let named = artifact
        .as_ref()
        .map(|(name, _)| name.clone())
        .or(envelope_name)
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty() && name.chars().count() <= 255);
    let content_type = facts.content_type.unwrap_or_default();
    let Some(format) =
        super::render::document_format(&content_type, named.as_deref().unwrap_or_default())
    else {
        return Ok(None);
    };
    let author = load_author(pool, &facts.owner_account_id)
        .await
        .map_err(|_| db_error())?;
    Ok(Some(DocumentRecord {
        attachment_id: facts.attachment_id,
        object_key: facts.object_key,
        owner_account_id: facts.owner_account_id,
        content_type: if content_type.is_empty() {
            match format {
                DocumentFormat::Markdown => "text/markdown".to_string(),
                DocumentFormat::Html => "text/html".to_string(),
            }
        } else {
            content_type
        },
        size_bytes: facts.size_bytes,
        created_at: facts.created_at,
        requested_attachment_id: String::new(),
        file_name: named.unwrap_or_else(|| format.default_file_name().to_string()),
        stored_title: facts.document_title,
        format,
        author,
        agent_name: artifact.map(|(_, agent)| agent),
    }))
}

/// The file name a chat message recorded for the attachment.
async fn message_envelope_name(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(Option<String>,)> = query_as(
        "SELECT item->>'name' \
         FROM cloud_chat_message_attachments link \
         JOIN cloud_chat_messages message ON message.message_id = link.message_id \
         CROSS JOIN LATERAL jsonb_array_elements( \
             CASE WHEN jsonb_typeof(message.content->'legacy_attachments') = 'array' \
                  THEN message.content->'legacy_attachments' ELSE '[]'::jsonb END) item \
         WHERE link.attachment_id = $1 AND item->>'attachmentId' = $1 \
         ORDER BY message.created_at ASC LIMIT 1",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(name,)| name))
}

pub(crate) async fn load_author(
    pool: &PgPool,
    account_id: &str,
) -> Result<DocumentAuthor, sqlx_core::Error> {
    let row: Option<(Option<String>, Option<i64>, Option<String>)> = query_as(
        "SELECT display_name, public_account_number, avatar_url \
         FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    let (display_name, number, avatar_url) = row.unwrap_or((None, None, None));
    Ok(DocumentAuthor {
        account_id: account_id.to_string(),
        display_name: clean_display_name(display_name.as_deref()),
        kordi_id: number.map(|value| value.to_string()).unwrap_or_default(),
        avatar_url: avatar_url.as_deref().and_then(syncable_avatar_url),
    })
}

pub(crate) fn clean_display_name(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Kordi member")
        .chars()
        .take(80)
        .collect()
}

/// Same rule as the group invitation lookup: generated avatar markers,
/// http(s) URLs, and small raster data URLs.
pub(crate) fn syncable_avatar_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 {
        return None;
    }
    (crate::avatars::parse_generated_avatar_marker(value).is_some()
        || value.starts_with("https://")
        || value.starts_with("http://")
        || value.starts_with("data:image/png;base64,")
        || value.starts_with("data:image/jpeg;base64,")
        || value.starts_with("data:image/webp;base64,"))
    .then(|| value.to_string())
}

/// The session that carries the document or a copy of it. Members only see
/// a session they belong to; with no member filter, the first session the
/// canonical file was sent in.
pub(crate) async fn document_session(
    pool: &PgPool,
    canonical: &str,
    member_account_id: Option<&str>,
) -> Result<Option<(String, Option<String>)>, sqlx_core::Error> {
    query_as(&format!(
        "{FAMILY_CTE} SELECT COALESCE(conversation.legacy_session_id, conversation.conversation_id::text), \
                conversation.shared_title \
         FROM cloud_chat_message_attachments link \
         JOIN cloud_chat_messages message ON message.message_id = link.message_id \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = message.conversation_id \
         WHERE link.attachment_id IN (SELECT attachment_id FROM family) \
           AND ($2::text IS NULL OR EXISTS ( \
                SELECT 1 FROM cloud_chat_conversation_members member \
                WHERE member.conversation_id = conversation.conversation_id \
                  AND member.account_id = $2 AND member.membership_state = 'active')) \
         ORDER BY (link.attachment_id = $1) DESC, message.created_at ASC LIMIT 1"
    ))
    .bind(canonical)
    .bind(member_account_id)
    .fetch_optional(pool)
    .await
}
