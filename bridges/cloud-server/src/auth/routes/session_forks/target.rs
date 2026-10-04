//! Which session ids a fork may claim.
//!
//! Registering a fork copies the parent's task and artifact activity into the
//! fork id, and every member of a conversation under that id sees those rows.
//! A fork therefore claims only an id that is the forker's own: a new id with
//! no conversation and no activity that anyone else recorded, or an Agent
//! conversation the forker created and is the only active member of.
//!
//! Ids of chats between people, groups, and an account's own chats can be
//! worked out from account ids, so a fork never claims them. Otherwise anyone
//! could add rows to another person's chat, or register two people's future
//! direct chat as a fork so that it could never open.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::store::{advisory_session_lock, StoreError};

const RESERVED_PREFIXES: [&str; 6] = [
    "session:direct-person:",
    "session:direct-agent:",
    "session:direct-system-agent:",
    "session:group:",
    "session:self-agent:",
    "session:scheduled:",
];

/// Whether `fork_session_id` uses an id form that a fork never claims.
pub(super) fn reserved(fork_session_id: &str) -> bool {
    RESERVED_PREFIXES
        .iter()
        .any(|prefix| fork_session_id.starts_with(prefix))
}

pub(super) enum Registration {
    Registered,
    /// A fork with this id was registered before.
    Exists,
    /// The id names a conversation or activity that is not the forker's.
    NotOwned,
}

/// Records the fork if `fork_session_id` is the forker's own. Conversation
/// creation takes the same per-session lock, so the id cannot gain a
/// conversation between the check and the insert.
pub(super) async fn register(
    pool: &PgPool,
    account_id: &str,
    fork_session_id: &str,
    parent_session_id: &str,
    parent_message_id: Option<&str>,
    created_at: &str,
) -> Result<Registration, StoreError> {
    let mut transaction = pool.begin().await?;
    advisory_session_lock(&mut transaction, fork_session_id).await?;
    let (owned,): (bool,) = query_as(
        "SELECT CASE WHEN EXISTS (SELECT 1 FROM cloud_chat_conversations \
                                  WHERE legacy_session_id = $1 OR conversation_id = $3) \
          THEN EXISTS (SELECT 1 FROM cloud_chat_conversations conversation \
                       WHERE (conversation.legacy_session_id = $1 OR conversation.conversation_id = $3) \
                         AND conversation.kind = 'ai' \
                         AND conversation.created_by_account_id = $2 \
                         AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                                     WHERE member.conversation_id = conversation.conversation_id \
                                       AND member.account_id = $2 \
                                       AND member.membership_state = 'active') \
                         AND NOT EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                                         WHERE member.conversation_id = conversation.conversation_id \
                                           AND member.account_id <> $2 \
                                           AND member.membership_state = 'active')) \
          ELSE NOT EXISTS (SELECT 1 FROM cloud_session_tasks \
                           WHERE session_id = $1 AND created_by_account_id <> $2) \
           AND NOT EXISTS (SELECT 1 FROM cloud_session_artifacts \
                           WHERE session_id = $1 AND created_by_account_id <> $2) END",
    )
    .bind(fork_session_id)
    .bind(account_id)
    .bind(Uuid::parse_str(fork_session_id).ok())
    .fetch_one(&mut *transaction)
    .await?;
    if !owned {
        return Ok(Registration::NotOwned);
    }
    let inserted = query(
        "INSERT INTO cloud_session_forks \
         (fork_session_id, parent_session_id, parent_message_id, created_by_account_id, created_at) \
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (fork_session_id) DO NOTHING",
    )
    .bind(fork_session_id)
    .bind(parent_session_id)
    .bind(parent_message_id)
    .bind(account_id)
    .bind(created_at)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    transaction.commit().await?;
    Ok(if inserted == 1 {
        Registration::Registered
    } else {
        Registration::Exists
    })
}

#[cfg(test)]
mod tests {
    use super::reserved;

    #[test]
    fn forks_never_claim_ids_derived_from_accounts() {
        for id in [
            "session:direct-person:acct_a:acct_b",
            "session:direct-agent:acct_a:cloud-agent:acct_a",
            "session:direct-system-agent:acct_a:support",
            "session:group:space",
            "session:self-agent:acct_a:default",
            "session:self-agent:default",
            "session:scheduled:acct_a",
        ] {
            assert!(reserved(id), "{id}");
        }
        for id in [
            "session:fork:3f2a0c4e9b1d4c7a8e6f5a4b3c2d1e0f",
            "0b9e3d6a-2f4c-4e8b-9a1d-7c5e3b2a1f0d",
        ] {
            assert!(!reserved(id), "{id}");
        }
    }
}
