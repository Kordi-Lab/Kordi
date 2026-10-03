//! Server-managed members, such as PiP, belong to a conversation without being
//! one of its people. Clients never list them, so member lists that clients
//! send are compared, replaced, and counted as if they were not there, and a
//! client can never remove one; only the conversation's AI access setting can.

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
///
/// The member joins only while the conversation's AI access setting turns it
/// on (`cloud_chat_ai_policies.pip_enabled`; a missing row means off). The
/// setting is read after the conversation row is locked, and every change to
/// it locks that row first, so a change that turns it off either commits
/// before this read, and nothing joins, or waits for this join and then
/// removes the member.
///
/// The member's reading position (`cloud_pip_conversation_state`; PiP is the
/// only server-managed member) moves to the newest message in the same
/// transaction, so the PiP sweep never sees the new membership with a position
/// from before it joined, or from an earlier membership on a rejoin. PiP never
/// reads history from before it joined or messages from while it was off.
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
    let (turned_on,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_chat_ai_policies
                        WHERE conversation_id = $1 AND pip_enabled)",
    )
    .bind(conversation_id)
    .fetch_one(&mut *transaction)
    .await?;
    if !turned_on {
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
    query(
        "INSERT INTO cloud_pip_conversation_state
             (conversation_id, seen_sequence, context_start_sequence)
         SELECT conversation_id, latest_message_sequence, latest_message_sequence
         FROM cloud_chat_conversations
         WHERE conversation_id = $1
         ON CONFLICT (conversation_id) DO UPDATE SET
             seen_sequence = EXCLUDED.seen_sequence,
             context_start_sequence = EXCLUDED.context_start_sequence,
             updated_at = now()",
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

/// Removes a server-managed member inside the caller's transaction and tells
/// the remaining members' devices. Returns whether an active membership ended.
pub async fn leave_service_member(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    service_account_id: &str,
) -> Result<bool, StoreError> {
    let removed = query(
        "UPDATE cloud_chat_conversation_members
         SET membership_state = 'removed', left_at = now(), version = version + 1
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(service_account_id)
    .execute(&mut **transaction)
    .await?
    .rows_affected()
        > 0;
    if !removed {
        return Ok(false);
    }
    query(
        "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now()
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .execute(&mut **transaction)
    .await?;
    for (recipient, projection) in
        load_active_conversation_projections(transaction, conversation_id).await?
    {
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
    Ok(true)
}

/// `leave_service_member` in a transaction of its own.
pub async fn leave_service_member_now(
    pool: &PgPool,
    conversation_id: Uuid,
    service_account_id: &str,
) -> Result<bool, StoreError> {
    let mut transaction = pool.begin().await?;
    let removed =
        leave_service_member(&mut transaction, conversation_id, service_account_id).await?;
    transaction.commit().await?;
    Ok(removed)
}
