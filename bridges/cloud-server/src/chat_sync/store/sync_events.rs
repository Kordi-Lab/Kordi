use super::*;

pub(super) async fn insert_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    event_type: &str,
    conversation_id: Option<Uuid>,
    entity_id: Option<Uuid>,
    entity_version: Option<i32>,
    payload: &Value,
) -> Result<i64, StoreError> {
    insert_sync_event_with_critical(
        transaction,
        account_id,
        event_type,
        conversation_id,
        entity_id,
        entity_version,
        (payload, true),
    )
    .await
}

pub(super) async fn insert_noncritical_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    event_type: &str,
    conversation_id: Option<Uuid>,
    entity_id: Option<Uuid>,
    entity_version: Option<i32>,
    payload: &Value,
) -> Result<i64, StoreError> {
    insert_sync_event_with_critical(
        transaction,
        account_id,
        event_type,
        conversation_id,
        entity_id,
        entity_version,
        (payload, false),
    )
    .await
}

async fn insert_sync_event_with_critical(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    event_type: &str,
    conversation_id: Option<Uuid>,
    entity_id: Option<Uuid>,
    entity_version: Option<i32>,
    event: (&Value, bool),
) -> Result<i64, StoreError> {
    let (payload, critical) = event;
    query(
        "INSERT INTO cloud_chat_user_sync_heads(account_id, last_seq, min_seq) \
         VALUES ($1, 0, 0) ON CONFLICT (account_id) DO NOTHING",
    )
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    let head: (i64,) = query_as(
        "UPDATE cloud_chat_user_sync_heads \
         SET last_seq = last_seq + 1 \
         WHERE account_id = $1 \
         RETURNING last_seq",
    )
    .bind(account_id)
    .fetch_one(&mut **transaction)
    .await?;
    query(
        "WITH inserted AS ( \
           INSERT INTO cloud_chat_user_sync_events \
         (account_id, stream_seq, event_id, protocol_version, event_type, conversation_id, \
          entity_id, entity_version, critical, payload) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         RETURNING account_id \
         ) SELECT pg_notify('chat_sync_events', account_id) FROM inserted",
    )
    .bind(account_id)
    .bind(head.0)
    .bind(Uuid::now_v7())
    .bind(PROTOCOL_VERSION)
    .bind(event_type)
    .bind(conversation_id)
    .bind(entity_id)
    .bind(entity_version)
    .bind(critical)
    .bind(payload)
    .execute(&mut **transaction)
    .await?;
    Ok(head.0)
}
