//! PiP is a standing member of every group conversation except Grounding
//! groups, where notices come from System instead. Membership is not a
//! setting: it is added at creation and backfilled at startup.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

/// Conversation kinds PiP joins automatically. Direct and AI sessions are
/// deliberately excluded until both clients render a third member there.
pub const PIP_CONVERSATION_KINDS: &[&str] = &["group"];

/// Adds PiP to one conversation. Returns whether a new membership was created.
/// Members' devices hear about it through `membership.updated`, and PiP starts
/// reading at the conversation's newest message, so history from before PiP
/// joined is never treated as new.
pub async fn join_conversation(
    pool: &PgPool,
    pip_account_id: &str,
    conversation_id: Uuid,
) -> Result<bool, sqlx_core::Error> {
    let (room_group,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_common_ground_room_groups WHERE conversation_id = $1)",
    )
    .bind(conversation_id)
    .fetch_one(pool)
    .await?;
    if room_group {
        return Ok(false);
    }
    let inserted = crate::chat_sync::store::join_service_member(
        pool,
        conversation_id,
        pip_account_id,
        PIP_CONVERSATION_KINDS,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    if inserted {
        query(
            "INSERT INTO cloud_pip_conversation_state
                 (conversation_id, seen_sequence, context_start_sequence)
             SELECT conversation_id, latest_message_sequence, latest_message_sequence
             FROM cloud_chat_conversations
             WHERE conversation_id = $1
             ON CONFLICT (conversation_id) DO UPDATE SET
                 seen_sequence = GREATEST(cloud_pip_conversation_state.seen_sequence,
                                          EXCLUDED.seen_sequence),
                 updated_at = now()",
        )
        .bind(conversation_id)
        .execute(pool)
        .await?;
    }
    Ok(inserted)
}

/// Backfills PiP into every existing conversation of a supported kind,
/// except Grounding groups.
pub async fn join_all_groups(pool: &PgPool, pip_account_id: &str) -> Result<u64, sqlx_core::Error> {
    let missing: Vec<(Uuid,)> = query_as(
        "SELECT conversation.conversation_id
         FROM cloud_chat_conversations conversation
         WHERE conversation.kind = ANY($2)
           AND NOT EXISTS (
               SELECT 1 FROM cloud_common_ground_room_groups room_group
               WHERE room_group.conversation_id = conversation.conversation_id)
           AND NOT EXISTS (
               SELECT 1 FROM cloud_chat_conversation_members member
               WHERE member.conversation_id = conversation.conversation_id
                 AND member.account_id = $1
                 AND member.membership_state = 'active')",
    )
    .bind(pip_account_id)
    .bind(PIP_CONVERSATION_KINDS)
    .fetch_all(pool)
    .await?;
    let mut joined = 0;
    for (conversation_id,) in missing {
        if join_conversation(pool, pip_account_id, conversation_id).await? {
            joined += 1;
        }
    }
    Ok(joined)
}

/// Takes PiP out of every Grounding group it is still in, such as groups
/// started before System posted their notices. Members' devices hear about
/// it through `membership.updated`.
pub async fn leave_room_groups(
    pool: &PgPool,
    pip_account_id: &str,
) -> Result<u64, sqlx_core::Error> {
    let joined: Vec<(Uuid,)> = query_as(
        "SELECT DISTINCT member.conversation_id
         FROM cloud_chat_conversation_members member
         JOIN cloud_common_ground_room_groups room_group
           ON room_group.conversation_id = member.conversation_id
         WHERE member.account_id = $1 AND member.membership_state = 'active'",
    )
    .bind(pip_account_id)
    .fetch_all(pool)
    .await?;
    let mut left = 0;
    for (conversation_id,) in joined {
        let removed =
            crate::chat_sync::store::remove_service_member(pool, conversation_id, pip_account_id)
                .await
                .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
        if removed {
            left += 1;
        }
    }
    Ok(left)
}
