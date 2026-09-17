//! Server-managed members, such as PiP, belong to a conversation without being
//! one of its people. Clients never list them, so member lists that clients
//! send are compared, replaced, and counted as if they were not there, and a
//! client can never remove one.

use super::support::*;
use super::*;

pub(super) fn is_service_member(account_id: &str) -> bool {
    crate::pip::service_account_id() == Some(account_id)
}

pub(super) fn service_member_ids() -> Vec<String> {
    crate::pip::service_account_id()
        .into_iter()
        .map(str::to_string)
        .collect()
}

pub(super) fn without_service_members(mut account_ids: Vec<String>) -> Vec<String> {
    account_ids.retain(|account_id| !is_service_member(account_id));
    account_ids
}

/// Adds a server-managed member to a conversation of one of `kinds` and tells
/// every member's devices, as an accepted invitation does. Returns whether a
/// new active membership was created.
pub async fn join_service_member(
    pool: &PgPool,
    conversation_id: Uuid,
    service_account_id: &str,
    kinds: &[&str],
) -> Result<bool, StoreError> {
    let mut transaction = pool.begin().await?;
    let kind: Option<(String,)> =
        query_as("SELECT kind FROM cloud_chat_conversations WHERE conversation_id = $1 FOR UPDATE")
            .bind(conversation_id)
            .fetch_optional(&mut *transaction)
            .await?;
    let Some((kind,)) = kind else {
        return Ok(false);
    };
    if !kinds.contains(&kind.as_str()) {
        return Ok(false);
    }
    let inserted = query(
        "INSERT INTO cloud_chat_conversation_members
             (conversation_id, account_id, role, membership_state)
         VALUES ($1, $2, 'member', 'active')
         ON CONFLICT (conversation_id, account_id) DO UPDATE SET
             membership_state = 'active', left_at = NULL,
             version = cloud_chat_conversation_members.version + 1
         WHERE cloud_chat_conversation_members.membership_state <> 'active'",
    )
    .bind(conversation_id)
    .bind(service_account_id)
    .execute(&mut *transaction)
    .await?
    .rows_affected()
        > 0;
    if !inserted {
        transaction.commit().await?;
        return Ok(false);
    }
    query(
        "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now()
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .execute(&mut *transaction)
    .await?;
    for recipient in active_member_ids(&mut transaction, conversation_id).await? {
        if recipient == service_account_id {
            continue;
        }
        let projection = load_conversation(&mut transaction, conversation_id, &recipient).await?;
        insert_sync_event(
            &mut transaction,
            &recipient,
            "membership.updated",
            Some(conversation_id),
            Some(conversation_id),
            Some(projection.version),
            &json!({ "conversation": projection }),
        )
        .await?;
    }
    transaction.commit().await?;
    Ok(true)
}
