//! Handing a group to another member. The current owner becomes an admin and
//! the new owner takes the owner role. If the group's organization requires
//! member owners and the new owner is not a member, the 0166 trigger moves
//! the group to the new owner's personal organization; everyone stays in the
//! group either way.

use serde::{Deserialize, Serialize};

use super::service_members::is_service_member;
use super::support::*;
use super::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TransferGroupOwnerRequest {
    pub client_operation_id: Uuid,
    pub account_id: String,
}

#[derive(Serialize)]
struct OwnerIntent<'a> {
    conversation_id: Uuid,
    account_id: &'a str,
}

const OPERATION: &str = "conversation.owner.transfer";

pub async fn transfer_group_owner(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
    request: TransferGroupOwnerRequest,
) -> Result<ConversationSnapshot, StoreError> {
    let new_owner = request.account_id.trim();
    let request_fingerprint = fingerprint(&OwnerIntent {
        conversation_id,
        account_id: new_owner,
    })?;
    let mut transaction = pool.begin().await?;
    advisory_operation_lock(&mut transaction, account_id, request.client_operation_id).await?;
    if let Some(existing) = existing_operation::<ConversationSnapshot>(
        &mut transaction,
        account_id,
        request.client_operation_id,
        OPERATION,
        &request_fingerprint,
    )
    .await?
    {
        transaction.commit().await?;
        return Ok(existing);
    }
    let authorization: Option<(String, String)> = query_as(
        "SELECT conversation.kind, member.role \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = conversation.conversation_id \
         WHERE conversation.conversation_id = $1 AND member.account_id = $2 \
           AND member.membership_state = 'active' \
         FOR UPDATE OF conversation",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((kind, role)) = authorization else {
        return Err(StoreError::Forbidden);
    };
    if kind != "group" || role != "owner" {
        return Err(StoreError::Forbidden);
    }
    if new_owner == account_id
        || is_service_member(new_owner)
        || !active_member_ids(&mut transaction, conversation_id)
            .await?
            .iter()
            .any(|member| member == new_owner)
    {
        return Err(StoreError::InvalidInput(
            "the new owner must be another member of the group",
        ));
    }
    // Demote first, so the group has one owner when the trigger checks it.
    for (member, role) in [(account_id, "admin"), (new_owner, "owner")] {
        query(
            "UPDATE cloud_chat_conversation_members \
             SET role = $3, version = version + 1 \
             WHERE conversation_id = $1 AND account_id = $2",
        )
        .bind(conversation_id)
        .bind(member)
        .bind(role)
        .execute(&mut *transaction)
        .await?;
    }
    super::organization::announce_conversation_change(&mut transaction, conversation_id).await?;
    let conversation = load_conversation(&mut transaction, conversation_id, account_id).await?;
    record_operation(
        &mut transaction,
        account_id,
        request.client_operation_id,
        OPERATION,
        &request_fingerprint,
        &conversation,
    )
    .await?;
    transaction.commit().await?;
    Ok(conversation)
}
