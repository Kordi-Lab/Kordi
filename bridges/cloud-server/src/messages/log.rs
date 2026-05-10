//! `server_messages` + `server_message_recipients` write layer (Postgres).
//!
//! One immutable row per send in `server_messages`, plus one row per
//! recipient with delivery + read cursors in `server_message_recipients`.
//! Broadcast fanout writes 1 message + N tiny recipient rows instead of
//! N full-copy mailbox rows.

use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsertMessage<'a> {
    pub sender_node_id: &'a str,
    pub project_id: Option<&'a str>,
    pub payload_blob: Option<&'a str>,
    pub client_message_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsertRecipient<'a> {
    pub recipient_node_id: &'a str,
    pub ciphertext_blob: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InsertOutcome {
    Inserted {
        message_id: String,
        recipients_inserted: usize,
    },
    Duplicate {
        message_id: String,
    },
}

/// Insert one message and all its recipient rows in a single transaction.
/// Idempotent on `(sender_node_id, client_message_id)` — repeating the same
/// pair returns the original message id without writing new recipient rows.
pub async fn insert_message_with_recipients(
    pool: &PgPool,
    message: &InsertMessage<'_>,
    recipients: &[InsertRecipient<'_>],
) -> Result<InsertOutcome, sqlx_core::Error> {
    if let Some(client_id) = message.client_message_id {
        if let Some(existing) =
            lookup_message_by_client_id(pool, message.sender_node_id, client_id).await?
        {
            return Ok(InsertOutcome::Duplicate {
                message_id: existing,
            });
        }
    }

    let mut tx = pool.begin().await?;
    let message_id = format!("msg_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();

    query(
        "INSERT INTO server_messages \
         (message_id, sender_node_id, project_id, payload_blob, client_message_id, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&message_id)
    .bind(message.sender_node_id)
    .bind(message.project_id)
    .bind(message.payload_blob)
    .bind(message.client_message_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let mut inserted = 0usize;
    for recipient in recipients {
        let result = query(
            "INSERT INTO server_message_recipients \
             (message_id, recipient_node_id, ciphertext_blob) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (message_id, recipient_node_id) DO NOTHING",
        )
        .bind(&message_id)
        .bind(recipient.recipient_node_id)
        .bind(recipient.ciphertext_blob)
        .execute(&mut *tx)
        .await?;
        inserted += result.rows_affected() as usize;
    }
    tx.commit().await?;

    Ok(InsertOutcome::Inserted {
        message_id,
        recipients_inserted: inserted,
    })
}

/// Find an existing message by `(sender_node_id, client_message_id)`.
pub async fn lookup_message_by_client_id(
    pool: &PgPool,
    sender_node_id: &str,
    client_message_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(
        "SELECT message_id FROM server_messages \
         WHERE sender_node_id = $1 AND client_message_id = $2",
    )
    .bind(sender_node_id)
    .bind(client_message_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(message_id,)| message_id))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipientDelivery {
    pub message_id: String,
    pub recipient_node_id: String,
    pub delivered_at: Option<DateTime<Utc>>,
    pub read_at: Option<DateTime<Utc>>,
}

/// Mark a recipient row as delivered. Idempotent: a second call is a no-op
/// rather than rewriting the timestamp, so the original delivery time is
/// preserved.
pub async fn mark_delivered(
    pool: &PgPool,
    message_id: &str,
    recipient_node_id: &str,
) -> Result<(), sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    query(
        "UPDATE server_message_recipients \
         SET delivered_at = COALESCE(delivered_at, $1) \
         WHERE message_id = $2 AND recipient_node_id = $3",
    )
    .bind(&now)
    .bind(message_id)
    .bind(recipient_node_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark a recipient row as read. Idempotent for the same reason.
pub async fn mark_read(
    pool: &PgPool,
    message_id: &str,
    recipient_node_id: &str,
) -> Result<(), sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    query(
        "UPDATE server_message_recipients \
         SET read_at = COALESCE(read_at, $1) \
         WHERE message_id = $2 AND recipient_node_id = $3",
    )
    .bind(&now)
    .bind(message_id)
    .bind(recipient_node_id)
    .execute(pool)
    .await?;
    Ok(())
}
