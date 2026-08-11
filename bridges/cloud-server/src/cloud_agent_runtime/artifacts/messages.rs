use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::store;
use crate::cloud_agent_runtime::sync_events::{
    append_cloud_agent_response_sync_event, CloudAgentResponseSyncEvent,
};

pub async fn ensure_response_message(
    pool: &PgPool,
    run_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
    session_id: &str,
    body: &str,
) -> Result<String, sqlx_core::Error> {
    if let Some((message_id,)) = query_as::<_, (String,)>(
        "SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1 AND response_message_id IS NOT NULL",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?
    {
        if canonical_response_message_exists(pool, &message_id).await? {
            return Ok(message_id);
        }
    }
    let message_id = append_cloud_agent_response_sync_event(
        pool,
        CloudAgentResponseSyncEvent {
            message_id: run_id,
            from_account_id: owner_account_id,
            to_account_id: requester_account_id,
            body,
            session_id,
        },
    )
    .await?
    .ok_or(sqlx_core::Error::RowNotFound)?;
    let now = Utc::now().to_rfc3339();
    query("UPDATE cloud_agent_fallback_runs SET response_message_id = $2, updated_at = $3 WHERE run_id = $1")
        .bind(run_id)
        .bind(&message_id)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(message_id)
}

async fn canonical_response_message_exists(
    pool: &PgPool,
    stored_message_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let Ok(message_id) = Uuid::parse_str(stored_message_id.trim()) else {
        return Ok(false);
    };
    let exists: Option<(Uuid,)> =
        query_as("SELECT message_id FROM cloud_chat_messages WHERE message_id = $1")
            .bind(message_id)
            .fetch_optional(pool)
            .await?;
    Ok(exists.is_some())
}

pub async fn update_response_message_body(
    pool: &PgPool,
    message_id: &str,
    body: &str,
) -> Result<(), sqlx_core::Error> {
    let message_id = Uuid::parse_str(message_id.trim())
        .map_err(|_| sqlx_core::Error::Protocol("invalid canonical response message id".into()))?;
    let row: Option<(String, Value)> = query_as(
        "SELECT sender_account_id, content FROM cloud_chat_messages WHERE message_id = $1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    let Some((sender_account_id, mut content)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let attachment_ids = query_as::<_, (String,)>(
        "SELECT attachment_id FROM cloud_chat_message_attachments \
         WHERE message_id = $1 ORDER BY position ASC",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(attachment_id,)| attachment_id)
    .collect();
    let object = content
        .as_object_mut()
        .ok_or_else(|| sqlx_core::Error::Protocol("canonical message content is invalid".into()))?;
    object.insert("schema".to_string(), json!(1));
    object.insert(
        "blocks".to_string(),
        json!([{ "type": "text", "text": body }]),
    );
    store::replace_message_snapshot(
        pool,
        &sender_account_id,
        message_id,
        content,
        attachment_ids,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    Ok(())
}

pub(super) async fn attach_response_artifact(
    pool: &PgPool,
    message_id: &str,
    attachment_id: &str,
    name: &str,
    content_type: &str,
    size_bytes: i64,
) -> Result<(), sqlx_core::Error> {
    let message_id = Uuid::parse_str(message_id.trim())
        .map_err(|_| sqlx_core::Error::Protocol("invalid canonical response message id".into()))?;
    let row: Option<(String, Value)> = query_as(
        "SELECT sender_account_id, content FROM cloud_chat_messages WHERE message_id = $1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await?;
    let Some((sender_account_id, mut content)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let mut attachment_ids = query_as::<_, (String,)>(
        "SELECT attachment_id FROM cloud_chat_message_attachments \
         WHERE message_id = $1 ORDER BY position ASC",
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(value,)| value)
    .collect::<Vec<_>>();
    if !attachment_ids.iter().any(|value| value == attachment_id) {
        attachment_ids.push(attachment_id.to_string());
    }
    let object = content
        .as_object_mut()
        .ok_or_else(|| sqlx_core::Error::Protocol("canonical message content is invalid".into()))?;
    let attachments = object
        .entry("legacy_attachments".to_string())
        .or_insert_with(|| json!([]));
    let array = attachments.as_array_mut().ok_or_else(|| {
        sqlx_core::Error::Protocol("canonical attachment content is invalid".into())
    })?;
    if !array
        .iter()
        .any(|value| value.get("attachmentId").and_then(Value::as_str) == Some(attachment_id))
    {
        array.push(json!({
            "attachmentId": attachment_id,
            "name": name,
            "kind": "file",
            "mimeType": content_type,
            "sizeBytes": size_bytes,
            "previewUrl": null
        }));
    }
    store::replace_message_snapshot(
        pool,
        &sender_account_id,
        message_id,
        content,
        attachment_ids,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    Ok(())
}
