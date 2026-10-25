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
}

/// Cancels the agent's queued evaluations, frees their conversations, and
/// expires its pending proposals. Returns the expired proposal ids, whose
/// cards the caller refreshes once the transaction commits.
pub async fn stop_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    agent_id: &str,
) -> Result<Vec<String>, sqlx_core::Error> {
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
    Ok(expired.into_iter().map(|(id,)| id).collect())
}

/// Refreshes the cards of proposals [`stop_in_transaction`] expired. Best
/// effort: the proposals already changed, so a failed refresh is logged.
pub async fn refresh_stopped(pool: &PgPool, proposal_ids: &[String]) {
    for proposal_id in proposal_ids {
        if let Err(error) = super::card::refresh(pool, proposal_id).await {
            eprintln!("[proactive] Could not refresh card {proposal_id}: {error}");
        }
    }
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
}
