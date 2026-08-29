use super::*;

pub(super) fn fingerprint<T: Serialize>(value: &T) -> Result<String, StoreError> {
    let encoded = serde_json::to_vec(value)
        .map_err(|_| StoreError::InvariantViolation("request fingerprint serialization failed"))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

pub(super) fn parse_kind(value: &str) -> Result<ConversationKind, StoreError> {
    match value {
        "direct" => Ok(ConversationKind::Direct),
        "group" => Ok(ConversationKind::Group),
        "ai" => Ok(ConversationKind::Ai),
        _ => Err(StoreError::InvariantViolation(
            "stored conversation kind is invalid",
        )),
    }
}

pub(super) fn member_from_row(row: MemberRow) -> MemberSnapshot {
    MemberSnapshot {
        default_agent_id: format!("cloud-agent:{}", row.0),
        account_id: row.0,
        display_name: row.1,
        avatar_url: row.2,
        default_agent_display_name: row.3,
        default_agent_avatar_url: row.4,
        role: row.5,
        membership_state: row.6,
        version: row.7,
        last_delivered_sequence: row.8,
        last_read_sequence: row.9,
        joined_at: row.10,
        left_at: row.11,
    }
}

pub(super) fn message_from_row(
    row: MessageRow,
    attachment_ids: Vec<String>,
    reactions: Vec<ReactionSnapshot>,
) -> MessageSnapshot {
    MessageSnapshot {
        id: row.0,
        client_message_id: row.1,
        conversation_id: row.2,
        conversation_sequence: row.3,
        sender_account_id: row.4,
        kind: row.5,
        content: row.6,
        reply_to_message_id: row.7,
        attachment_ids,
        version: row.8,
        generation_status: row.9,
        provider_response_id: row.10,
        created_at: row.11,
        edited_at: row.12,
        deleted_at: row.13,
        reactions,
    }
}

pub(super) async fn advisory_operation_lock(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    operation_id: Uuid,
) -> Result<(), StoreError> {
    // PostgreSQL text values cannot contain NUL bytes. Length-prefix the
    // account component so the composite key is still unambiguous.
    let key = format!("{}:{account_id}{operation_id}", account_id.len());
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(key)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub(super) async fn advisory_session_lock(
    transaction: &mut Transaction<'_, Postgres>,
    client_session_id: &str,
) -> Result<(), StoreError> {
    // Acquire the previously shipped namespace first so a rolling deployment
    // remains serialized with an older server process.
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("chat-session-v2:{client_session_id}"))
        .execute(&mut **transaction)
        .await?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("chat-session:{client_session_id}"))
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub(super) async fn member_rows(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Vec<MemberSnapshot>, StoreError> {
    let rows: Vec<MemberRow> = query_as(
        "SELECT member.account_id, account.display_name, account.avatar_url, \
                agent.display_name, agent.avatar_url, \
                member.role, member.membership_state, member.version, \
                member.last_delivered_sequence, member.last_read_sequence, \
                member.joined_at, member.left_at \
         FROM cloud_chat_conversation_members member \
         JOIN cloud_accounts account ON account.account_id = member.account_id \
         JOIN cloud_default_agent_profiles agent ON agent.owner_account_id = member.account_id \
         WHERE member.conversation_id = $1 \
         ORDER BY member.joined_at ASC, member.account_id ASC",
    )
    .bind(conversation_id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows.into_iter().map(member_from_row).collect())
}

pub(super) async fn load_conversation(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    viewer_account_id: &str,
) -> Result<ConversationSnapshot, StoreError> {
    let row: Option<ConversationRow> = query_as(
        "SELECT conversation.conversation_id, conversation.kind, \
                conversation.shared_title, conversation.version, \
                conversation.created_by_account_id, conversation.legacy_session_id, \
                fork.parent_session_id, fork.parent_message_id, \
                conversation.latest_message_sequence, conversation.created_at, \
                conversation.updated_at \
         FROM cloud_chat_conversations conversation \
         LEFT JOIN cloud_session_forks fork \
           ON fork.fork_session_id = conversation.legacy_session_id \
         WHERE conversation.conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let row = row.ok_or(StoreError::NotFound)?;
    let preferences: Option<(Option<String>, i32)> = query_as(
        "SELECT personal_title, preferences_version \
         FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(viewer_account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let (personal_title, preferences_version) = preferences.ok_or(StoreError::Forbidden)?;
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
        members: member_rows(transaction, conversation_id).await?,
        preferences: ConversationPreferencesSnapshot {
            conversation_id,
            account_id: viewer_account_id.to_string(),
            personal_title,
            version: preferences_version,
        },
    })
}

pub(super) async fn attachment_ids(
    transaction: &mut Transaction<'_, Postgres>,
    message_id: Uuid,
) -> Result<Vec<String>, StoreError> {
    let rows: Vec<(String,)> = query_as(
        "SELECT attachment_id FROM cloud_chat_message_attachments \
         WHERE message_id = $1 ORDER BY position ASC",
    )
    .bind(message_id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows.into_iter().map(|row| row.0).collect())
}

pub(super) async fn load_message(
    transaction: &mut Transaction<'_, Postgres>,
    message_id: Uuid,
) -> Result<MessageSnapshot, StoreError> {
    let row: Option<MessageRow> = query_as(
        "SELECT message_id, client_message_id, conversation_id, conversation_sequence, \
                sender_account_id, message_kind, content, reply_to_message_id, version, \
                generation_status, provider_response_id, created_at, edited_at, deleted_at \
         FROM cloud_chat_messages WHERE message_id = $1",
    )
    .bind(message_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let row = row.ok_or(StoreError::NotFound)?;
    let attachments = attachment_ids(transaction, row.0).await?;
    let reactions = reactions_by_message(transaction, &[row.0])
        .await?
        .remove(&row.0)
        .unwrap_or_default();
    Ok(message_from_row(row, attachments, reactions))
}

pub(super) async fn active_member_ids(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<Vec<String>, StoreError> {
    let rows: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND membership_state = 'active' \
         ORDER BY account_id ASC",
    )
    .bind(conversation_id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows.into_iter().map(|row| row.0).collect())
}

pub async fn identity_sync_recipient_ids(
    transaction: &mut Transaction<'_, Postgres>,
    owner_account_id: &str,
    include_viewers: bool,
) -> Result<Vec<String>, StoreError> {
    if !include_viewers {
        return Ok(vec![owner_account_id.to_string()]);
    }
    let rows: Vec<(String,)> = query_as(
        "SELECT DISTINCT account_id FROM (
             SELECT $1::TEXT AS account_id
             UNION SELECT account_id FROM cloud_contacts WHERE peer_account_id = $1
             UNION SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1
             UNION SELECT viewer.account_id
               FROM cloud_chat_conversation_members owner
               JOIN cloud_chat_conversation_members viewer
                 ON viewer.conversation_id = owner.conversation_id
              WHERE owner.account_id = $1
                AND owner.membership_state = 'active'
                AND viewer.membership_state = 'active'
         ) recipients
         ORDER BY account_id",
    )
    .bind(owner_account_id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows.into_iter().map(|row| row.0).collect())
}

pub(super) async fn require_active_member(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), StoreError> {
    let member: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if member.is_none() {
        return Err(StoreError::Forbidden);
    }
    Ok(())
}

/// Append a non-timeline domain event to each recipient's durable sync stream.
/// Recipients are de-duplicated and sorted before their sync-head rows are
/// locked, preserving the same deterministic lock order as message fanout.
pub async fn append_user_sync_events_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    account_ids: &[String],
    event_type: &str,
    conversation_id: Option<Uuid>,
    payload: &Value,
) -> Result<(), StoreError> {
    let recipients = account_ids
        .iter()
        .map(|account_id| account_id.trim())
        .filter(|account_id| !account_id.is_empty())
        .map(ToString::to_string)
        .collect::<BTreeSet<_>>();
    for recipient in &recipients {
        insert_sync_event(
            transaction,
            recipient,
            event_type,
            conversation_id,
            None,
            None,
            payload,
        )
        .await?;
    }
    Ok(())
}

/// Publish an ancillary domain snapshot through canonical chat sync. Callers whose
/// canonical row is written in the same operation should prefer
/// `append_user_sync_events_in_transaction` inside their existing transaction.
pub async fn publish_user_sync_events(
    pool: &PgPool,
    account_ids: &[String],
    event_type: &str,
    conversation_id: Option<Uuid>,
    payload: Value,
) -> Result<(), StoreError> {
    let mut transaction = pool.begin().await?;
    append_user_sync_events_in_transaction(
        &mut transaction,
        account_ids,
        event_type,
        conversation_id,
        &payload,
    )
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub(super) async fn existing_operation<T: serde::de::DeserializeOwned>(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    operation_id: Uuid,
    operation_kind: &str,
    expected_fingerprint: &str,
) -> Result<Option<T>, StoreError> {
    let row: Option<(String, String, Value)> = query_as(
        "SELECT operation_kind, request_fingerprint, result \
         FROM cloud_chat_client_operations \
         WHERE account_id = $1 AND client_operation_id = $2",
    )
    .bind(account_id)
    .bind(operation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((stored_kind, stored_fingerprint, result)) = row else {
        return Ok(None);
    };
    if stored_kind != operation_kind || stored_fingerprint != expected_fingerprint {
        return Err(StoreError::IdempotencyKeyReused);
    }
    let decoded = serde_json::from_value(result)
        .map_err(|_| StoreError::InvariantViolation("stored operation result is invalid"))?;
    Ok(Some(decoded))
}

pub(super) async fn record_operation<T: Serialize>(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    operation_id: Uuid,
    operation_kind: &str,
    request_fingerprint: &str,
    result: &T,
) -> Result<(), StoreError> {
    let result = serde_json::to_value(result)
        .map_err(|_| StoreError::InvariantViolation("operation result serialization failed"))?;
    query(
        "INSERT INTO cloud_chat_client_operations \
         (account_id, client_operation_id, operation_kind, request_fingerprint, result) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(account_id)
    .bind(operation_id)
    .bind(operation_kind)
    .bind(request_fingerprint)
    .bind(result)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

pub(super) fn normalize_title(value: Option<&str>) -> Result<Option<String>, StoreError> {
    let title = value.map(str::trim).filter(|value| !value.is_empty());
    if title.is_some_and(|value| value.chars().count() > 200) {
        return Err(StoreError::InvalidInput("title is too long"));
    }
    Ok(title.map(ToString::to_string))
}

pub(super) fn normalize_client_session_id(
    value: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let session_id = value.map(str::trim).filter(|value| !value.is_empty());
    if session_id.is_some_and(|value| value.chars().count() > 512) {
        return Err(StoreError::InvalidInput("client session id is too long"));
    }
    Ok(session_id.map(ToString::to_string))
}

pub(super) fn normalized_members(account_id: &str, values: &[String]) -> Vec<String> {
    let mut members = values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect::<BTreeSet<_>>();
    members.insert(account_id.to_string());
    members.into_iter().collect()
}
