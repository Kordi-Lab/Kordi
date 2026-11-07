//! Leaving a group. The caller leaves every channel of the group space at
//! once: their membership becomes `left`, their devices drop each
//! conversation through `membership.removed`, and everyone who stays gets
//! the usual `conversation.updated`. "<Name> left the group" is posted in the
//! group's first conversation for everyone who stays.
//!
//! A group always keeps an admin: an owner or admin may leave only while
//! another person who stays is an owner or admin. An owner who leaves hands
//! each conversation to its longest-standing admin, else its
//! longest-standing member, as account deletion does. The last person in a
//! group cannot leave it; they dissolve it instead.
//!
//! Leaving again after leaving changes nothing and succeeds, so a client can
//! retry a request whose response it lost.

use super::dissolve::{group_channels, normalized_space};
use super::service_members::service_member_ids;
use super::*;

/// Error code when the caller is the group's last owner or admin.
pub const LAST_GROUP_ADMIN_CODE: &str = "last_group_admin";
/// Error code when the caller is the last person in the group.
pub const LAST_GROUP_MEMBER_CODE: &str = "last_group_member";

/// What a leave changed.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct LeaveOutcome {
    /// The group space, without its `group:` prefix.
    pub group_space_id: String,
    /// Conversations the caller left: empty when they had already left.
    pub conversation_ids: Vec<Uuid>,
}

/// Removes `account_id` from every channel of the group `group_space_id`.
pub async fn leave_group(
    pool: &PgPool,
    account_id: &str,
    group_space_id: &str,
) -> Result<LeaveOutcome, StoreError> {
    let space = normalized_space(group_space_id).ok_or(StoreError::NotFound)?;
    let mut outcome = LeaveOutcome {
        group_space_id: space.to_string(),
        conversation_ids: Vec::new(),
    };
    let mut transaction = pool.begin().await?;
    let channels = group_channels(&mut transaction, space).await?;
    let Some(&(authority, _)) = channels.first() else {
        return Err(StoreError::NotFound);
    };
    let membership: Option<(String, String)> = query_as(
        "SELECT role, membership_state FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(authority)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    let role = match membership {
        Some((role, state)) if state == "active" => role,
        Some((_, state)) if state == "left" => {
            transaction.commit().await?;
            return Ok(outcome);
        }
        _ => return Err(StoreError::Forbidden),
    };
    let others: Vec<(String,)> = query_as(
        "SELECT role FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id <> $2 AND membership_state = 'active' \
           AND NOT (account_id = ANY($3))",
    )
    .bind(authority)
    .bind(account_id)
    .bind(service_member_ids())
    .fetch_all(&mut *transaction)
    .await?;
    if others.is_empty() {
        return Err(StoreError::Conflict {
            code: LAST_GROUP_MEMBER_CODE,
            message: "You're the only person in this group. Dissolve it instead.",
        });
    }
    let is_admin = |role: &str| role == "owner" || role == "admin";
    if is_admin(role.as_str()) && !others.iter().any(|(other,)| is_admin(other.as_str())) {
        return Err(StoreError::Conflict {
            code: LAST_GROUP_ADMIN_CODE,
            message: "Make someone else an admin before leaving.",
        });
    }

    super::group_events::post_member_left(&mut transaction, authority, account_id).await?;
    for (conversation_id, _) in &channels {
        if leave_conversation(&mut transaction, *conversation_id, account_id).await? {
            outcome.conversation_ids.push(*conversation_id);
        }
    }
    // Their pin of the group goes with them.
    query(
        "DELETE FROM cloud_account_group_space_preferences \
         WHERE account_id = $1 AND group_space_id = ANY($2)",
    )
    .bind(account_id)
    .bind(vec![space.to_string(), format!("group:{space}")])
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(outcome)
}

/// Takes the caller out of one conversation. Returns whether they were in it.
async fn leave_conversation(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<bool, StoreError> {
    let role: Option<(String,)> = query_as(
        "SELECT role FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active' \
         FOR UPDATE",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((role,)) = role else {
        return Ok(false);
    };
    // They come back, if ever, as a member. Dropping the owner role first
    // keeps one owner at every step of a hand-over, as a transfer does.
    query(
        "UPDATE cloud_chat_conversation_members \
         SET membership_state = 'left', left_at = now(), role = 'member', version = version + 1 \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    if role == "owner" {
        hand_over(transaction, conversation_id).await?;
    }
    super::organization::announce_conversation_change(transaction, conversation_id).await?;
    let version: (i32,) =
        query_as("SELECT version FROM cloud_chat_conversations WHERE conversation_id = $1")
            .bind(conversation_id)
            .fetch_one(&mut **transaction)
            .await?;
    insert_sync_event(
        transaction,
        account_id,
        "membership.removed",
        Some(conversation_id),
        Some(conversation_id),
        Some(version.0),
        &json!({
            "conversation_id": conversation_id,
            "account_id": account_id,
            "membership_state": "left",
            "reason": "left",
            "version": version.0,
        }),
    )
    .await?;
    Ok(true)
}

/// Gives a conversation whose owner left to its longest-standing admin, else
/// its longest-standing member. A conversation that already has another
/// owner, or nobody left, stays as it is.
async fn hand_over(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
) -> Result<(), StoreError> {
    query(
        "UPDATE cloud_chat_conversation_members SET role = 'owner', version = version + 1 \
         WHERE conversation_id = $1 AND account_id = ( \
           SELECT account_id FROM cloud_chat_conversation_members \
           WHERE conversation_id = $1 AND membership_state = 'active' \
             AND NOT (account_id = ANY($2)) \
           ORDER BY (role = 'admin') DESC, joined_at ASC, account_id ASC \
           LIMIT 1) \
         AND NOT EXISTS ( \
           SELECT 1 FROM cloud_chat_conversation_members \
           WHERE conversation_id = $1 AND role = 'owner' AND membership_state = 'active')",
    )
    .bind(conversation_id)
    .bind(service_member_ids())
    .execute(&mut **transaction)
    .await?;
    Ok(())
}
