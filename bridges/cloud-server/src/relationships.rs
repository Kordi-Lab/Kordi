//! Consent between two accounts.
//!
//! A `cloud_contacts(account_id = A, peer_account_id = B)` row records that A
//! accepted B. Two accounts are contacts only when both rows exist and neither
//! has blocked the other; a single row grants nothing. The SQL functions from
//! migration 0110 hold that rule, so queries and this module always agree.
//!
//! Every change to one pair (accepting, rejecting, or withdrawing a request,
//! removing a contact, blocking) takes [`lock_pair`] first, so two decisions
//! about the same two accounts never interleave.

use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;
use uuid::Uuid;

use crate::server::ServerState;

/// Whether `a` and `b` accepted each other and neither blocked the other.
pub async fn are_contacts<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    a: &str,
    b: &str,
) -> Result<bool, sqlx_core::Error> {
    query_as::<_, (bool,)>("SELECT cloud_accounts_are_contacts($1, $2)")
        .bind(a)
        .bind(b)
        .fetch_one(executor)
        .await
        .map(|(value,)| value)
}

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

/// Whether `blocker` blocked `blocked` (one direction only).
pub async fn has_blocked<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    blocker: &str,
    blocked: &str,
) -> Result<bool, sqlx_core::Error> {
    query_as::<_, (bool,)>(
        "SELECT EXISTS (SELECT 1 FROM cloud_account_blocks \
         WHERE blocker_account_id = $1 AND blocked_account_id = $2)",
    )
    .bind(blocker)
    .bind(blocked)
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

/// Whether consent lets `account_id` write in `conversation_id`. Only
/// conversations that are not groups (`direct` and `ai`) need it: nobody can
/// leave them, so every other active person there must be a contact of
/// `account_id`. Kordi service accounts (PiP and Kordi Support, which own
/// system-managed agents) need no contact on either side. The exemption
/// follows membership, never the client-chosen session id. Groups and unknown
/// conversations pass; membership itself is checked elsewhere.
pub async fn may_write_outside_groups<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let service_ids: Vec<String> = crate::pip::service_account_id()
        .into_iter()
        .map(str::to_string)
        .collect();
    query_as::<_, (bool,)>(
        "SELECT cloud_account_is_service($2) OR NOT EXISTS ( \
           SELECT 1 FROM cloud_chat_conversations conversation \
           JOIN cloud_chat_conversation_members other \
             ON other.conversation_id = conversation.conversation_id \
           WHERE conversation.conversation_id = $1 \
             AND conversation.kind IN ('direct', 'ai') \
             AND other.account_id <> $2 \
             AND other.membership_state = 'active' \
             AND NOT (other.account_id = ANY($3)) \
             AND NOT cloud_account_is_service(other.account_id) \
             AND NOT cloud_accounts_are_contacts($2, other.account_id))",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(service_ids)
    .fetch_one(executor)
    .await
    .map(|(value,)| value)
}

/// Serializes every relationship decision about one unordered pair until the
/// transaction ends. The key does not depend on argument order.
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

/// Deletes both contact rows of a pair. Returns whether both directions
/// existed, that is, whether the two accounts had accepted each other.
pub async fn delete_contact_pair(
    transaction: &mut Transaction<'_, Postgres>,
    a: &str,
    b: &str,
) -> Result<bool, sqlx_core::Error> {
    let deleted = query(
        "DELETE FROM cloud_contacts \
         WHERE (account_id = $1 AND peer_account_id = $2) \
            OR (account_id = $2 AND peer_account_id = $1)",
    )
    .bind(a)
    .bind(b)
    .execute(&mut **transaction)
    .await?
    .rows_affected();
    Ok(a != b && deleted == 2)
}

/// Kordi service accounts (PiP, the support owner, and any other owner of a
/// system-managed agent) cannot be blocked.
pub async fn is_service_account(
    state: &ServerState,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    if crate::pip::service_account_id() == Some(account_id)
        || state
            .support()
            .is_some_and(|support| support.config().owner_account_id == account_id)
    {
        return Ok(true);
    }
    query_as::<_, (bool,)>("SELECT cloud_account_is_service($1)")
        .bind(account_id)
        .fetch_one(state.db_pool())
        .await
        .map(|(value,)| value)
}
