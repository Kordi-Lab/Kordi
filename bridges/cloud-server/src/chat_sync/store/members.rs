use super::support::*;
use super::*;

pub async fn add_conversation_members(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: AddConversationMembersRequest,
) -> Result<ConversationSnapshot, StoreError> {
    let desired = normalized_members(account_id, &request.member_account_ids);
    if desired.len() > MAX_GROUP_MEMBERS || (request.replace && desired.len() < 2) {
        return Err(StoreError::InvalidInput(
            "group member additions are invalid",
        ));
    }
    if !request.replace && desired.len() == 1 {
        return Err(StoreError::InvalidInput(
            "group member additions are invalid",
        ));
    }
    let request_fingerprint = fingerprint(&AddMembersIntent {
        conversation_id,
        member_account_ids: &desired,
        replace: request.replace,
    })?;
    let mut transaction = pool.begin().await?;
    advisory_operation_lock(&mut transaction, account_id, request.client_operation_id).await?;
    if let Some(existing) = existing_operation::<ConversationSnapshot>(
        &mut transaction,
        account_id,
        request.client_operation_id,
        "conversation.members.add",
        &request_fingerprint,
    )
    .await?
    {
        transaction.commit().await?;
        return Ok(existing);
    }
    let authorization: Option<(String, String)> = query_as(
        "SELECT conversation.kind, member.role
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = conversation.conversation_id
         WHERE conversation.conversation_id = $1
           AND member.account_id = $2
           AND member.membership_state = 'active'
         FOR UPDATE OF conversation",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((kind, role)) = authorization else {
        return Err(StoreError::Forbidden);
    };
    if kind != "group" || (role != "owner" && role != "admin") {
        return Err(StoreError::Forbidden);
    }
    let current = active_member_ids(&mut transaction, conversation_id).await?;
    let missing = desired
        .iter()
        .filter(|member| !current.contains(member))
        .cloned()
        .collect::<Vec<_>>();
    let removed = if request.replace {
        current
            .iter()
            .filter(|member| !desired.contains(member) && member.as_str() != account_id)
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if current.len() + missing.len() - removed.len() > MAX_GROUP_MEMBERS {
        return Err(StoreError::InvalidInput("group member count is invalid"));
    }
    if !missing.is_empty() {
        let accounts: (i64,) =
            query_as("SELECT COUNT(*) FROM cloud_accounts WHERE account_id = ANY($1)")
                .bind(&missing)
                .fetch_one(&mut *transaction)
                .await?;
        if accounts.0 != missing.len() as i64 {
            return Err(StoreError::InvalidInput(
                "one or more conversation members do not exist",
            ));
        }
        let contacts: (i64,) = query_as(
            "SELECT COUNT(*) FROM cloud_contacts
             WHERE account_id = $1 AND peer_account_id = ANY($2)",
        )
        .bind(account_id)
        .bind(&missing)
        .fetch_one(&mut *transaction)
        .await?;
        if contacts.0 != missing.len() as i64 {
            return Err(StoreError::Forbidden);
        }
        for member in &missing {
            query(
                "INSERT INTO cloud_chat_conversation_members
                 (conversation_id, account_id, role, membership_state)
                 VALUES ($1, $2, 'member', 'active')
                 ON CONFLICT (conversation_id, account_id) DO UPDATE SET
                     membership_state = 'active', left_at = NULL, version = cloud_chat_conversation_members.version + 1",
            )
            .bind(conversation_id)
            .bind(member)
            .execute(&mut *transaction)
            .await?;
        }
    }
    for member in &removed {
        query(
            "UPDATE cloud_chat_conversation_members
             SET membership_state = 'removed', left_at = now(), version = version + 1
             WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active'",
        )
        .bind(conversation_id)
        .bind(member)
        .execute(&mut *transaction)
        .await?;
    }
    if !missing.is_empty() || !removed.is_empty() {
        query(
            "UPDATE cloud_chat_conversations
             SET version = version + 1, updated_at = now()
             WHERE conversation_id = $1",
        )
        .bind(conversation_id)
        .execute(&mut *transaction)
        .await?;
    }
    let conversation = load_conversation(&mut transaction, conversation_id, account_id).await?;
    record_operation(
        &mut transaction,
        account_id,
        request.client_operation_id,
        "conversation.members.add",
        &request_fingerprint,
        &conversation,
    )
    .await?;
    if !missing.is_empty() || !removed.is_empty() {
        for member in active_member_ids(&mut transaction, conversation_id).await? {
            let projection = load_conversation(&mut transaction, conversation_id, &member).await?;
            insert_sync_event(
                &mut transaction,
                &member,
                "membership.updated",
                Some(conversation_id),
                Some(conversation_id),
                Some(projection.version),
                &json!({ "conversation": projection }),
            )
            .await?;
        }
        for member in &removed {
            insert_sync_event(
                &mut transaction,
                member,
                "membership.removed",
                Some(conversation_id),
                Some(conversation_id),
                Some(conversation.version),
                &json!({
                    "conversation_id": conversation_id,
                    "account_id": member,
                    "membership_state": "removed",
                    "version": conversation.version,
                }),
            )
            .await?;
        }
        wake_dispatcher(&mut transaction).await?;
    }
    transaction.commit().await?;
    Ok(conversation)
}

/// Atomically activates a member accepted through a verified group invitation.
///
/// The invitation handler owns the surrounding transaction so its acceptance
/// row and the canonical membership/event fanout commit or roll back together. This
/// intentionally bypasses the normal contact requirement: possession of a
/// valid invitation is the authorization grant.
pub async fn accept_invited_conversation_member(
    transaction: &mut Transaction<'_, Postgres>,
    inviter_account_id: &str,
    legacy_session_id: &str,
    member_account_id: &str,
) -> Result<ConversationSnapshot, StoreError> {
    let legacy_session_id = legacy_session_id.trim();
    let member_account_id = member_account_id.trim();
    if legacy_session_id.is_empty() || member_account_id.is_empty() {
        return Err(StoreError::InvalidInput(
            "group invitation identity is invalid",
        ));
    }

    let authorization: Option<(Uuid, String, String)> = query_as(
        "SELECT conversation.conversation_id, conversation.kind, inviter.role
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members inviter
           ON inviter.conversation_id = conversation.conversation_id
         WHERE conversation.legacy_session_id = $1
           AND inviter.account_id = $2
           AND inviter.membership_state = 'active'
         FOR UPDATE OF conversation",
    )
    .bind(legacy_session_id)
    .bind(inviter_account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((conversation_id, kind, inviter_role)) = authorization else {
        return Err(StoreError::Forbidden);
    };
    if kind != "group" || (inviter_role != "owner" && inviter_role != "admin") {
        return Err(StoreError::Forbidden);
    }

    let existing_state: Option<(String,)> = query_as(
        "SELECT membership_state FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(member_account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    if existing_state
        .as_ref()
        .is_some_and(|(state,)| state == "active")
    {
        return load_conversation(transaction, conversation_id, member_account_id).await;
    }

    let active_count: (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .fetch_one(&mut **transaction)
    .await?;
    if active_count.0 >= MAX_GROUP_MEMBERS as i64 {
        return Err(StoreError::InvalidInput("group member count is invalid"));
    }
    let account_exists: Option<(i32,)> =
        query_as("SELECT 1 FROM cloud_accounts WHERE account_id = $1")
            .bind(member_account_id)
            .fetch_optional(&mut **transaction)
            .await?;
    if account_exists.is_none() {
        return Err(StoreError::InvalidInput("invited account does not exist"));
    }

    query(
        "INSERT INTO cloud_chat_conversation_members
         (conversation_id, account_id, role, membership_state)
         VALUES ($1, $2, 'member', 'active')
         ON CONFLICT (conversation_id, account_id) DO UPDATE SET
             role = 'member', membership_state = 'active', left_at = NULL,
             version = cloud_chat_conversation_members.version + 1",
    )
    .bind(conversation_id)
    .bind(member_account_id)
    .execute(&mut **transaction)
    .await?;
    query(
        "UPDATE cloud_chat_conversations
         SET version = version + 1, updated_at = now()
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .execute(&mut **transaction)
    .await?;

    let invited_projection =
        load_conversation(transaction, conversation_id, member_account_id).await?;
    for recipient in active_member_ids(transaction, conversation_id).await? {
        let projection = if recipient == member_account_id {
            invited_projection.clone()
        } else {
            load_conversation(transaction, conversation_id, &recipient).await?
        };
        insert_sync_event(
            transaction,
            &recipient,
            "membership.updated",
            Some(conversation_id),
            Some(conversation_id),
            Some(projection.version),
            &json!({ "conversation": projection }),
        )
        .await?;
    }
    wake_dispatcher(transaction).await?;
    Ok(invited_projection)
}
