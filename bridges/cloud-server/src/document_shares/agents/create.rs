//! `create_document`: a document an agent writes for a group, saved as that
//! group's Markdown or HTML attachment (issue 1808).
//!
//! The document is uploaded under the agent's owner, like every agent
//! artifact, and posted in the group as the agent's own message, so it shows
//! in the group's Artifacts for every member and opens, shares, and edits
//! with the ordinary document rules. Posting it right away, rather than
//! waiting for the run's reply, gives every runtime one path: the cloud
//! runner, the owner's Mac, and a background task on the Mac whose run has
//! already answered.
//!
//! Retrying the same call is harmless: the attachment and message ids are
//! derived from the run, the file name, and the content.

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::gating::RunFacts;
use super::tools::ToolError;
use super::MAX_TOOL_TEXT_BYTES;
use crate::connectors::delivery::{tools_from_json, LeaseConnectorTool, LeaseHolder};
use crate::server::ServerState;

mod group_message;

/// Longest title, in characters, like a document rename.
pub(crate) const MAX_TITLE_CHARS: usize = 200;
/// Most documents one run may create.
pub(crate) const MAX_DOCUMENTS_PER_RUN: i64 = 10;
/// How long after its run answered a background task of that run may still
/// deliver a document from the owner's Mac.
pub(crate) const FINISHED_RUN_WINDOW_HOURS: i32 = 12;
/// Longest file name stem derived from a title.
const MAX_FILE_STEM_CHARS: usize = 120;

pub(crate) fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "description": "The document title, also used for its file name."
            },
            "content": {
                "type": "string",
                "description": "The full document: Markdown, or a complete HTML page when format is html."
            },
            "format": {
                "type": "string",
                "enum": ["markdown", "html"],
                "description": "markdown (the default) or html."
            }
        },
        "required": ["title", "content"]
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArguments {
    title: String,
    content: String,
    #[serde(default)]
    format: Option<String>,
}

/// A validated document ready to store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewDocument {
    pub title: String,
    pub file_name: String,
    pub content_type: &'static str,
    pub content: String,
}

impl NewDocument {
    pub(crate) fn format(&self) -> &'static str {
        if self.content_type == "text/html" {
            "html"
        } else {
            "markdown"
        }
    }
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A file name for `title`: no path separators or characters file systems
/// refuse, at most [`MAX_FILE_STEM_CHARS`] before the extension.
pub(crate) fn file_name_for(title: &str, extension: &str) -> String {
    let lowered = title.to_ascii_lowercase();
    let stem = [".markdown", ".md", ".html", ".htm"]
        .iter()
        .find_map(|known| {
            lowered
                .ends_with(known)
                .then(|| &title[..title.len() - known.len()])
        })
        .unwrap_or(title);
    let cleaned: String = stem
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                ' '
            } else {
                ch
            }
        })
        .collect();
    let stem: String = collapse_whitespace(&cleaned)
        .trim_matches(['.', ' '])
        .chars()
        .take(MAX_FILE_STEM_CHARS)
        .collect();
    let stem = stem.trim_end_matches(['.', ' ']);
    format!(
        "{}.{extension}",
        if stem.is_empty() { "Document" } else { stem }
    )
}

/// Checks the arguments of one call.
pub(crate) fn parse(args: &Value) -> Result<NewDocument, ToolError> {
    let input: CreateArguments = serde_json::from_value(args.clone()).map_err(|_| {
        ToolError::Invalid("create_document needs a title and the document content.".into())
    })?;
    let title = collapse_whitespace(&input.title);
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(ToolError::Invalid(format!(
            "The title must be 1 to {MAX_TITLE_CHARS} characters."
        )));
    }
    let (content_type, extension) = match input.format.as_deref().map(str::trim) {
        None | Some("") | Some("markdown") | Some("md") => ("text/markdown", "md"),
        Some("html") => ("text/html", "html"),
        Some(_) => {
            return Err(ToolError::Invalid(
                "format must be markdown or html. Attach other formats as ordinary files.".into(),
            ))
        }
    };
    if input.content.trim().is_empty() {
        return Err(ToolError::Invalid("The document content is empty.".into()));
    }
    if input.content.len() > MAX_TOOL_TEXT_BYTES {
        return Err(ToolError::Invalid(format!(
            "The document is larger than {MAX_TOOL_TEXT_BYTES} bytes. Split it into parts."
        )));
    }
    Ok(NewDocument {
        file_name: file_name_for(&title, extension),
        title,
        content_type,
        content: input.content,
    })
}

/// Whether `session_id` names a group conversation.
pub(crate) async fn is_group_session(
    pool: &PgPool,
    session_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let (group,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_conversations \
         WHERE legacy_session_id = $1 AND kind = 'group')",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;
    Ok(group)
}

/// The tools of a desktop run that already answered, for the Mac that held
/// its claim, within [`FINISHED_RUN_WINDOW_HOURS`] of the answer. A
/// background task the run started keeps the run's claim, so its document
/// still reaches the run's group.
pub(crate) async fn finished_desktop_lease_tools(
    pool: &PgPool,
    run_id: &str,
    holder: &LeaseHolder,
) -> Result<Option<Vec<LeaseConnectorTool>>, sqlx_core::Error> {
    let LeaseHolder::Desktop {
        account_id,
        executor,
    } = holder
    else {
        return Ok(None);
    };
    let row: Option<(Value,)> = query_as(
        "SELECT connector_tools_json FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND execution_backend = 'desktop' AND claimed_by = $2 \
           AND owner_account_id = $3 AND status = 'completed' AND completed_at IS NOT NULL \
           AND completed_at::timestamptz > now() - make_interval(hours => $4)",
    )
    .bind(run_id)
    .bind(executor)
    .bind(account_id)
    .bind(FINISHED_RUN_WINDOW_HOURS)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(tools,)| tools_from_json(tools)))
}

