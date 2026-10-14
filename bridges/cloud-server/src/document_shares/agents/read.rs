//! `read_document`: the current revision, title, and blocks of a document,
//! optionally with its open comment threads.
//!
//! The agent's owner and the requester must both be active members of a
//! conversation that carries the document or a copy of it. A forwarded copy
//! resolves to its canonical document, like every document route.

use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::super::access::{canonical_record, DocumentRecord};
use super::super::canonical::{canonical_attachment_id, is_family_member};
use super::super::contents::document_source;
use super::super::model::DocumentFormat;
use super::super::render::{document_format, markdown_blocks};
use super::gating::RunFacts;
use super::threads::{load_comments, open_threads};
use super::tools::{tool_blocks, ToolError};
use super::MAX_TOOL_TEXT_BYTES;
use crate::server::ServerState;

/// Most recent attachments of a session inspected for documents.
const SESSION_ATTACHMENT_SCAN: i64 = 200;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ReadArguments {
    attachment_id: Option<String>,
    include_comments: bool,
}

/// The Markdown and HTML attachments sent in `session_id`, newest first, as
/// `(attachment id, file name)`.
pub(crate) async fn session_documents(
    pool: &PgPool,
    session_id: &str,
) -> Result<Vec<(String, String)>, sqlx_core::Error> {
    let rows: Vec<(String, String, String)> = query_as(
        "SELECT attachment.attachment_id, \
                COALESCE(attachment.content_type, attachment.detected_content_type, ''), \
                COALESCE( \
                  (SELECT artifact.name FROM cloud_agent_run_artifacts artifact \
                    WHERE artifact.attachment_id = attachment.attachment_id \
                    ORDER BY artifact.created_at ASC LIMIT 1), \
                  (SELECT item->>'name' FROM jsonb_array_elements( \
                      CASE WHEN jsonb_typeof(message.content->'legacy_attachments') = 'array' \
                           THEN message.content->'legacy_attachments' ELSE '[]'::jsonb END) item \
                    WHERE item->>'attachmentId' = attachment.attachment_id LIMIT 1), \
                  '') \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_messages message \
           ON message.conversation_id = conversation.conversation_id \
         JOIN cloud_chat_message_attachments link ON link.message_id = message.message_id \
         JOIN cloud_attachments attachment ON attachment.attachment_id = link.attachment_id \
         WHERE conversation.legacy_session_id = $1 AND message.deleted_at IS NULL \
           AND attachment.finalized_at IS NOT NULL \
         ORDER BY message.created_at DESC LIMIT $2",
    )
    .bind(session_id)
    .bind(SESSION_ATTACHMENT_SCAN)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, content_type, name)| document_format(content_type, name.trim()).is_some())
        .map(|(attachment_id, _, name)| (attachment_id, name.trim().to_string()))
        .collect())
}

/// The session's documents by canonical id, each once.
async fn canonical_session_documents(
    pool: &PgPool,
    session_id: &str,
) -> Result<Vec<(String, String)>, sqlx_core::Error> {
    let mut documents: Vec<(String, String)> = Vec::new();
    for (attachment_id, name) in session_documents(pool, session_id).await? {
        let canonical = canonical_attachment_id(pool, &attachment_id).await?;
        if !documents.iter().any(|(id, _)| *id == canonical) {
            documents.push((canonical, name));
        }
    }
    Ok(documents)
}

