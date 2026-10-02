//! Session activity cleanup for content removal.
//!
//! When a message is deleted for everyone, a task summary recorded from it is
//! cleared and files-panel entries created from it are archived. When a
//! file's bytes are deleted, files-panel entries that point at it are
//! archived. Each change is published to the conversation's active members.
//!
//! An entry archived here is also marked `removed_at`, so a client that
//! publishes it again can neither restore nor change it.

use uuid::Uuid;

use super::*;

const TASK_COLUMNS: &str = "task_activity_id, session_id, task_id, title, summary, status, \
     created_by_account_id, target_account_id, participants_json, artifact_ids_json, \
     response_message_id, created_at, updated_at, archived_at";
const ARTIFACT_COLUMNS: &str = "artifact_activity_id, session_id, artifact_id, name, path, kind, \
     category, summary, created_by_account_id, source_message_id, attachment_id, content_type, \
     size_bytes, created_at, updated_at, archived_at";

async fn active_members(
    pool: &PgPool,
    conversation_id: Uuid,
) -> Result<Vec<String>, crate::chat_sync::store::StoreError> {
    let rows: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND membership_state = 'active' ORDER BY account_id",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(account_id,)| account_id).collect())
}

async fn publish(
    pool: &PgPool,
    conversation_id: Uuid,
    event_type: &str,
    payloads: Vec<serde_json::Value>,
) -> Result<(), crate::chat_sync::store::StoreError> {
    if payloads.is_empty() {
        return Ok(());
    }
    let members = active_members(pool, conversation_id).await?;
    for payload in payloads {
        crate::chat_sync::store::publish_user_sync_events(
            pool,
            &members,
            event_type,
            Some(conversation_id),
            payload,
        )
        .await?;
    }
    Ok(())
}

/// Clears the summary of every task in the conversation whose response was
/// one of `message_ids`, and publishes the cleared task. Returns the number of
/// tasks cleared.
pub(crate) async fn clear_task_summaries_for_message(
    pool: &PgPool,
    conversation_id: Uuid,
    sessions: &[String],
    message_ids: &[String],
) -> Result<u64, crate::chat_sync::store::StoreError> {
    if sessions.is_empty() || message_ids.is_empty() {
        return Ok(0);
    }
    let rows: Vec<TaskRow> = query_as(&format!(
        "UPDATE cloud_session_tasks SET summary = NULL, updated_at = $3 \
         WHERE session_id = ANY($1) \
           AND regexp_replace(response_message_id, '^collaboration-message:', '') = ANY($2) \
           AND summary IS NOT NULL AND archived_at IS NULL \
         RETURNING {TASK_COLUMNS}"
    ))
    .bind(sessions)
    .bind(message_ids)
    .bind(Utc::now().to_rfc3339())
    .fetch_all(pool)
    .await?;
    let cleared = rows.len() as u64;
    let payloads = rows
        .into_iter()
        .map(task_summary_from_row)
        .map(|task| task_activity_sync_payload(&task))
        .collect();
    publish(pool, conversation_id, "task.upsert", payloads).await?;
    Ok(cleared)
}

/// Archives files-panel entries in the conversation created from one of
/// `message_ids`, and publishes each archived entry. Returns the number of
/// entries archived.
pub(crate) async fn archive_artifacts_for_message(
    pool: &PgPool,
    conversation_id: Uuid,
    sessions: &[String],
    message_ids: &[String],
) -> Result<u64, crate::chat_sync::store::StoreError> {
    if sessions.is_empty() || message_ids.is_empty() {
        return Ok(0);
    }
    let rows: Vec<ArtifactRow> = query_as(&format!(
        "UPDATE cloud_session_artifacts \
         SET archived_at = COALESCE(archived_at, $3), updated_at = $3, removed_at = now() \
         WHERE session_id = ANY($1) \
           AND regexp_replace(source_message_id, '^collaboration-message:', '') = ANY($2) \
           AND removed_at IS NULL \
         RETURNING {ARTIFACT_COLUMNS}"
    ))
    .bind(sessions)
    .bind(message_ids)
    .bind(Utc::now().to_rfc3339())
    .fetch_all(pool)
    .await?;
    let archived = rows.len() as u64;
    let payloads = rows
        .into_iter()
        .map(artifact_summary_from_row)
        .map(|artifact| artifact_activity_sync_payload(&artifact))
        .collect();
    publish(pool, conversation_id, "artifact.archived", payloads).await?;
    Ok(archived)
}

/// Archives every files-panel entry that points at the attachment, and
/// publishes each one to the active members of its conversation. Entries in
/// a session with no conversation are archived without a publication.
/// Returns the number of entries archived.
pub(crate) async fn archive_artifacts_for_attachment(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<u64, crate::chat_sync::store::StoreError> {
    let rows: Vec<ArtifactRow> = query_as(&format!(
        "UPDATE cloud_session_artifacts \
         SET archived_at = COALESCE(archived_at, $2), updated_at = $2, removed_at = now() \
         WHERE attachment_id = $1 AND removed_at IS NULL \
         RETURNING {ARTIFACT_COLUMNS}"
    ))
    .bind(attachment_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_all(pool)
    .await?;
    let archived = rows.len() as u64;
    for artifact in rows.into_iter().map(artifact_summary_from_row) {
        let conversation: Option<(Uuid,)> = query_as(
            "SELECT conversation_id FROM cloud_chat_conversations \
             WHERE legacy_session_id = $1 OR conversation_id = $2 \
             ORDER BY conversation_id LIMIT 1",
        )
        .bind(&artifact.session_id)
        .bind(Uuid::parse_str(artifact.session_id.trim()).ok())
        .fetch_optional(pool)
        .await?;
        if let Some((conversation_id,)) = conversation {
            publish(
                pool,
                conversation_id,
                "artifact.archived",
                vec![artifact_activity_sync_payload(&artifact)],
            )
            .await?;
        }
    }
    Ok(archived)
}
