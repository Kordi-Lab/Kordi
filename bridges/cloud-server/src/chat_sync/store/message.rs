use super::meme_validation::{meme_attachment_metadata, validate_meme_attachment_bytes};
use super::support::*;
use super::*;

mod group_identity;
mod mutations;
use group_identity::normalize_group_envelope;
pub(super) use group_identity::normalize_stored_group_agent_identity;
pub use mutations::{delete_message, edit_message};

pub(super) async fn fanout_message_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    message: &MessageSnapshot,
) -> Result<(), StoreError> {
    let payloads = load_active_conversation_projections(transaction, message.conversation_id)
        .await?
        .into_iter()
        .map(|(account_id, conversation)| {
            (
                account_id,
                json!({ "message": message, "conversation": conversation }),
            )
        })
        .collect();
    insert_sync_event_fanout(
        transaction,
        event_type,
        Some(message.conversation_id),
        Some(message.id),
        Some(message.version),
        payloads,
    )
    .await
}

pub async fn load_message_snapshot(
    pool: &PgPool,
    message_id: Uuid,
) -> Result<MessageSnapshot, StoreError> {
    let mut transaction = pool.begin().await?;
    let message = load_message(&mut transaction, message_id).await?;
    transaction.commit().await?;
    Ok(message)
}

pub async fn send_message(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: SendMessageRequest,
) -> Result<InsertOutcome<MessageSnapshot>, StoreError> {
    let mut transaction = pool.begin().await?;
    let outcome =
        send_message_in_transaction(&mut transaction, account_id, conversation_id, request).await?;
    transaction.commit().await?;
    Ok(outcome)
}