/// Ids derived from what the call creates, so a retry finds its first result.
fn derived_ids(run_id: &str, document: &NewDocument) -> (String, Uuid) {
    let digest = Sha256::digest(format!(
        "kordi-agent-document\0{run_id}\0{}\0{}",
        document.file_name, document.content
    ));
    let hex = format!("{digest:x}");
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[16..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    (
        format!("att_agentdoc_{}", &hex[..32]),
        Uuid::from_bytes(bytes),
    )
}

/// `cloud_session_artifacts.artifact_id` prefix of the documents of a run.
fn artifact_prefix(run_id: &str) -> String {
    format!("agentdoc:{run_id}:")
}

async fn active_member(
    pool: &PgPool,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let (member,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active')",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    Ok(member)
}

/// Stores the document and posts it in the run's group.
pub(crate) async fn execute(
    state: &ServerState,
    run_id: &str,
    facts: &RunFacts,
    args: &Value,
) -> Result<Value, ToolError> {
    let document = parse(args)?;
    let pool = state.db_pool();
    let conversation: Option<(Uuid,)> = query_as(
        "SELECT conversation_id FROM cloud_chat_conversations \
         WHERE legacy_session_id = $1 AND kind = 'group'",
    )
    .bind(&facts.session_id)
    .fetch_optional(pool)
    .await?;
    let Some((conversation_id,)) = conversation else {
        return Err(ToolError::Forbidden(
            "create_document works only in a group conversation.",
        ));
    };
    for account in [&facts.owner_account_id, &facts.requester_account_id] {
        if !active_member(pool, conversation_id, account).await? {
            return Err(ToolError::Forbidden(
                "Only members of this group can receive its documents.",
            ));
        }
    }
    let (attachment_id, client_message_id) = derived_ids(run_id, &document);
    let artifact_id = format!("{}{attachment_id}", artifact_prefix(run_id));
    let (created,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_session_artifacts \
         WHERE session_id = $1 AND starts_with(artifact_id, $2) AND artifact_id <> $3",
    )
    .bind(&facts.session_id)
    .bind(artifact_prefix(run_id))
    .bind(&artifact_id)
    .fetch_one(pool)
    .await?;
    if created >= MAX_DOCUMENTS_PER_RUN {
        return Err(ToolError::Invalid(format!(
            "One request can create at most {MAX_DOCUMENTS_PER_RUN} documents."
        )));
    }
    store_attachment(state, &attachment_id, &facts.owner_account_id, &document).await?;
    let message_id = group_message::post(
        pool,
        group_message::DocumentMessage {
            conversation_id,
            client_message_id,
            session_id: &facts.session_id,
            owner_account_id: &facts.owner_account_id,
            agent_id: &facts.agent_id,
            attachment_id: &attachment_id,
            document: &document,
        },
    )
    .await?;
    group_message::record_artifact(
        pool,
        &facts.session_id,
        &artifact_id,
        &facts.owner_account_id,
        &message_id,
        &attachment_id,
        &document,
    )
    .await?;
    Ok(json!({
        "created": true,
        "attachmentId": attachment_id,
        "title": document.title,
        "fileName": document.file_name,
        "format": document.format(),
        "messageId": message_id,
        "note": "The document is in this group's Artifacts and was posted as your message. \
                 Reply briefly without file paths.",
    }))
}

/// Uploads the bytes and records the finalized attachment once.
async fn store_attachment(
    state: &ServerState,
    attachment_id: &str,
    owner_account_id: &str,
    document: &NewDocument,
) -> Result<(), ToolError> {
    let pool = state.db_pool();
    let exists: Option<(String,)> = query_as(
        "SELECT owner_account_id FROM cloud_attachments \
         WHERE attachment_id = $1 AND finalized_at IS NOT NULL",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await?;
    if let Some((owner,)) = exists {
        return if owner == owner_account_id {
            Ok(())
        } else {
            Err(ToolError::Server)
        };
    }
    let Some(s3) = state.s3() else {
        eprintln!("[documents] create_document: object storage is not configured");
        return Err(ToolError::Server);
    };
    let bytes = document.content.as_bytes().to_vec();
    let size_bytes = i64::try_from(bytes.len()).map_err(|_| ToolError::Server)?;
    let sha256_hex = format!("{:x}", Sha256::digest(&bytes));
    let object_key = format!("attachments/{owner_account_id}/{attachment_id}");
    crate::cloud_agent_runtime::artifacts::upload_object(
        s3,
        &object_key,
        document.content_type,
        bytes,
    )
    .await
    .map_err(|error| {
        eprintln!("[documents] create_document upload: {}", error.message);
        ToolError::Server
    })?;
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, size_bytes, \
         content_type, sha256_hex, created_at, finalized_at, document_title) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8) ON CONFLICT (attachment_id) DO NOTHING",
    )
    .bind(attachment_id)
    .bind(owner_account_id)
    .bind(&object_key)
    .bind(size_bytes)
    .bind(document.content_type)
    .bind(&sha256_hex)
    .bind(&now)
    .bind((document.format() == "markdown").then_some(document.title.as_str()))
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "create_tests.rs"]
mod tests;
