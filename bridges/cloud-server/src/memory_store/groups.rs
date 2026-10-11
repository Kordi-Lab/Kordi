//! Group memories are shared by the group (#1710).
//!
//! A `group` memory's scope id is the group conversation id. Every active
//! member of that group lists it, reads it in agent runs, and may edit or
//! delete it, whoever saved it. The saver stays the owner, so "Forget
//! everything" only removes the memories an account saved itself.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{MemoryError, MemoryResult};

/// SQL condition true when `$account` is an active member of the group whose
/// id is the text expression `scope_id_expr`.
pub(super) fn active_member_condition(scope_id_expr: &str, account_param: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
           JOIN cloud_chat_conversations conversation \
             ON conversation.conversation_id = member.conversation_id \
           WHERE conversation.kind = 'group' \
             AND member.conversation_id::text = {scope_id_expr} \
             AND member.account_id = {account_param} \
             AND member.membership_state = 'active')"
    )
}

/// Whether the account is an active member of the group. An id that is not a
/// uuid is never a group, so the answer is simply no.
pub(crate) async fn is_active_group_member(
    pool: &PgPool,
    account_id: &str,
    group_id: &str,
) -> MemoryResult<bool> {
    let Ok(group_id) = uuid::Uuid::parse_str(group_id) else {
        return Ok(false);
    };
    let (member,): (bool,) = query_as(&format!("SELECT {}", active_member_condition("$1", "$2")))
        .bind(group_id.to_string())
        .bind(account_id)
        .fetch_one(pool)
        .await?;
    Ok(member)
}

/// Checks that the account may edit or delete a live memory: its owner, or an
/// active member of the group for a group memory. A memory the account cannot
/// see is not found; a group memory of a group the account is not in is
/// `not_a_group_member`.
pub(super) async fn authorize_change(
    pool: &PgPool,
    account_id: &str,
    memory_id: &str,
) -> MemoryResult<(String, String)> {
    let current: Option<(String, String, String)> = query_as(
        "SELECT owner_account_id, scope, scope_id FROM cloud_account_memories \
         WHERE memory_id = $1 AND archived_at IS NULL",
    )
    .bind(memory_id)
    .fetch_optional(pool)
    .await?;
    let (owner, scope, scope_id) = current.ok_or_else(MemoryError::not_found)?;
    if owner == account_id {
        return Ok((scope, scope_id));
    }
    if scope != "group" {
        return Err(MemoryError::not_found());
    }
    if !is_active_group_member(pool, account_id, &scope_id).await? {
        return Err(MemoryError::not_a_group_member());
    }
    Ok((scope, scope_id))
}
