use chrono::{DateTime, Utc};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::calls::models::ActiveCallSnapshot;

use super::{snapshot_from_row, CallRow, CallStoreError};

type ActiveCallRow = (
    Uuid,
    Uuid,
    String,
    String,
    String,
    String,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    Option<String>,
);

pub async fn active_for_account(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<ActiveCallSnapshot>, CallStoreError> {
    let mut transaction = pool.begin().await?;
    let rows: Vec<ActiveCallRow> = query_as(
        "SELECT call.call_id, call.conversation_id, call.call_kind, call.call_state, \
                call.created_by_account_id, call.room_name, call.created_at, \
                call.answered_at, call.ended_at, conversation.legacy_session_id \
         FROM cloud_calls call \
         JOIN cloud_call_participants participant ON participant.call_id = call.call_id \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = call.conversation_id \
         WHERE call.ended_at IS NULL AND participant.account_id = $1 \
         ORDER BY call.created_at DESC",
    )
    .bind(account_id)
    .fetch_all(&mut *transaction)
    .await?;
    let mut calls = Vec::with_capacity(rows.len());
    for row in rows {
        let session_id = row.9.clone();
        let call_row: CallRow = (
            row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8,
        );
        calls.push(ActiveCallSnapshot {
            call: snapshot_from_row(&mut transaction, call_row).await?.0,
            session_id,
        });
    }
    transaction.commit().await?;
    Ok(calls)
}
