//! PiP is a standing member of every group conversation. Membership is not a
//! setting: it is added at creation and backfilled at startup.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

/// Conversation kinds PiP joins automatically. Direct and AI sessions are
/// deliberately excluded until both clients render a third member there.
pub const PIP_CONVERSATION_KINDS: &[&str] = &["group"];

/// Adds PiP to one conversation. Returns whether a new membership was created.
/// Bumps the conversation version so synchronized clients refresh the member
/// list on their next pull.
pub async fn join_conversation(
    pool: &PgPool,
    pip_account_id: &str,
    conversation_id: Uuid,
) -> Result<bool, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let kind: Option<(String,)> =
        query_as("SELECT kind FROM cloud_chat_conversations WHERE conversation_id = $1 FOR UPDATE")
            .bind(conversation_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((kind,)) = kind else {
        return Ok(false);
    };
    if !PIP_CONVERSATION_KINDS.contains(&kind.as_str()) {
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
    .bind(pip_account_id)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        > 0;
    if inserted {
        query(
            "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now()
             WHERE conversation_id = $1",
        )
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
        query(
            "INSERT INTO cloud_pip_conversation_state (conversation_id) VALUES ($1)
             ON CONFLICT (conversation_id) DO NOTHING",
        )
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(inserted)
}

/// Backfills PiP into every existing conversation of a supported kind.
pub async fn join_all_groups(pool: &PgPool, pip_account_id: &str) -> Result<u64, sqlx_core::Error> {
    let missing: Vec<(Uuid,)> = query_as(
        "SELECT conversation.conversation_id
         FROM cloud_chat_conversations conversation
         WHERE conversation.kind = ANY($2)
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
