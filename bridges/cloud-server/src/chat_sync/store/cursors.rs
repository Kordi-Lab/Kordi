use super::support::*;
use super::*;
use std::collections::HashMap;

type BootstrapConversationRow = (
    Uuid,
    String,
    Option<String>,
    i32,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    DateTime<Utc>,
    DateTime<Utc>,
    Option<String>,
    i32,
);

type BootstrapMemberRow = (
    Uuid,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    i32,
    i64,
    i64,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
);

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
    let message_ids = rows
        .iter()
        .take(limit as usize)
        .map(|row| row.0)
        .collect::<Vec<_>>();
    let mut reactions = reactions_by_message(&mut transaction, &message_ids).await?;
    let mut messages = Vec::with_capacity(rows.len().min(limit as usize));
    for row in rows.into_iter().take(limit as usize) {
        let message_id = row.0;
        let attachments = attachment_ids(&mut transaction, row.0).await?;
        messages.push(message_from_row(
            row,
            attachments,
            reactions.remove(&message_id).unwrap_or_default(),
        ));
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
    let mut has_more = rows.len() as i64 > limit;
    for (expected, row) in (after_stream_seq + 1..).zip(rows.into_iter().take(limit as usize)) {
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
    let conversation_rows: Vec<BootstrapConversationRow> = query_as(
        "SELECT conversation.conversation_id, conversation.kind, \
                conversation.shared_title, conversation.version, \
                conversation.created_by_account_id, conversation.legacy_session_id, \
                fork.parent_session_id, fork.parent_message_id, \
                conversation.latest_message_sequence, conversation.created_at, \
                conversation.updated_at, viewer.personal_title, viewer.preferences_version \
         FROM cloud_chat_conversation_members viewer \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = viewer.conversation_id \
         LEFT JOIN cloud_session_forks fork \
           ON fork.fork_session_id = conversation.legacy_session_id \
         WHERE viewer.account_id = $1 AND viewer.membership_state = 'active' \
         ORDER BY conversation.conversation_id ASC",
    )
    .bind(account_id)
    .fetch_all(&mut *transaction)
    .await?;
    let conversation_ids = conversation_rows
        .iter()
        .map(|row| row.0)
        .collect::<Vec<_>>();
    let session_ids = conversation_rows
        .iter()
        .map(|row| row.5.clone().unwrap_or_else(|| row.0.to_string()))
        .collect::<Vec<_>>();
    let session_pins =
        super::pin_snapshots::bootstrap_session_pins(&mut transaction, &session_ids, account_id)
            .await?;
    let member_rows: Vec<BootstrapMemberRow> = query_as(
        "SELECT member.conversation_id, member.account_id, account.display_name, \
                account.avatar_url, member.role, member.membership_state, member.version, \
                member.last_delivered_sequence, member.last_read_sequence, \
                member.joined_at, member.left_at \
         FROM cloud_chat_conversation_members member \
         JOIN cloud_accounts account ON account.account_id = member.account_id \
         WHERE member.conversation_id = ANY($1) \
         ORDER BY member.conversation_id ASC, member.account_id ASC",
    )
    .bind(&conversation_ids)
    .fetch_all(&mut *transaction)
    .await?;
    let mut members_by_conversation = HashMap::<Uuid, Vec<MemberSnapshot>>::new();
    for row in member_rows {
        members_by_conversation
            .entry(row.0)
            .or_default()
            .push(member_from_row((
                row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8, row.9, row.10,
            )));
    }
    let conversations = conversation_rows
        .into_iter()
        .map(|row| {
            Ok(ConversationSnapshot {
                id: row.0,
                kind: parse_kind(&row.1)?,
                shared_title: row.2,
                version: row.3,
                created_by_account_id: row.4,
                legacy_session_id: row.5,
                forked_from_session_id: row.6,
                forked_from_message_id: row.7,
                latest_message_sequence: row.8,
                created_at: row.9,
                updated_at: row.10,
                members: members_by_conversation.remove(&row.0).unwrap_or_default(),
                preferences: ConversationPreferencesSnapshot {
                    conversation_id: row.0,
                    account_id: account_id.to_string(),
                    personal_title: row.11,
                    version: row.12,
                },
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()?;

    let latest_rows: Vec<MessageRow> = query_as(
        "SELECT message.message_id, message.client_message_id, message.conversation_id, \
                message.conversation_sequence, message.sender_account_id, message.message_kind, \
                message.content, message.reply_to_message_id, message.version, \
                message.generation_status, message.provider_response_id, message.created_at, \
                message.edited_at, message.deleted_at \
         FROM cloud_chat_messages message \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = message.conversation_id \
          AND conversation.latest_message_sequence = message.conversation_sequence \
         WHERE message.conversation_id = ANY($1) \
         ORDER BY message.conversation_id ASC",
    )
    .bind(&conversation_ids)
    .fetch_all(&mut *transaction)
    .await?;
    let message_ids = latest_rows.iter().map(|row| row.0).collect::<Vec<_>>();
    let attachment_rows: Vec<(Uuid, String)> = query_as(
        "SELECT message_id, attachment_id FROM cloud_chat_message_attachments \
         WHERE message_id = ANY($1) ORDER BY message_id ASC, position ASC",
    )
    .bind(&message_ids)
    .fetch_all(&mut *transaction)
    .await?;
    let mut attachments_by_message = HashMap::<Uuid, Vec<String>>::new();
    for (message_id, attachment_id) in attachment_rows {
        attachments_by_message
            .entry(message_id)
            .or_default()
            .push(attachment_id);
    }
    let mut reactions_by_message = reactions_by_message(&mut transaction, &message_ids).await?;
    let latest_messages = latest_rows
        .into_iter()
        .map(|row| {
            let message_id = row.0;
            message_from_row(
                row,
                attachments_by_message
                    .remove(&message_id)
                    .unwrap_or_default(),
                reactions_by_message.remove(&message_id).unwrap_or_default(),
            )
        })
        .collect();
    let server_time = Utc::now();
    transaction.commit().await?;
    Ok(BootstrapSnapshot {
        conversations,
        latest_messages,
        session_pins,
        stream_seq,
        server_time,
    })
}
