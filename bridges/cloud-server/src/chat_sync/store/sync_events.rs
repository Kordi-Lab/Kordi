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

pub(super) async fn insert_sync_event_fanout(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    conversation_id: Option<Uuid>,
    entity_id: Option<Uuid>,
    entity_version: Option<i32>,
    payloads: Vec<(String, Value)>,
) -> Result<(), StoreError> {
    let payloads = payloads
        .into_iter()
        .filter(|(account_id, _)| !account_id.trim().is_empty())
        .collect::<std::collections::BTreeMap<_, _>>();
    if payloads.is_empty() {
        return Ok(());
    }
    let account_ids = payloads.keys().cloned().collect::<Vec<_>>();
    query(
        "INSERT INTO cloud_chat_user_sync_heads(account_id, last_seq, min_seq) \
         SELECT account_id, 0, 0 FROM UNNEST($1::TEXT[]) AS recipient(account_id) \
         ORDER BY account_id ASC \
         ON CONFLICT (account_id) DO NOTHING",
    )
    .bind(&account_ids)
    .execute(&mut **transaction)
    .await?;
    // Lock every recipient head in stable account order before advancing it so
    // overlapping group fanouts cannot acquire the same rows in opposite order.
    let heads: Vec<(String, i64)> = query_as(
        "WITH locked AS MATERIALIZED ( \
           SELECT account_id FROM cloud_chat_user_sync_heads \
           WHERE account_id = ANY($1::TEXT[]) \
           ORDER BY account_id ASC FOR UPDATE \
         ) \
         UPDATE cloud_chat_user_sync_heads head \
         SET last_seq = head.last_seq + 1 \
         FROM locked WHERE head.account_id = locked.account_id \
         RETURNING head.account_id, head.last_seq",
    )
    .bind(&account_ids)
    .fetch_all(&mut **transaction)
    .await?;
    if heads.len() != payloads.len() {
        return Err(StoreError::InvariantViolation(
            "sync event fanout did not advance every recipient",
        ));
    }
    let sequences = heads
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>();
    let rows = payloads
        .into_iter()
        .map(|(account_id, payload)| {
            sequences
                .get(&account_id)
                .copied()
                .map(|stream_seq| (account_id, stream_seq, payload))
                .ok_or(StoreError::InvariantViolation(
                    "sync event fanout sequence is missing",
                ))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut builder = QueryBuilder::<Postgres>::new(
        "WITH inserted AS (INSERT INTO cloud_chat_user_sync_events \
         (account_id, stream_seq, event_id, protocol_version, event_type, conversation_id, \
          entity_id, entity_version, critical, payload) ",
    );
    builder.push_values(
        rows.iter(),
        |mut values, (account_id, stream_seq, payload)| {
            values
                .push_bind(account_id)
                .push_bind(stream_seq)
                .push_bind(Uuid::now_v7())
                .push_bind(PROTOCOL_VERSION)
                .push_bind(event_type)
                .push_bind(conversation_id)
                .push_bind(entity_id)
                .push_bind(entity_version)
                .push_bind(true)
                .push_bind(payload);
        },
    );
    builder.push(
        " RETURNING account_id) \
         SELECT pg_notify('chat_sync_events', account_id) FROM inserted",
    );
    builder.build().execute(&mut **transaction).await?;
    Ok(())
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

/// Account-private refresh hint. Older clients can safely ignore this event.
pub async fn append_account_hint(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    event_type: &str,
    payload: &Value,
) -> Result<(), StoreError> {
    insert_noncritical_sync_event(
        transaction,
        account_id,
        event_type,
        None,
        None,
        None,
        payload,
    )
    .await?;
    Ok(())
}