pub(crate) async fn send_message_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    mut request: SendMessageRequest,
) -> Result<InsertOutcome<MessageSnapshot>, StoreError> {
    let message_kind = request.kind.trim();
    if message_kind.is_empty() || message_kind.chars().count() > 64 {
        return Err(StoreError::InvalidInput("message kind is invalid"));
    }
    let mut unique_attachments = BTreeSet::new();
    let mut attachment_ids = Vec::with_capacity(request.attachment_ids.len());
    for attachment_id in &request.attachment_ids {
        let attachment_id = attachment_id.trim();
        if attachment_id.is_empty() || !unique_attachments.insert(attachment_id.to_string()) {
            return Err(StoreError::InvalidInput("attachment ids are invalid"));
        }
        attachment_ids.push(attachment_id.to_string());
    }
    let group_projection =
        normalize_group_envelope(transaction, conversation_id, &mut request.content).await?;
    let meme_attachments = meme_attachment_metadata(&request.content, &attachment_ids)?;
    let request_fingerprint = fingerprint(&MessageIntent {
        conversation_id,
        kind: message_kind,
        content: &request.content,
        reply_to_message_id: request.reply_to_message_id,
        attachment_ids: &attachment_ids,
    })?;

    advisory_operation_lock(transaction, account_id, request.client_message_id).await?;
    let existing: Option<(Uuid, String)> = query_as(
        "SELECT message_id, request_fingerprint FROM cloud_chat_messages \
         WHERE sender_account_id = $1 AND client_message_id = $2",
    )
    .bind(account_id)
    .bind(request.client_message_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if let Some((message_id, stored_fingerprint)) = existing {
        if stored_fingerprint != request_fingerprint {
            return Err(StoreError::IdempotencyKeyReused);
        }
        let message = load_message(transaction, message_id).await?;
        return Ok(InsertOutcome {
            value: message,
            inserted: false,
        });
    }

    require_active_member(transaction, conversation_id, account_id).await?;
    if let Some(projection) = &group_projection {
        let group_title = matches!(
            projection.kind.as_str(),
            "group-invite" | "group-update" | "group-title-update"
        )
        .then(|| projection.group_title.as_deref())
        .flatten();
        query(
            "UPDATE cloud_chat_conversations conversation \
             SET group_space_id = $2, \
                 group_title = COALESCE( \
                   $3, conversation.group_title, ( \
                     SELECT sibling.group_title \
                     FROM cloud_chat_conversations sibling \
                     WHERE sibling.group_space_id = $2 AND sibling.group_title IS NOT NULL \
                     ORDER BY sibling.updated_at DESC LIMIT 1 \
                   ) \
                 ) \
             WHERE conversation.conversation_id = $1",
        )
        .bind(conversation_id)
        .bind(&projection.group_space_id)
        .bind(group_title)
        .execute(&mut **transaction)
        .await?;
        if let Some(group_title) = group_title {
            query(
                "UPDATE cloud_chat_conversations \
                 SET group_title = $2 \
                 WHERE group_space_id = $1",
            )
            .bind(&projection.group_space_id)
            .bind(group_title)
            .execute(&mut **transaction)
            .await?;
        }
    }
    if let Some(reply_to_message_id) = request.reply_to_message_id {
        let reply: Option<(i32,)> = query_as(
            "SELECT 1 FROM cloud_chat_messages \
             WHERE message_id = $1 AND conversation_id = $2",
        )
        .bind(reply_to_message_id)
        .bind(conversation_id)
        .fetch_optional(&mut **transaction)
        .await?;
        if reply.is_none() {
            return Err(StoreError::InvalidInput(
                "reply target is not in this conversation",
            ));
        }
    }
    if !attachment_ids.is_empty() {
        let valid_attachments: (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_attachments \
             WHERE attachment_id = ANY($1) AND owner_account_id = $2 AND finalized_at IS NOT NULL",
        )
        .bind(&attachment_ids)
        .bind(account_id)
        .fetch_one(&mut **transaction)
        .await?;
        if valid_attachments.0 != attachment_ids.len() as i64 {
            return Err(StoreError::InvalidInput(
                "one or more attachments are unavailable",
            ));
        }
        if message_kind == "voice" {
            let voice_attachment: Option<(Option<String>,)> = query_as(
                "SELECT content_type FROM cloud_attachments \
                 WHERE attachment_id = $1 AND owner_account_id = $2 AND finalized_at IS NOT NULL",
            )
            .bind(&attachment_ids[0])
            .bind(account_id)
            .fetch_optional(&mut **transaction)
            .await?;
            let content_type = voice_attachment
                .and_then(|row| row.0)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(
                content_type.as_str(),
                "audio/mp4" | "audio/m4a" | "audio/x-m4a" | "audio/aac"
            ) {
                return Err(StoreError::InvalidInput(
                    "voice message media type is invalid",
                ));
            }
        }
    }
    validate_meme_attachment_bytes(transaction, account_id, &meme_attachments).await?;

    let allocation: Option<(i64, i32)> = query_as(
        "UPDATE cloud_chat_conversations \
         SET next_message_sequence = next_message_sequence + 1, \
             latest_message_sequence = next_message_sequence, \
             version = version + 1, \
             updated_at = now() \
         WHERE conversation_id = $1 \
         RETURNING next_message_sequence - 1, version",
    )
    .bind(conversation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let (conversation_sequence, _conversation_version) = allocation.ok_or(StoreError::NotFound)?;
    let message_id = Uuid::now_v7();
    query(
        "INSERT INTO cloud_chat_messages \
         (message_id, conversation_id, conversation_sequence, sender_account_id, \
          client_message_id, request_fingerprint, message_kind, content, reply_to_message_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(message_id)
    .bind(conversation_id)
    .bind(conversation_sequence)
    .bind(account_id)
    .bind(request.client_message_id)
    .bind(&request_fingerprint)
    .bind(message_kind)
    .bind(&request.content)
    .bind(request.reply_to_message_id)
    .execute(&mut **transaction)
    .await?;
    for (position, attachment_id) in attachment_ids.iter().enumerate() {
        query(
            "INSERT INTO cloud_chat_message_attachments(message_id, attachment_id, position) \
             VALUES ($1, $2, $3)",
        )
        .bind(message_id)
        .bind(attachment_id)
        .bind(position as i32)
        .execute(&mut **transaction)
        .await?;
    }
    let message = load_message(transaction, message_id).await?;
    if crate::notifications::is_frontend_visible_message(&message) {
        let resurrect_sender = crate::notifications::is_agent_authored_message(&message);
        let restored: Vec<(String, String)> = query_as(
            "DELETE FROM cloud_account_session_visibility visibility \
             USING cloud_chat_conversation_members member, cloud_chat_conversations conversation \
             WHERE conversation.conversation_id = $1 \
               AND member.conversation_id = conversation.conversation_id \
               AND member.membership_state = 'active' \
               AND visibility.account_id = member.account_id \
               AND visibility.deleted_at IS NOT NULL \
               AND (visibility.session_id = conversation.legacy_session_id \
                    OR visibility.session_id = conversation.conversation_id::text) \
               AND (member.account_id <> $2 OR $3) \
             RETURNING visibility.account_id, visibility.session_id",
        )
        .bind(conversation_id)
        .bind(account_id)
        .bind(resurrect_sender)
        .fetch_all(&mut **transaction)
        .await?;
        if !restored.is_empty() {
            insert_sync_event_fanout(
                transaction,
                "session.unhidden",
                Some(conversation_id),
                None,
                None,
                restored
                    .into_iter()
                    .map(|(account_id, session_id)| {
                        (account_id, json!({ "sessionId": session_id }))
                    })
                    .collect(),
            )
            .await?;
        }
    }
    fanout_message_sync_event(transaction, "message.created", &message).await?;
    Ok(InsertOutcome {
        value: message,
        inserted: true,
    })
}

/// Replace the kind and content of a trusted server-authored message while
/// keeping its original timeline position. Call lifecycle records use this to
/// transition one durable message from `started` to `ended` for every member.
pub(crate) async fn replace_server_message_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    sender_account_id: &str,
    client_message_id: Uuid,
    message_kind: &str,
    content: Value,
) -> Result<Option<MessageSnapshot>, StoreError> {
    let message_kind = message_kind.trim();
    if message_kind.is_empty() || message_kind.chars().count() > 64 {
        return Err(StoreError::InvalidInput("message kind is invalid"));
    }
    let row: Option<(Uuid, String, Value)> = query_as(
        "SELECT message_id, message_kind, content \
         FROM cloud_chat_messages \
         WHERE sender_account_id = $1 AND client_message_id = $2 FOR UPDATE",
    )
    .bind(sender_account_id)
    .bind(client_message_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((message_id, stored_kind, stored_content)) = row else {
        return Ok(None);
    };
    if stored_kind == message_kind && stored_content == content {
        return Ok(Some(load_message(transaction, message_id).await?));
    }

    query(
        "UPDATE cloud_chat_messages \
         SET message_kind = $2, content = $3, version = version + 1, edited_at = now() \
         WHERE message_id = $1",
    )
    .bind(message_id)
    .bind(message_kind)
    .bind(&content)
    .execute(&mut **transaction)
    .await?;
    let message = load_message(transaction, message_id).await?;
    fanout_message_sync_event(transaction, "message.updated", &message).await?;
    Ok(Some(message))
}

/// Replace a trusted server-authored message snapshot without allocating a
/// second timeline position. This is used for durable AI generation snapshots
/// and artifact links; every replacement increments the entity version and is
/// fanned out through the same per-user stream as ordinary messages.
pub async fn replace_message_snapshot(
    pool: &PgPool,
    sender_account_id: &str,
    message_id: Uuid,
    content: Value,
    attachment_ids: Vec<String>,
) -> Result<MessageSnapshot, StoreError> {
    let mut unique_attachments = BTreeSet::new();
    let mut normalized_attachments = Vec::with_capacity(attachment_ids.len());
    for attachment_id in attachment_ids {
        let attachment_id = attachment_id.trim();
        if attachment_id.is_empty() || !unique_attachments.insert(attachment_id.to_string()) {
            return Err(StoreError::InvalidInput("attachment ids are invalid"));
        }
        normalized_attachments.push(attachment_id.to_string());
    }
    let meme_attachments = meme_attachment_metadata(&content, &normalized_attachments)?;

    let mut transaction = pool.begin().await?;
    let row: Option<(Uuid, String)> = query_as(
        "SELECT conversation_id, sender_account_id FROM cloud_chat_messages \
         WHERE message_id = $1 FOR UPDATE",
    )
    .bind(message_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((conversation_id, stored_sender_account_id)) = row else {
        return Err(StoreError::NotFound);
    };
    if stored_sender_account_id != sender_account_id {
        return Err(StoreError::Forbidden);
    }
    require_active_member(&mut transaction, conversation_id, sender_account_id).await?;
    if !normalized_attachments.is_empty() {
        let valid_attachments: (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_attachments \
             WHERE attachment_id = ANY($1) AND owner_account_id = $2 AND finalized_at IS NOT NULL",
        )
        .bind(&normalized_attachments)
        .bind(sender_account_id)
        .fetch_one(&mut *transaction)
        .await?;
        if valid_attachments.0 != normalized_attachments.len() as i64 {
            return Err(StoreError::InvalidInput(
                "one or more attachments are unavailable",
            ));
        }
    }
    validate_meme_attachment_bytes(&mut transaction, sender_account_id, &meme_attachments).await?;

    let current = load_message(&mut transaction, message_id).await?;
    if current.content == content && current.attachment_ids == normalized_attachments {
        transaction.commit().await?;
        return Ok(current);
    }
    query(
        "UPDATE cloud_chat_messages \
         SET content = $2, version = version + 1, edited_at = now() \
         WHERE message_id = $1",
    )
    .bind(message_id)
    .bind(&content)
    .execute(&mut *transaction)
    .await?;
    query("DELETE FROM cloud_chat_message_attachments WHERE message_id = $1")
        .bind(message_id)
        .execute(&mut *transaction)
        .await?;
    for (position, attachment_id) in normalized_attachments.iter().enumerate() {
        query(
            "INSERT INTO cloud_chat_message_attachments(message_id, attachment_id, position) \
             VALUES ($1, $2, $3)",
        )
        .bind(message_id)
        .bind(attachment_id)
        .bind(position as i32)
        .execute(&mut *transaction)
        .await?;
    }
    let message = load_message(&mut transaction, message_id).await?;
    fanout_message_sync_event(&mut transaction, "message.updated", &message).await?;
    transaction.commit().await?;
    Ok(message)
}

pub async fn conversation_id_for_session(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<Option<Uuid>, StoreError> {
    let canonical_id = Uuid::parse_str(session_id.trim()).ok();
    let row: Option<(Uuid,)> = query_as(
        "SELECT conversation.conversation_id \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = conversation.conversation_id \
         WHERE (conversation.legacy_session_id = $1 OR conversation.conversation_id = $3) \
           AND member.account_id = $2 \
           AND member.membership_state = 'active'",
    )
    .bind(session_id.trim())
    .bind(account_id)
    .bind(canonical_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(conversation_id,)| conversation_id))
}
