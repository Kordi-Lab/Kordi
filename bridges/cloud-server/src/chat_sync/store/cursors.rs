use super::support::*;
use super::*;

#[derive(Clone, Copy)]
enum CursorKind {
    Delivered,
    Read,
}

impl CursorKind {
    fn operation_kind(self) -> &'static str {
        match self {
            Self::Delivered => "conversation.delivery.advance",
            Self::Read => "conversation.read.advance",
        }
    }

    fn event_type(self) -> &'static str {
        match self {
            Self::Delivered => "delivery_cursor.updated",
            Self::Read => "read_cursor.updated",
        }
    }
}

async fn advance_conversation_cursor(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: AdvanceConversationCursorRequest,
    kind: CursorKind,
) -> Result<ConversationCursorSnapshot, StoreError> {
    if request.sequence < 0 {
        return Err(StoreError::InvalidInput(
            "cursor sequence cannot be negative",
        ));
    }
    let request_fingerprint = fingerprint(&CursorIntent {
        conversation_id,
        sequence: request.sequence,
    })?;
    let mut transaction = pool.begin().await?;
    advisory_operation_lock(&mut transaction, account_id, request.client_operation_id).await?;
    if let Some(existing) = existing_operation::<ConversationCursorSnapshot>(
        &mut transaction,
        account_id,
        request.client_operation_id,
        kind.operation_kind(),
        &request_fingerprint,
    )
    .await?
    {
        transaction.commit().await?;
        return Ok(existing);
    }

    let latest: Option<(i64,)> = query_as(
        "SELECT latest_message_sequence FROM cloud_chat_conversations \
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let latest = latest.ok_or(StoreError::NotFound)?.0;
    if request.sequence > latest {
        return Err(StoreError::InvalidInput(
            "cursor sequence is beyond the conversation head",
        ));
    }
    let current: Option<(i64, i64)> = query_as(
        "SELECT last_delivered_sequence, last_read_sequence \
         FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active' \
         FOR UPDATE",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((current_delivered, current_read)) = current else {
        return Err(StoreError::Forbidden);
    };
    let (delivered, read) = match kind {
        CursorKind::Delivered => (current_delivered.max(request.sequence), current_read),
        CursorKind::Read => (
            current_delivered.max(request.sequence),
            current_read.max(request.sequence),
        ),
    };
    let changed = delivered != current_delivered || read != current_read;
    if changed {
        query(
            "UPDATE cloud_chat_conversation_members \
             SET last_delivered_sequence = $1, last_read_sequence = $2 \
             WHERE conversation_id = $3 AND account_id = $4",
        )
        .bind(delivered)
        .bind(read)
        .bind(conversation_id)
        .bind(account_id)
        .execute(&mut *transaction)
        .await?;
    }
    let cursor = ConversationCursorSnapshot {
        conversation_id,
        account_id: account_id.to_string(),
        last_delivered_sequence: delivered,
        last_read_sequence: read,
    };
    record_operation(
        &mut transaction,
        account_id,
        request.client_operation_id,
        kind.operation_kind(),
        &request_fingerprint,
        &cursor,
    )
    .await?;
    if changed {
        let payload = json!({ "cursor": &cursor });
        for member in active_member_ids(&mut transaction, conversation_id).await? {
            insert_sync_event(
                &mut transaction,
                &member,
                kind.event_type(),
                Some(conversation_id),
                Some(conversation_id),
                None,
                &payload,
            )
            .await?;
        }
        wake_dispatcher(&mut transaction).await?;
    }
    transaction.commit().await?;
    Ok(cursor)
}

pub async fn advance_delivery_cursor(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: AdvanceConversationCursorRequest,
) -> Result<ConversationCursorSnapshot, StoreError> {
    advance_conversation_cursor(
        pool,
        account_id,
        conversation_id,
        request,
        CursorKind::Delivered,
    )
    .await
}

pub async fn advance_read_cursor(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: AdvanceConversationCursorRequest,
) -> Result<ConversationCursorSnapshot, StoreError> {
    advance_conversation_cursor(pool, account_id, conversation_id, request, CursorKind::Read).await
}

pub async fn history(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    before_sequence: Option<i64>,
    limit: Option<i64>,
) -> Result<HistoryResponse, StoreError> {
    let limit = limit
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .clamp(1, MAX_HISTORY_LIMIT);
    let before = before_sequence.unwrap_or(i64::MAX);
    if before <= 0 {
        return Err(StoreError::InvalidInput("before_sequence must be positive"));
    }
    let mut transaction = pool.begin().await?;
    query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *transaction)
        .await?;
    require_active_member(&mut transaction, conversation_id, account_id).await?;
    let rows: Vec<MessageRow> = query_as(
        "SELECT message_id, client_message_id, conversation_id, conversation_sequence, \
                sender_account_id, message_kind, content, reply_to_message_id, version, \
                generation_status, provider_response_id, created_at, edited_at, deleted_at \
         FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND conversation_sequence < $2 \
         ORDER BY conversation_sequence DESC \
         LIMIT $3",
    )
    .bind(conversation_id)
    .bind(before)
    .bind(limit + 1)
    .fetch_all(&mut *transaction)
    .await?;
    let has_more = rows.len() as i64 > limit;
    let mut messages = Vec::with_capacity(rows.len().min(limit as usize));
    for row in rows.into_iter().take(limit as usize) {
        let attachments = attachment_ids(&mut transaction, row.0).await?;
        messages.push(message_from_row(row, attachments));
    }
    let next_before_sequence = if has_more {
        messages.last().map(|message| message.conversation_sequence)
    } else {
        None
    };
    transaction.commit().await?;
    Ok(HistoryResponse {
        messages,
        next_before_sequence,
        has_more,
    })
}

pub async fn sync_batch(
    pool: &PgPool,
    account_id: &str,
    after_stream_seq: i64,
    limit: Option<i64>,
) -> Result<SyncBatch, StoreError> {
    let limit = limit.unwrap_or(DEFAULT_SYNC_LIMIT).clamp(1, MAX_SYNC_LIMIT);
    let head: Option<(i64, i64)> =
        query_as("SELECT last_seq, min_seq FROM cloud_chat_user_sync_heads WHERE account_id = $1")
            .bind(account_id)
            .fetch_optional(pool)
            .await?;
    let (last_seq, min_seq) = head.unwrap_or((0, 0));
    if after_stream_seq < min_seq {
        return Err(StoreError::CursorExpired);
    }
    if after_stream_seq > last_seq {
        return Err(StoreError::CursorAhead);
    }
    let rows: Vec<SyncEventRow> = query_as(
        "SELECT stream_seq, event_id, protocol_version, event_type, critical, conversation_id, \
                entity_id, entity_version, occurred_at, payload \
         FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND stream_seq > $2 \
         ORDER BY stream_seq ASC \
         LIMIT $3",
    )
    .bind(account_id)
    .bind(after_stream_seq)
    .bind(limit + 1)
    .fetch_all(pool)
    .await?;

    let mut events = Vec::new();
    let mut encoded_bytes = 0usize;
    let mut expected = after_stream_seq + 1;
    let mut has_more = rows.len() as i64 > limit;
    for row in rows.into_iter().take(limit as usize) {
        if row.0 != expected {
            return Err(StoreError::InvariantViolation(
                "per-user sync stream contains a sequence gap",
            ));
        }
        let event = SyncEventSnapshot {
            stream_seq: row.0,
            event_id: row.1,
            protocol_version: row.2,
            event_type: row.3,
            critical: row.4,
            conversation_id: row.5,
            entity_id: row.6,
            entity_version: row.7,
            occurred_at: row.8,
            payload: row.9,
        };
        let event_bytes = serde_json::to_vec(&event)
            .map_err(|_| StoreError::InvariantViolation("sync event serialization failed"))?
            .len();
        if !events.is_empty() && encoded_bytes + event_bytes > MAX_SYNC_BATCH_BYTES {
            has_more = true;
            break;
        }
        encoded_bytes += event_bytes;
        expected += 1;
        events.push(event);
    }
    let next_stream_seq = events
        .last()
        .map(|event| event.stream_seq)
        .unwrap_or(after_stream_seq);
    Ok(SyncBatch {
        events,
        next_stream_seq,
        has_more,
    })
}

pub async fn bootstrap(pool: &PgPool, account_id: &str) -> Result<BootstrapSnapshot, StoreError> {
    let mut transaction = pool.begin().await?;
    query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *transaction)
        .await?;
    let head: Option<(i64,)> =
        query_as("SELECT last_seq FROM cloud_chat_user_sync_heads WHERE account_id = $1")
            .bind(account_id)
            .fetch_optional(&mut *transaction)
            .await?;
    let stream_seq = head.map(|row| row.0).unwrap_or(0);
    let conversation_rows: Vec<(Uuid,)> = query_as(
        "SELECT conversation_id FROM cloud_chat_conversation_members \
         WHERE account_id = $1 AND membership_state = 'active' \
         ORDER BY conversation_id ASC",
    )
    .bind(account_id)
    .fetch_all(&mut *transaction)
    .await?;
    let mut conversations = Vec::with_capacity(conversation_rows.len());
    let mut latest_messages = Vec::new();
    for (conversation_id,) in conversation_rows {
        let conversation = load_conversation(&mut transaction, conversation_id, account_id).await?;
        if conversation.latest_message_sequence > 0 {
            let latest: Option<(Uuid,)> = query_as(
                "SELECT message_id FROM cloud_chat_messages \
                 WHERE conversation_id = $1 AND conversation_sequence = $2",
            )
            .bind(conversation_id)
            .bind(conversation.latest_message_sequence)
            .fetch_optional(&mut *transaction)
            .await?;
            if let Some((message_id,)) = latest {
                latest_messages.push(load_message(&mut transaction, message_id).await?);
            }
        }
        conversations.push(conversation);
    }
    let server_time = Utc::now();
    transaction.commit().await?;
    Ok(BootstrapSnapshot {
        conversations,
        latest_messages,
        stream_seq,
        server_time,
    })
}
