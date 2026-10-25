//! The two kinds of agent that can watch: a Factory-built definition, keyed by
//! its `cloud_agent_` id, and the owner's default agent, which has no
//! definition row and is known everywhere as `cloud-agent:<account_id>`.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

const DEFAULT_PREFIX: &str = "cloud-agent:";

/// The default agent's id for `account_id`.
pub(crate) fn default_agent_id(account_id: &str) -> String {
    format!("{DEFAULT_PREFIX}{account_id}")
}

/// The owner of a default agent id, or `None` for a definition id.
pub(crate) fn default_owner(agent_id: &str) -> Option<&str> {
    agent_id
        .strip_prefix(DEFAULT_PREFIX)
        .filter(|owner| !owner.is_empty())
}

/// The default agent's display name, as subsession catalogs name it: the
/// profile name when the owner renamed it, else "<owner>'s Kordi". Takes the
/// aliases of `cloud_accounts` and `cloud_default_agent_profiles`.
macro_rules! default_name_sql {
    ($account:literal, $profile:literal) => {
        concat!(
            "CASE WHEN COALESCE(",
            $profile,
            ".display_name, 'Kordi') IN ('Kordi', 'My Kordi') THEN COALESCE(",
            $account,
            ".display_name, 'Owner') || '''s Kordi' ELSE ",
            $profile,
            ".display_name END"
        )
    };
}
pub(crate) use default_name_sql;

/// Every agent with the setting on, as `(agent_id, owner_account_id)`.
macro_rules! watchers_sql {
    () => {
        "(SELECT d.agent_id, d.owner_account_id FROM cloud_agent_definitions d
           WHERE d.status = 'active' AND d.is_system_managed = FALSE
             AND d.proactive_json @> '{\"enabled\": true}'::jsonb
          UNION ALL
          SELECT 'cloud-agent:' || s.account_id, s.account_id
          FROM cloud_account_proactive_settings s WHERE s.enabled)"
    };
}
pub(crate) use watchers_sql;

/// Who owns `agent_id`, or `None` when no such agent exists. A default id is
/// owned by the account it names.
pub(crate) async fn agent_owner(
    pool: &PgPool,
    agent_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    if let Some(owner) = default_owner(agent_id) {
        return Ok(Some(owner.to_string()));
    }
    let row: Option<(String,)> = query_as(
        "SELECT owner_account_id FROM cloud_agent_definitions
         WHERE agent_id = $1 AND is_system_managed = FALSE",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(owner,)| owner))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ids_name_their_owner() {
        assert_eq!(default_agent_id("acct_1"), "cloud-agent:acct_1");
        assert_eq!(default_owner("cloud-agent:acct_1"), Some("acct_1"));
        assert_eq!(default_owner("cloud-agent:"), None);
        assert_eq!(default_owner("cloud_agent_abc"), None);
    }
}
