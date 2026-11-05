//! Choosing the organization that owns new content, shared by every writer
//! that lets a client name one (conversations, agents, scheduled tasks).
//!
//! A writer that names nothing leaves the column empty and the database
//! fills in the owner's personal organization (migration 0163). A named
//! organization must be one the owner belongs to; the check here gives a
//! clean error, and the trigger from migration 0166 refuses any writer that
//! skips it.

use sqlx_core::executor::Executor;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::handlers::valid_id;

/// Why a requested organization cannot own new content.
#[derive(Debug)]
pub enum SelectionError {
    /// The owner is not a member, or the organization does not exist. One
    /// answer for both, so the error reveals nothing about other teams.
    NotMember,
    Database(sqlx_core::Error),
}

impl From<sqlx_core::Error> for SelectionError {
    fn from(error: sqlx_core::Error) -> Self {
        if is_member_owner_violation(&error) {
            Self::NotMember
        } else {
            Self::Database(error)
        }
    }
}

/// Trims a requested organization id; blank means none.
pub fn requested(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

/// The organization to write for new content owned by `owner_account_id`:
/// `None` for the default, or `requested` when the owner is a member.
pub async fn for_new_content<'e, E>(
    executor: E,
    owner_account_id: &str,
    requested_id: Option<&str>,
) -> Result<Option<String>, SelectionError>
where
    E: Executor<'e, Database = Postgres>,
{
    let Some(organization_id) = requested(requested_id) else {
        return Ok(None);
    };
    if !valid_id(organization_id) {
        return Err(SelectionError::NotMember);
    }
    let (member,): (bool,) = query_as("SELECT cloud_is_organization_member($1, $2)")
        .bind(organization_id)
        .bind(owner_account_id)
        .fetch_one(executor)
        .await?;
    if member {
        Ok(Some(organization_id.to_string()))
    } else {
        Err(SelectionError::NotMember)
    }
}

/// Whether `error` is the 0166 trigger refusing an organization the content
/// owner does not belong to.
pub fn is_member_owner_violation(error: &sqlx_core::Error) -> bool {
    error.as_database_error().is_some_and(|database_error| {
        database_error.code().as_deref() == Some("23514")
            && database_error.constraint() == Some("organization_member_owner")
    })
}

/// Ends memberships whose time is up. Deleting each row runs the 0166
/// trigger, which moves content the owner-eligibility rule no longer allows
/// and gives a team without an owner a new one. Owners never expire.
pub async fn expire_memberships(pool: &PgPool) -> sqlx_core::Result<u64> {
    let result = sqlx_core::query::query(
        "DELETE FROM cloud_organization_members \
         WHERE expires_at IS NOT NULL AND expires_at <= now()",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::requested;

    #[test]
    fn blank_requests_mean_the_default() {
        assert_eq!(requested(None), None);
        assert_eq!(requested(Some("  ")), None);
        assert_eq!(requested(Some(" org_x ")), Some("org_x"));
    }
}
