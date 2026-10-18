//! Stores a created document and records it against its run until a reply
//! takes it.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::super::gating::RunFacts;
use super::super::tools::ToolError;
use super::{parse, NewDocument, MAX_DOCUMENTS_PER_RUN};
use crate::server::ServerState;

/// The attachment id, derived from what the call creates, so a retry finds
/// its first result.
pub(crate) fn derived_attachment_id(run_id: &str, document: &NewDocument) -> String {
    let digest = Sha256::digest(format!(
        "kordi-agent-document\0{run_id}\0{}\0{}",
        document.file_name, document.content
    ));
    format!("att_agentdoc_{}", &format!("{digest:x}")[..32])
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

/// Checks the call, stores the document, and records it for the run's reply.
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
    let attachment_id = derived_attachment_id(run_id, &document);
    let (created,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_agent_run_documents \
         WHERE run_id = $1 AND attachment_id <> $2",
    )
    .bind(run_id)
    .bind(&attachment_id)
    .fetch_one(pool)
    .await?;
    if created >= MAX_DOCUMENTS_PER_RUN {
        return Err(ToolError::Invalid(format!(
            "One request can create at most {MAX_DOCUMENTS_PER_RUN} documents."
        )));
    }
    store_attachment(state, &attachment_id, &facts.owner_account_id, &document).await?;
    // A background task of a run that already answered waits for the
    // follow-up reply.
    query(
        "INSERT INTO cloud_agent_run_documents (attachment_id, run_id, session_id, \
         owner_account_id, agent_id, title, file_name, content_type, size_bytes, after_reply) \
         SELECT $1, run.run_id, run.session_id, run.owner_account_id, $2, $3, $4, $5, $6, \
                run.status IN ('completed', 'failed', 'cancelled') \
         FROM cloud_agent_fallback_runs run WHERE run.run_id = $7 \
         ON CONFLICT (attachment_id) DO NOTHING",
    )
    .bind(&attachment_id)
    .bind(&facts.agent_id)
    .bind(&document.title)
    .bind(&document.file_name)
    .bind(document.content_type)
    .bind(document.content.len() as i64)
    .bind(run_id)
    .execute(pool)
    .await?;
    record_artifact(pool, run_id, facts, &attachment_id, &document).await?;
    Ok(json!({
        "created": true,
        "attachmentId": attachment_id,
        "title": document.title,
        "fileName": document.file_name,
        "format": document.format(),
        "note": "Saved. It will appear as a document card in your reply and in this group's \
                 Artifacts. Do not call create_document again for this document; reply \
                 briefly with what it covers, without file paths.",
    }))
}

/// Lists the document in the session's Artifacts activity.
async fn record_artifact(
    pool: &PgPool,
    run_id: &str,
    facts: &RunFacts,
    attachment_id: &str,
    document: &NewDocument,
) -> Result<(), sqlx_core::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_session_artifacts (artifact_activity_id, session_id, artifact_id, \
         name, path, kind, category, summary, created_by_account_id, source_message_id, \
         attachment_id, content_type, size_bytes, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $4, 'document', 'artifact', $5, $6, NULL, $7, $8, $9, $10, $10) \
         ON CONFLICT (session_id, artifact_id) DO NOTHING",
    )
    .bind(format!("artifact_activity_{}", Uuid::new_v4().simple()))
    .bind(&facts.session_id)
    .bind(format!("agentdoc:{run_id}:{attachment_id}"))
    .bind(&document.file_name)
    .bind(&document.title)
    .bind(&facts.owner_account_id)
    .bind(attachment_id)
    .bind(document.content_type)
    .bind(document.content.len() as i64)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
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
