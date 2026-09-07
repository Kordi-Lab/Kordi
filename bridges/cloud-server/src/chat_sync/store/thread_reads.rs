use super::support::*;
use super::*;
use crate::chat_sync::models::{AdvanceThreadReadRequest, ThreadReadSnapshot};

pub async fn thread_reads(
    pool: &PgPool,
    account: &str,
    conversation: Uuid,
) -> Result<Vec<ThreadReadSnapshot>, StoreError> {
    let mut tx = pool.begin().await?;
    require_active_member(&mut tx, conversation, account).await?;
    let rows: Vec<(Uuid, Uuid, i64)> = query_as(
        "SELECT r.root_message_id,m.client_message_id,r.last_read_sequence FROM cloud_chat_thread_read_cursors r \
         JOIN cloud_chat_messages m ON m.message_id=r.root_message_id \
         WHERE r.conversation_id=$1 AND r.account_id=$2 AND m.deleted_at IS NULL ORDER BY r.root_message_id"
    ).bind(conversation).bind(account).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    Ok(rows
        .into_iter()
        .map(
            |(root_message_id, root_client_message_id, last_read_sequence)| ThreadReadSnapshot {
                root_message_id,
                root_client_message_id,
                last_read_sequence,
            },
        )
        .collect())
}

pub async fn advance_thread_read(
    pool: &PgPool,
    account: &str,
    conversation: Uuid,
    request: AdvanceThreadReadRequest,
) -> Result<ThreadReadSnapshot, StoreError> {
    if request.sequence < 0 {
        return Err(StoreError::InvalidInput(
            "thread read sequence must be nonnegative",
        ));
    }
    let mut tx = pool.begin().await?;
    require_active_member(&mut tx, conversation, account).await?;
    let root: Option<(Uuid, Uuid, i64)> = query_as(
        "SELECT m.message_id,m.client_message_id,c.latest_message_sequence FROM cloud_chat_messages m \
         JOIN cloud_chat_conversations c ON c.conversation_id=m.conversation_id \
         WHERE m.conversation_id=$1 AND m.deleted_at IS NULL AND (m.message_id=$2 OR m.client_message_id=$2) \
         ORDER BY (m.message_id=$2) DESC LIMIT 1"
    ).bind(conversation).bind(request.root_message_id).fetch_optional(&mut *tx).await?;
    let (root_message_id, root_client_message_id, latest) = root.ok_or(StoreError::NotFound)?;
    if request.sequence > latest {
        return Err(StoreError::InvalidInput(
            "thread read sequence is ahead of the conversation",
        ));
    }
    let (last_read_sequence,): (i64,) = query_as(
        "INSERT INTO cloud_chat_thread_read_cursors(conversation_id,account_id,root_message_id,last_read_sequence) VALUES($1,$2,$3,$4) \
         ON CONFLICT(conversation_id,account_id,root_message_id) DO UPDATE \
         SET last_read_sequence=GREATEST(cloud_chat_thread_read_cursors.last_read_sequence,EXCLUDED.last_read_sequence) \
         RETURNING last_read_sequence"
    ).bind(conversation).bind(account).bind(root_message_id).bind(request.sequence).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(ThreadReadSnapshot {
        root_message_id,
        root_client_message_id,
        last_read_sequence,
    })
}
