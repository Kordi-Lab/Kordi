//! Leaving a group.
//!
//! Leaving a space's main conversation leaves every channel of the space;
//! leaving a channel leaves only that channel. The space is locked with the
//! same advisory key that invitation links use, before any row lock, so
//! leaves and invitation acceptances in one space never interleave. Server
//! members such as PiP are never removed, and an owner who leaves hands the
//! group to another person.

use super::relationship_gate::GroupSpace;
use super::service_members::service_member_ids;
use super::support::*;
use super::*;
use crate::chat_sync::models::{LeaveConversationRequest, LeaveConversationResponse};

const LEAVE_OPERATION: &str = "conversation.leave";

#[derive(Serialize)]
struct LeaveIntent<'a> {
    conversation_id: Uuid,
    successor_account_id: Option<&'a str>,
}

pub async fn leave_group(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: LeaveConversationRequest,
) -> Result<LeaveConversationResponse, StoreError> {
    let hint = request
        .successor_account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let request_fingerprint = fingerprint(&LeaveIntent {
        conversation_id,
        successor_account_id: hint,
    })?;
    let mut transaction = pool.begin().await?;
    advisory_operation_lock(&mut transaction, account_id, request.client_operation_id).await?;
    if let Some(existing) = existing_operation::<LeaveConversationResponse>(
        &mut transaction,
        account_id,
        request.client_operation_id,
        LEAVE_OPERATION,
        &request_fingerprint,
    )
    .await?
    {
        transaction.commit().await?;
        return Ok(existing);
    }
    let row: Option<(String, Option<String>, Option<String>, bool)> = query_as(
        "SELECT conversation.kind, conversation.legacy_session_id, conversation.group_space_id, \
                EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                        WHERE member.conversation_id = conversation.conversation_id \
                          AND member.account_id = $2) \
         FROM cloud_chat_conversations conversation \
         WHERE conversation.conversation_id = $1",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((kind, legacy_session_id, group_space_id, has_membership)) = row else {
        return Err(StoreError::NotFound);
    };
    if !has_membership {
        return Err(StoreError::Forbidden);
    }
    if kind != "group" {
        return Err(StoreError::InvalidInput("Only groups can be left."));
    }
    let space = GroupSpace::new(legacy_session_id.as_deref(), group_space_id.as_deref());
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&space.root)
        .execute(&mut *transaction)
        .await?;
    // Only a space's main conversation cascades, so a channel that names
    // another space can never pull the caller out of that space.
    let targets: Vec<(Uuid,)> = query_as(
        "SELECT conversation.conversation_id \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = conversation.conversation_id \
         WHERE conversation.kind = 'group' \
           AND member.account_id = $2 \
           AND member.membership_state = 'active' \
           AND (conversation.conversation_id = $1 \
                OR ($3 AND $4 <> '' AND conversation.group_space_id = $4)) \
         ORDER BY conversation.conversation_id \
         FOR UPDATE OF conversation",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(space.is_root)
    .bind(&space.root)
    .fetch_all(&mut *transaction)
    .await?;

    let mut response = LeaveConversationResponse::default();
    let mut root_successor = None;
    for (target,) in &targets {
        let successor = leave_one(&mut transaction, account_id, *target, hint).await?;
        response.left_conversation_ids.push(*target);
        if *target == conversation_id {
            root_successor = successor.clone();
        }
        if response.successor_account_id.is_none() {
            response.successor_account_id = successor;
        }
    }
    if root_successor.is_some() {
        response.successor_account_id = root_successor;
    }
    if space.is_root && !targets.is_empty() {
        query(
            "UPDATE cloud_group_invitations SET revoked_at = $3 \
             WHERE inviter_account_id = $1 AND group_space_id = $2 AND revoked_at IS NULL",
        )
        .bind(account_id)
        .bind(&space.root)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&mut *transaction)
        .await?;
    }
    record_operation(
        &mut transaction,
        account_id,
        request.client_operation_id,
        LEAVE_OPERATION,
        &request_fingerprint,
        &response,
    )
    .await?;
    transaction.commit().await?;
    Ok(response)
}

/// Marks the caller as having left one conversation, hands ownership on when
/// needed, and tells every device. Returns the promoted owner, if any.
async fn leave_one(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    hint: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let (role,): (String,) = query_as(
        "SELECT role FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(&mut **transaction)
    .await?;
    query(
        "UPDATE cloud_chat_conversation_members \
         SET membership_state = 'left', left_at = now(), role = 'member', version = version + 1 \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    let successor = if role == "owner" {
        promote_successor(transaction, conversation_id, hint).await?
    } else {
        None
    };
    let (version,): (i32,) = query_as(
        "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now() \
         WHERE conversation_id = $1 RETURNING version",
    )
    .bind(conversation_id)
    .fetch_one(&mut **transaction)
    .await?;
    insert_sync_event(
        transaction,
        account_id,
        "membership.removed",
        Some(conversation_id),
        Some(conversation_id),
        Some(version),
        &json!({
            "conversation_id": conversation_id,
            "account_id": account_id,
            "membership_state": "left",
            "version": version,
        }),
    )
    .await?;
    for member in active_member_ids(transaction, conversation_id).await? {
        let projection = load_conversation(transaction, conversation_id, &member).await?;
        insert_sync_event(
            transaction,
            &member,
            "membership.updated",
            Some(conversation_id),
            Some(conversation_id),
            Some(projection.version),
            &json!({ "conversation": projection }),
        )
        .await?;
    }
    Ok(successor)
}

/// Makes another person the owner when no active person owns the
/// conversation any more: the suggested member when they are active,
/// otherwise an admin, otherwise the earliest member to join.
async fn promote_successor(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    hint: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let service_members = service_member_ids();
    let candidate: Option<(String, bool)> = query_as(
        "SELECT member.account_id, EXISTS ( \
                  SELECT 1 FROM cloud_chat_conversation_members owner \
                  WHERE owner.conversation_id = $1 AND owner.membership_state = 'active' \
                    AND owner.role = 'owner' AND NOT (owner.account_id = ANY($2))) \
         FROM cloud_chat_conversation_members member \
         WHERE member.conversation_id = $1 AND member.membership_state = 'active' \
           AND NOT (member.account_id = ANY($2)) \
         ORDER BY COALESCE(member.account_id = $3, FALSE) DESC, \
                  (member.role IN ('owner', 'admin')) DESC, \
                  member.joined_at ASC, member.account_id ASC \
         LIMIT 1",
    )
    .bind(conversation_id)
    .bind(&service_members)
    .bind(hint)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((successor, owner_remains)) = candidate else {
        return Ok(None);
    };
    if owner_remains {
        return Ok(None);
    }
    query(
        "UPDATE cloud_chat_conversation_members \
         SET role = 'owner', version = version + 1 \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(&successor)
    .execute(&mut **transaction)
    .await?;
    Ok(Some(successor))
}

#[cfg(test)]
mod tests;
