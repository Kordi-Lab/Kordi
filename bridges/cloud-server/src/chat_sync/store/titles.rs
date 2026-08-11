use super::support::*;
use super::*;

pub async fn update_shared_title(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: UpdateConversationTitleRequest,
) -> Result<ConversationSnapshot, StoreError> {
    let shared_title = normalize_title(request.shared_title.as_deref())?;
    let request_fingerprint = fingerprint(&SharedTitleIntent {
        conversation_id,
        expected_version: request.expected_version,
        shared_title: &shared_title,
    })?;
    let mut transaction = pool.begin().await?;
    advisory_operation_lock(&mut transaction, account_id, request.client_operation_id).await?;
    if let Some(existing) = existing_operation::<ConversationSnapshot>(
        &mut transaction,
        account_id,
        request.client_operation_id,
        "conversation.title.update",
        &request_fingerprint,
    )
    .await?
    {
        transaction.commit().await?;
        return Ok(existing);
    }

    let authorization: Option<(String, i32, Option<String>)> = query_as(
        "SELECT member.role, conversation.version, conversation.shared_title \
         FROM cloud_chat_conversation_members member \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = member.conversation_id \
         WHERE member.conversation_id = $1 AND member.account_id = $2 \
           AND member.membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((role, current_version, current_title)) = authorization else {
        return Err(StoreError::Forbidden);
    };
    if role != "owner" && role != "admin" {
        return Err(StoreError::Forbidden);
    }
    if current_version != request.expected_version {
        return Err(StoreError::VersionConflict(Box::new(
            load_conversation(&mut transaction, conversation_id, account_id).await?,
        )));
    }

    if current_title != shared_title {
        query(
            "UPDATE cloud_chat_conversations \
             SET shared_title = $1, version = version + 1, updated_at = now() \
             WHERE conversation_id = $2",
        )
        .bind(&shared_title)
        .bind(conversation_id)
        .execute(&mut *transaction)
        .await?;
    }
    let conversation = load_conversation(&mut transaction, conversation_id, account_id).await?;
    record_operation(
        &mut transaction,
        account_id,
        request.client_operation_id,
        "conversation.title.update",
        &request_fingerprint,
        &conversation,
    )
    .await?;
    if current_title != shared_title {
        for member in active_member_ids(&mut transaction, conversation_id).await? {
            let projection = if member == account_id {
                conversation.clone()
            } else {
                load_conversation(&mut transaction, conversation_id, &member).await?
            };
            let payload = json!({ "conversation": &projection });
            insert_sync_event(
                &mut transaction,
                &member,
                "conversation.updated",
                Some(conversation_id),
                Some(conversation_id),
                Some(projection.version),
                &payload,
            )
            .await?;
        }
        wake_dispatcher(&mut transaction).await?;
    }
    transaction.commit().await?;
    Ok(conversation)
}

pub async fn update_personal_title(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: UpdatePersonalTitleRequest,
) -> Result<ConversationPreferencesSnapshot, StoreError> {
    let personal_title = normalize_title(request.personal_title.as_deref())?;
    let request_fingerprint = fingerprint(&PersonalTitleIntent {
        conversation_id,
        expected_preferences_version: request.expected_preferences_version,
        personal_title: &personal_title,
    })?;
    let mut transaction = pool.begin().await?;
    advisory_operation_lock(&mut transaction, account_id, request.client_operation_id).await?;
    if let Some(existing) = existing_operation::<ConversationPreferencesSnapshot>(
        &mut transaction,
        account_id,
        request.client_operation_id,
        "conversation.personal_title.update",
        &request_fingerprint,
    )
    .await?
    {
        transaction.commit().await?;
        return Ok(existing);
    }

    let row: Option<(Option<String>, i32)> = query_as(
        "SELECT personal_title, preferences_version \
         FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active' \
         FOR UPDATE",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((current_title, current_version)) = row else {
        return Err(StoreError::Forbidden);
    };
    let current = ConversationPreferencesSnapshot {
        conversation_id,
        account_id: account_id.to_string(),
        personal_title: current_title,
        version: current_version,
    };
    if current.version != request.expected_preferences_version {
        return Err(StoreError::PreferencesVersionConflict(Box::new(current)));
    }
    let changed = current.personal_title != personal_title;
    if changed {
        query(
            "UPDATE cloud_chat_conversation_members \
             SET personal_title = $1, preferences_version = preferences_version + 1 \
             WHERE conversation_id = $2 AND account_id = $3",
        )
        .bind(&personal_title)
        .bind(conversation_id)
        .bind(account_id)
        .execute(&mut *transaction)
        .await?;
    }
    let preferences: (Option<String>, i32) = query_as(
        "SELECT personal_title, preferences_version \
         FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(&mut *transaction)
    .await?;
    let preferences = ConversationPreferencesSnapshot {
        conversation_id,
        account_id: account_id.to_string(),
        personal_title: preferences.0,
        version: preferences.1,
    };
    record_operation(
        &mut transaction,
        account_id,
        request.client_operation_id,
        "conversation.personal_title.update",
        &request_fingerprint,
        &preferences,
    )
    .await?;
    if changed {
        let payload = json!({
            "conversation_id": conversation_id,
            "preferences": &preferences,
        });
        insert_sync_event(
            &mut transaction,
            account_id,
            "conversation.preferences.updated",
            Some(conversation_id),
            Some(conversation_id),
            Some(preferences.version),
            &payload,
        )
        .await?;
        wake_dispatcher(&mut transaction).await?;
    }
    transaction.commit().await?;
    Ok(preferences)
}
