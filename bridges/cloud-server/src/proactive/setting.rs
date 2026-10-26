//! The `proactive` field of an agent definition, and what turning it off
//! (or archiving the agent) stops.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

/// `{"enabled": false}` on the wire and in `proactive_json`. Any other key,
/// a missing `enabled`, or a non-boolean value is rejected.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProactiveSetting {
    pub enabled: bool,
}

impl ProactiveSetting {
    /// Strict parse of a client value.
    pub fn parse(value: &Value) -> Result<Self, String> {
        serde_json::from_value(value.clone())
            .map_err(|_| "proactive must be {\"enabled\": true|false}".to_string())
    }

    /// Lenient read of a stored value: anything unreadable is off.
    pub fn from_stored(value: &Value) -> Self {
        Self::parse(value).unwrap_or_default()
    }

    pub fn to_value(self) -> Value {
        serde_json::json!({ "enabled": self.enabled })
    }

    /// The setting a create or update request asks for: `cooperative` is the
    /// UI name of `proactive` and either key is accepted. Both present with
    /// different values is an error. `None` when neither is present.
    pub fn from_request(
        proactive: Option<&Value>,
        cooperative: Option<&Value>,
    ) -> Result<Option<Self>, String> {
        let proactive = proactive.map(Self::parse).transpose()?;
        let cooperative = cooperative
            .map(Self::parse)
            .transpose()
            .map_err(|_| "cooperative must be {\"enabled\": true|false}".to_string())?;
        match (proactive, cooperative) {
            (Some(left), Some(right)) if left != right => {
                Err("proactive and cooperative must match".to_string())
            }
            (left, right) => Ok(left.or(right)),
        }
    }
}

/// Cancels the agent's queued evaluations, frees their conversations, and
/// expires its pending proposals, hinting the owner about each.
pub async fn stop_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    agent_id: &str,
) -> Result<(), sqlx_core::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    let cancelled: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'cancelled', updated_at = $3, completed_at = $3
         WHERE execution_agent_id = $1 AND starts_with(run_id, $2) AND status = 'queued'
         RETURNING run_id",
    )
    .bind(agent_id)
    .bind(super::RUN_PREFIX)
    .bind(&now)
    .fetch_all(&mut **transaction)
    .await?;
    let cancelled: Vec<String> = cancelled.into_iter().map(|(id,)| id).collect();
    query(
        "UPDATE cloud_agent_proactive_state SET active_run_id = NULL, updated_at = now()
         WHERE agent_id = $1 AND active_run_id = ANY($2)",
    )
    .bind(agent_id)
    .bind(&cancelled)
    .execute(&mut **transaction)
    .await?;
    let expired: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_proactive_proposals SET status = 'expired'
         WHERE agent_id = $1 AND status = 'pending' RETURNING proposal_id",
    )
    .bind(agent_id)
    .fetch_all(&mut **transaction)
    .await?;
    let expired: Vec<String> = expired.into_iter().map(|(id,)| id).collect();
    super::proposal::hint(transaction, &expired).await
}

/// The default agent's setting for `account_id`; no row is off.
pub async fn default_enabled(pool: &PgPool, account_id: &str) -> Result<bool, sqlx_core::Error> {
    let row: Option<(bool,)> =
        query_as("SELECT enabled FROM cloud_account_proactive_settings WHERE account_id = $1")
            .bind(account_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some_and(|(enabled,)| enabled))
}

/// Stores the default agent's setting. Turning it off stops what it started,
/// as it does for a definition.
pub async fn set_default(
    pool: &PgPool,
    account_id: &str,
    enabled: bool,
) -> Result<(), sqlx_core::Error> {
    let mut transaction = pool.begin().await?;
    query(
        "INSERT INTO cloud_account_proactive_settings (account_id, enabled) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()",
    )
    .bind(account_id)
    .bind(enabled)
    .execute(&mut *transaction)
    .await?;
    if !enabled {
        let agent_id = super::agents::default_agent_id(account_id);
        stop_in_transaction(&mut transaction, &agent_id).await?;
    }
    transaction.commit().await
}

/// Drops an archived definition's cursors and proposals, which have no
/// foreign key to it. Runs in the archive transaction after
/// [`stop_in_transaction`], so both commit or roll back together.
pub async fn forget_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    agent_id: &str,
) -> Result<(), sqlx_core::Error> {
    for table in [
        "cloud_agent_proactive_state",
        "cloud_agent_proactive_proposals",
    ] {
        query(&format!("DELETE FROM {table} WHERE agent_id = $1"))
            .bind(agent_id)
            .execute(&mut **transaction)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_enabled_boolean_is_accepted() {
        assert_eq!(
            ProactiveSetting::parse(&json!({"enabled": true})),
            Ok(ProactiveSetting { enabled: true })
        );
        assert_eq!(
            ProactiveSetting::parse(&json!({"enabled": false})),
            Ok(ProactiveSetting { enabled: false })
        );
        for bad in [
            json!({}),
            json!({"enabled": "true"}),
            json!({"enabled": 1}),
            json!({"enabled": true, "groups": []}),
            json!(true),
            json!([]),
        ] {
            assert!(ProactiveSetting::parse(&bad).is_err(), "{bad}");
        }
        assert_eq!(
            ProactiveSetting::from_stored(&json!({"enabled": "x"})),
            ProactiveSetting::default()
        );
        assert_eq!(
            ProactiveSetting::default().to_value(),
            json!({"enabled": false})
        );
    }

    #[test]
    fn cooperative_is_an_alias_that_must_agree() {
        let on = json!({"enabled": true});
        let off = json!({"enabled": false});
        let read = |p: Option<&Value>, c: Option<&Value>| ProactiveSetting::from_request(p, c);
        assert_eq!(read(None, None), Ok(None));
        assert_eq!(
            read(Some(&on), None),
            Ok(Some(ProactiveSetting { enabled: true }))
        );
        assert_eq!(
            read(None, Some(&on)),
            Ok(Some(ProactiveSetting { enabled: true }))
        );
        assert_eq!(
            read(Some(&off), Some(&off)),
            Ok(Some(ProactiveSetting::default()))
        );
        assert!(read(Some(&on), Some(&off)).is_err());
        assert!(read(None, Some(&json!({"enabled": 1}))).is_err());
        assert!(read(Some(&json!(true)), None).is_err());
    }
}
