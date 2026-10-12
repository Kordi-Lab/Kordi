//! Resolving a document for a viewer and looking up shares by token.
//!
//! Authenticated reads use the attachment rule in `attachments/access.rs`:
//! the owner, or an active member of a conversation that carries the
//! attachment. Public reads need a live, unrevoked share.

use axum::http::StatusCode;
use axum::response::Response;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

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
    pub attachment_id: String,
    pub object_key: String,
    pub owner_account_id: String,
    pub content_type: String,
    pub size_bytes: Option<i64>,
    pub created_at: String,
    pub format: DocumentFormat,
    pub file_name: String,
    pub author: DocumentAuthor,
    pub agent_name: Option<String>,
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
    let row: Option<AttachmentTuple> = query_as(
        "SELECT object_key, owner_account_id, content_type, detected_content_type, \
                    size_bytes, finalized_at \
             FROM cloud_attachments WHERE attachment_id = $1 AND finalized_at IS NOT NULL",
    )
    .bind(&share.attachment_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| db_error())?;
    let Some((object_key, owner, content_type, detected, size_bytes, finalized_at)) = row else {
        return Err(Box::new(link_off()));
    };
    if owner != share.owner_account_id {
        return Err(Box::new(link_off()));
    }
    let record = load_record(
        pool,
        AttachmentFacts {
            attachment_id: share.attachment_id.clone(),
            object_key,
            owner_account_id: owner,
            content_type: content_type.or(detected),
            size_bytes,
            created_at: finalized_at,
        },
    )
    .await?
    .ok_or_else(link_off)?;
    Ok((share, record))
}

/// The document for a signed-in viewer, with whether they own it.
pub(crate) async fn authorized_document(
    state: &ServerState,
    session: &CloudSession,
    attachment_id: &str,
) -> Result<(DocumentRecord, Viewer), Box<Response>> {
    let (object_key, owner, finalized_at, content_type, detected, size_bytes, _) =
        attachment_access_row(state, session, attachment_id)
            .await
            .map_err(|response| *response)?;
    let viewer = if owner == session.account_id {
        Viewer::Owner
    } else {
        Viewer::Member
    };
    let record = load_record(
        state.db_pool(),
        AttachmentFacts {
            attachment_id: attachment_id.to_string(),
            object_key,
            owner_account_id: owner,
            content_type: content_type.or(detected),
            size_bytes,
            created_at: finalized_at.unwrap_or_default(),
        },
    )
    .await?
    .ok_or_else(unsupported)?;
    Ok((record, viewer))
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
        file_name: named.unwrap_or_else(|| format.default_file_name().to_string()),
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

/// The session that carries the attachment. Members only see a session they
/// belong to; the owner sees the first session the file was sent in.
pub(crate) async fn document_session(
    pool: &PgPool,
    attachment_id: &str,
    member_account_id: Option<&str>,
) -> Result<Option<(String, Option<String>)>, sqlx_core::Error> {
    query_as(
        "SELECT COALESCE(conversation.legacy_session_id, conversation.conversation_id::text), \
                conversation.shared_title \
         FROM cloud_chat_message_attachments link \
         JOIN cloud_chat_messages message ON message.message_id = link.message_id \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = message.conversation_id \
         WHERE link.attachment_id = $1 \
           AND ($2::text IS NULL OR EXISTS ( \
                SELECT 1 FROM cloud_chat_conversation_members member \
                WHERE member.conversation_id = conversation.conversation_id \
                  AND member.account_id = $2 AND member.membership_state = 'active')) \
         ORDER BY message.created_at ASC LIMIT 1",
    )
    .bind(attachment_id)
    .bind(member_account_id)
    .fetch_optional(pool)
    .await
}

/// Whether `account_id` is an active member of a conversation that carries
/// the attachment.
pub(crate) async fn is_active_member(
    pool: &PgPool,
    attachment_id: &str,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let (member,): (bool,) = query_as(
        "SELECT EXISTS ( \
           SELECT 1 FROM cloud_chat_message_attachments link \
           JOIN cloud_chat_messages message ON message.message_id = link.message_id \
           JOIN cloud_chat_conversation_members member \
             ON member.conversation_id = message.conversation_id \
           WHERE link.attachment_id = $1 AND member.account_id = $2 \
             AND member.membership_state = 'active')",
    )
    .bind(attachment_id)
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    Ok(member)
}

/// `viewerCan.edit`: Markdown documents, for the owner and for active members
/// of a conversation that carries them.
pub(crate) async fn can_edit(
    pool: &PgPool,
    record: &DocumentRecord,
    viewer: Viewer,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    if record.format != DocumentFormat::Markdown {
        return Ok(false);
    }
    match viewer {
        Viewer::Owner => Ok(true),
        Viewer::Member => is_active_member(pool, &record.attachment_id, account_id).await,
        Viewer::Public => Ok(false),
    }
}