/// Both the agent's owner and the requester are active members of a
/// conversation that carries the document family.
pub(crate) async fn run_can_read(
    pool: &PgPool,
    facts: &RunFacts,
    record: &DocumentRecord,
) -> Result<bool, sqlx_core::Error> {
    for account in [&facts.owner_account_id, &facts.requester_account_id] {
        if !is_family_member(pool, &record.attachment_id, account).await? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The document a call names, or the run's own document.
async fn target(
    pool: &PgPool,
    facts: &RunFacts,
    attachment_id: Option<&str>,
) -> Result<Result<DocumentRecord, Value>, ToolError> {
    if let Some(attachment_id) = attachment_id {
        let record = canonical_record(pool, attachment_id)
            .await
            .map_err(|_| ToolError::Server)?
            .ok_or(ToolError::NotFound)?;
        return Ok(Ok(record));
    }
    if let Some(record) = &facts.document {
        return Ok(Ok(record.clone()));
    }
    if facts.gate.comment_run {
        return Err(ToolError::NotFound);
    }
    let documents = canonical_session_documents(pool, &facts.session_id).await?;
    match documents.as_slice() {
        [] => Err(ToolError::NotFound),
        [(only, _)] => canonical_record(pool, only)
            .await
            .map_err(|_| ToolError::Server)?
            .ok_or(ToolError::NotFound)
            .map(Ok),
        _ => Ok(Err(json!({
            "documents": documents
                .iter()
                .map(|(id, name)| json!({ "attachmentId": id, "fileName": name }))
                .collect::<Vec<_>>(),
            "message": "This conversation has several documents. Call read_document again with attachmentId.",
        }))),
    }
}

pub(super) async fn execute(
    state: &ServerState,
    facts: &RunFacts,
    args: &Value,
) -> Result<Value, ToolError> {
    let pool = state.db_pool();
    let args: ReadArguments = match args {
        Value::Null => ReadArguments::default(),
        other => serde_json::from_value(other.clone()).map_err(|_| {
            ToolError::Invalid("read_document takes attachmentId and includeComments.".into())
        })?,
    };
    let requested = args
        .attachment_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if requested.is_some_and(|id| id.len() > 256) {
        return Err(ToolError::NotFound);
    }
    let record = match target(pool, facts, requested).await? {
        Ok(record) => record,
        Err(listing) => return Ok(listing),
    };
    if !run_can_read(pool, facts, &record).await? {
        return Err(ToolError::NotFound);
    }
    let source = document_source(state, &record)
        .await
        .map_err(|_| ToolError::Server)?;
    let (blocks, truncated) = match record.format {
        DocumentFormat::Markdown => tool_blocks(&markdown_blocks(&source.text)),
        DocumentFormat::Html => {
            let text = html_text(&source.text);
            let cut = truncate_at_boundary(&text, MAX_TOOL_TEXT_BYTES);
            (
                vec![json!({ "id": "b0", "markdown": cut })],
                cut.len() < text.len(),
            )
        }
    };
    let mut result = json!({
        "attachmentId": record.attachment_id,
        "title": record.title(&source.text),
        "format": record.format,
        "revision": source.revision,
        "blocks": blocks,
    });
    if truncated {
        result["truncated"] = json!(true);
    }
    if args.include_comments {
        let comments = load_comments(pool, &record.attachment_id).await?;
        result["threads"] = json!(open_threads(&comments));
    }
    Ok(result)
}

/// `text` cut to at most `max` bytes on a character boundary.
pub(crate) fn truncate_at_boundary(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The readable text of an HTML document: tags, scripts, and styles removed,
/// common entities decoded, block boundaries kept as line breaks.
pub(crate) fn html_text(source: &str) -> String {
    let lower = source.to_ascii_lowercase();
    let mut out = String::with_capacity(source.len() / 2);
    let mut index = 0;
    while index < source.len() {
        let Some(offset) = source[index..].find('<') else {
            out.push_str(&source[index..]);
            break;
        };
        out.push_str(&source[index..index + offset]);
        let tag_start = index + offset;
        let rest = &lower[tag_start..];
        let skipped = [
            ("<script", "</script"),
            ("<style", "</style"),
            ("<!--", "-->"),
        ]
        .iter()
        .find(|(open, _)| rest.starts_with(open))
        .map(|(_, close)| match rest.find(close) {
            Some(close_at) => tag_start + close_at,
            None => source.len(),
        });
        let search_from = skipped.unwrap_or(tag_start);
        let Some(close) = source[search_from..].find('>') else {
            break;
        };
        let name: String = rest[1..]
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        if matches!(
            name.as_str(),
            "p" | "div"
                | "br"
                | "li"
                | "tr"
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6"
                | "section"
                | "article"
                | "blockquote"
                | "pre"
                | "table"
                | "ul"
                | "ol"
        ) {
            out.push('\n');
        }
        index = search_from + close + 1;
    }
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    let lines: Vec<String> = decoded
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect();
    lines.join("\n")
}
