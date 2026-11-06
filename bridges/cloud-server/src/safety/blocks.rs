//! Block checks shared by every route that lets one account reach another.
//!
//! A block in either direction stops direct messages, contact requests,
//! group adds, invite-link joins between the two, calls, and Common Ground
//! invitations. Each check reads `cloud_account_blocks` directly, so it holds
//! for one-way contact rows and existing direct conversations alike.

use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::chat_sync::store::StoreError;

/// Whether either account blocked the other.
pub async fn blocked_either_way<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    a: &str,
    b: &str,
) -> Result<bool, sqlx_core::Error> {
    query_as::<_, (bool,)>("SELECT cloud_accounts_blocked_either_way($1, $2)")
        .bind(a)
        .bind(b)
        .fetch_one(executor)
        .await
        .map(|(value,)| value)
}

/// Both block directions in one read: `(a blocked b, b blocked a)`.
pub async fn blocks_between<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    a: &str,
    b: &str,
) -> Result<(bool, bool), sqlx_core::Error> {
    query_as(
        "SELECT \
           EXISTS (SELECT 1 FROM cloud_account_blocks \
                   WHERE blocker_account_id = $1 AND blocked_account_id = $2), \
           EXISTS (SELECT 1 FROM cloud_account_blocks \
                   WHERE blocker_account_id = $2 AND blocked_account_id = $1)",
    )
    .bind(a)
    .bind(b)
    .fetch_one(executor)
    .await
}

/// Whether `account` and any of `others` blocked each other, in either
/// direction.
pub async fn any_blocked<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    account: &str,
    others: &[String],
) -> Result<bool, sqlx_core::Error> {
    if others.is_empty() {
        return Ok(false);
    }
    query_as::<_, (bool,)>(
        "SELECT EXISTS (SELECT 1 FROM cloud_account_blocks \
         WHERE (blocker_account_id = $1 AND blocked_account_id = ANY($2)) \
            OR (blocked_account_id = $1 AND blocker_account_id = ANY($2)))",
    )
    .bind(account)
    .bind(others)
    .fetch_one(executor)
    .await
    .map(|(value,)| value)
}

/// Whether `account` may not write in `conversation_id` because it is a
/// direct or AI conversation and another active member blocked it, or it
/// blocked another active member. Groups always pass: a block never removes
/// anyone from a shared group.
pub async fn blocked_in_direct_conversation<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    conversation_id: Uuid,
    account: &str,
) -> Result<bool, sqlx_core::Error> {
    query_as::<_, (bool,)>(
        "SELECT EXISTS ( \
           SELECT 1 FROM cloud_chat_conversations conversation \
           JOIN cloud_chat_conversation_members other \
             ON other.conversation_id = conversation.conversation_id \
           WHERE conversation.conversation_id = $1 \
             AND conversation.kind IN ('direct', 'ai') \
             AND other.account_id <> $2 \
             AND other.membership_state = 'active' \
             AND cloud_accounts_blocked_either_way($2, other.account_id))",
    )
    .bind(conversation_id)
    .bind(account)
    .fetch_one(executor)
    .await
    .map(|(value,)| value)
}

/// [`blocked_in_direct_conversation`] as a chat store check. Removing a
/// contact keeps the direct conversation, so contact rows alone cannot stop a
/// blocked person from writing there.
pub(crate) async fn refuse_blocked_direct(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), StoreError> {
    if blocked_in_direct_conversation(&mut **transaction, conversation_id, account_id).await? {
        return Err(StoreError::Blocked);
    }
    Ok(())
}

/// [`any_blocked`] as a chat store check, for new conversations and group
/// adds.
pub(crate) async fn refuse_blocked_peers(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    peers: &[String],
) -> Result<(), StoreError> {
    if any_blocked(&mut **transaction, account_id, peers).await? {
        return Err(StoreError::Blocked);
    }
    Ok(())
}

/// Serializes every relationship decision about one unordered pair (a block,
/// an unblock, accepting a contact request) until the transaction ends. The
/// key does not depend on argument order.
pub async fn lock_pair(
    transaction: &mut Transaction<'_, Postgres>,
    a: &str,
    b: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "SELECT pg_advisory_xact_lock(hashtextextended(\
         'contact-pair:' || least($1::TEXT, $2::TEXT) || ':' || greatest($1::TEXT, $2::TEXT), 0))",
    )
    .bind(a)
    .bind(b)
    .execute(&mut **transaction)
    .await
    .map(|_| ())
}
