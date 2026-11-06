//! Per-person permissions (docs/contact-permissions.md).
//!
//! An owner may stop one other account (the subject) from using the owner's
//! agents (`agent_access`) or from seeing the owner's Grounding card
//! (`card_access`). Both default to allowed: a missing row allows both.
//! Rows are keyed by account, so removing and re-adding a contact keeps
//! them, and they are one-directional. They are private: a restricted
//! subject gets the same answers as for an owner with no card, or the
//! generic agent refusal, never a sign of the restriction.

mod routes;
#[cfg(test)]
mod tests;

use std::collections::HashSet;

use serde::Serialize;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

pub use routes::routes;

/// Advertised as `contactPermissionsVersion` in the auth capabilities.
pub const CONTACT_PERMISSIONS_VERSION: u32 = 1;

/// The error code and message every refused agent request gets. It is the
/// same refusal as for any other agent the requester may not use, so it
/// never tells a restricted person about the restriction.
pub(crate) const AGENT_REFUSAL_CODE: &str = "agent_not_available";
pub(crate) const AGENT_REFUSAL_MESSAGE: &str = "This agent isn't available.";

/// What `owner` allows one subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    pub agent_access: bool,
    pub card_access: bool,
}

impl Default for Permissions {
    fn default() -> Self {
        Self {
            agent_access: true,
            card_access: true,
        }
    }
}

/// SQL that is true unless the account in `owner` stopped the account in
/// `subject` (both SQL expressions) from using its agents. True for an
/// account and itself.
pub(crate) fn agent_allowed_sql(owner: &str, subject: &str) -> String {
    restriction_sql(owner, subject, "agent_access")
}

/// SQL that is true unless the account in `owner` stopped the account in
/// `viewer` (both SQL expressions) from seeing its card. True for an
/// account and itself.
pub(crate) fn card_allowed_sql(owner: &str, viewer: &str) -> String {
    restriction_sql(owner, viewer, "card_access")
}

fn restriction_sql(owner: &str, subject: &str, column: &str) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM cloud_contact_permissions contact_restriction
                     WHERE contact_restriction.owner_account_id = {owner}
                       AND contact_restriction.subject_account_id = {subject}
                       AND NOT contact_restriction.{column})"
    )
}

async fn allowed<'e, E>(
    executor: E,
    condition: String,
    owner: &str,
    subject: &str,
) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    if owner.trim() == subject.trim() {
        return Ok(true);
    }
    let (allowed,): (bool,) = query_as(&format!("SELECT {condition}"))
        .bind(owner.trim())
        .bind(subject.trim())
        .fetch_one(executor)
        .await?;
    Ok(allowed)
}

/// Whether `subject` may use `owner`'s agents.
pub(crate) async fn agent_allowed<'e, E>(
    executor: E,
    owner: &str,
    subject: &str,
) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    allowed(executor, agent_allowed_sql("$1", "$2"), owner, subject).await
}

/// Whether `viewer` may see `owner`'s card.
pub(crate) async fn card_allowed<'e, E>(
    executor: E,
    owner: &str,
    viewer: &str,
) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    allowed(executor, card_allowed_sql("$1", "$2"), owner, viewer).await
}

/// The accounts among `owners` that stopped `viewer` from seeing their card.
pub(crate) async fn card_hidden_owners(
    pool: &PgPool,
    viewer: &str,
    owners: &[String],
) -> sqlx_core::Result<HashSet<String>> {
    if owners.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<(String,)> = query_as(
        "SELECT owner_account_id FROM cloud_contact_permissions
         WHERE subject_account_id = $1 AND owner_account_id = ANY($2) AND NOT card_access",
    )
    .bind(viewer)
    .bind(owners)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(owner,)| owner).collect())
}

/// Whether any of `accounts` stopped another of them from seeing their
/// card: a message every one of them reads must then quote no card.
pub(crate) async fn card_restricted_among(
    pool: &PgPool,
    accounts: &[String],
) -> sqlx_core::Result<bool> {
    if accounts.len() < 2 {
        return Ok(false);
    }
    let (restricted,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_contact_permissions
                        WHERE owner_account_id = ANY($1) AND subject_account_id = ANY($1)
                          AND NOT card_access)",
    )
    .bind(accounts)
    .fetch_one(pool)
    .await?;
    Ok(restricted)
}

/// What `owner` allows `subject`; both allowed without a row.
pub(crate) async fn load(
    pool: &PgPool,
    owner: &str,
    subject: &str,
) -> sqlx_core::Result<Permissions> {
    let row: Option<(bool, bool)> = query_as(
        "SELECT agent_access, card_access FROM cloud_contact_permissions
         WHERE owner_account_id = $1 AND subject_account_id = $2",
    )
    .bind(owner)
    .bind(subject)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .map(|(agent_access, card_access)| Permissions {
            agent_access,
            card_access,
        })
        .unwrap_or_default())
}
