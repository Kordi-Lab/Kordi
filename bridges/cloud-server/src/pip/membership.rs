//! PiP is a member of a group only while the group's AI access setting says so
//! (`cloud_chat_ai_policies.pip_enabled`). Startup reconciles membership with
//! the setting, which also repairs a rollback to a server that joined PiP to
//! every group.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

/// Conversation kinds PiP joins automatically. Direct and AI sessions are
/// deliberately excluded until both clients render a third member there.
pub const PIP_CONVERSATION_KINDS: &[&str] = &["group"];

/// Adds PiP to one conversation whose AI access setting turns PiP on; with
/// the setting off (or no setting row) nothing changes. Returns whether a new
/// membership was created.
/// Members' devices hear about it through `membership.updated`, and PiP starts
/// reading at the conversation's newest message on every join, in the same
/// transaction that commits the membership, so neither history from before PiP
/// joined nor messages from while it was off are ever read.
pub async fn join_conversation(
    pool: &PgPool,
    pip_account_id: &str,
    conversation_id: Uuid,
) -> Result<bool, sqlx_core::Error> {
    crate::chat_sync::store::join_service_member(
        pool,
        conversation_id,
        pip_account_id,
        PIP_CONVERSATION_KINDS,
    )
    .await
    .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))
}

/// What startup reconciliation changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reconciled {
    /// Groups without a setting row, now recorded as they were.
    pub grandfathered: u64,
    pub joined: u64,
    pub left: u64,
}

/// Makes PiP's group memberships match each group's setting:
/// 1. groups with no setting row (created by an older server during a
///    rollout) keep PiP exactly as they have it now;
/// 2. PiP leaves groups where the setting is off;
/// 3. PiP joins groups where the setting is on.
pub async fn reconcile_groups(
    pool: &PgPool,
    pip_account_id: &str,
) -> Result<Reconciled, sqlx_core::Error> {
    let grandfathered = query(
        "INSERT INTO cloud_chat_ai_policies (conversation_id, history_scope, pip_enabled)
         SELECT conversation.conversation_id, 'mentions', EXISTS (
             SELECT 1 FROM cloud_chat_conversation_members member
             WHERE member.conversation_id = conversation.conversation_id
               AND member.account_id = $1 AND member.membership_state = 'active')
         FROM cloud_chat_conversations conversation
         WHERE conversation.kind = ANY($2)
         ON CONFLICT (conversation_id) DO NOTHING",
    )
    .bind(pip_account_id)
    .bind(PIP_CONVERSATION_KINDS)
    .execute(pool)
    .await?
    .rows_affected();
    let mut reconciled = Reconciled {
        grandfathered,
        ..Reconciled::default()
    };
    for (conversation_id, enabled) in mismatched_groups(pool, pip_account_id).await? {
        if enabled {
            if join_conversation(pool, pip_account_id, conversation_id).await? {
                reconciled.joined += 1;
            }
        } else if crate::chat_sync::store::leave_service_member_now(
            pool,
            conversation_id,
            pip_account_id,
        )
        .await
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?
        {
            reconciled.left += 1;
        }
    }
    Ok(reconciled)
}

/// The groups whose setting row and PiP membership disagree, each with its
/// setting: what [`reconcile_groups`] joins (`true`) or leaves (`false`).
pub(crate) async fn mismatched_groups(
    pool: &PgPool,
    pip_account_id: &str,
) -> Result<Vec<(Uuid, bool)>, sqlx_core::Error> {
    query_as(
        "SELECT policy.conversation_id, policy.pip_enabled
         FROM cloud_chat_ai_policies policy
         JOIN cloud_chat_conversations conversation
           ON conversation.conversation_id = policy.conversation_id
         WHERE conversation.kind = ANY($2)
           AND policy.pip_enabled <> EXISTS (
               SELECT 1 FROM cloud_chat_conversation_members member
               WHERE member.conversation_id = policy.conversation_id
                 AND member.account_id = $1 AND member.membership_state = 'active')
         ORDER BY policy.conversation_id",
    )
    .bind(pip_account_id)
    .bind(PIP_CONVERSATION_KINDS)
    .fetch_all(pool)
    .await
}
