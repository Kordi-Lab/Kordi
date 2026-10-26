//! The Proactive setting of an owned agent (`personalAgent.proactive`), what
//! turning it on and off does, and what archiving a definition removes. One
//! table holds it for definitions and the default agent alike. With no row
//! the default agent is on and a definition is off; a stored row wins, so
//! turning the default agent off sticks.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

/// `{"proactive": false}` on the wire. Any other key, a missing `proactive`,
/// or a non-boolean value is rejected.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonalAgentSetting {
    pub proactive: bool,
}

impl PersonalAgentSetting {
    /// Strict parse of a client value.
    pub fn parse(value: &Value) -> Result<Self, String> {
        serde_json::from_value(value.clone())
            .map_err(|_| "personalAgent must be {\"proactive\": true|false}".to_string())
    }

    pub fn to_value(self) -> Value {
        serde_json::json!({ "proactive": self.proactive })
    }
}

type Tx<'a, 'b> = &'a mut Transaction<'b, Postgres>;

/// SQL that is true while the Proactive setting of the agent in column
/// `$agent`, owned by the account in column `$owner`, is on: its row, else
/// on for the default agent only.
macro_rules! effective_on_sql {
    ($agent:literal, $owner:literal) => {
        concat!(
            "COALESCE((SELECT setting.proactive FROM cloud_personal_agent_settings setting \
             WHERE setting.agent_id = ",
            $agent,
            "), ",
            $agent,
            " = 'cloud-agent:' || ",
            $owner,
            ")"
        )
    };
}
pub(crate) use effective_on_sql;

/// The setting of `agent_id` without a stored row.
fn default_for(agent_id: &str) -> bool {
    crate::proactive::agents::default_owner(agent_id).is_some()
}

/// The setting in effect for `agent_id`: its row, else the default.
pub(crate) async fn stored(
    pool: &PgPool,
    agent_id: &str,
) -> Result<PersonalAgentSetting, sqlx_core::Error> {
    let row: Option<(bool,)> =
        query_as("SELECT proactive FROM cloud_personal_agent_settings WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_optional(pool)
            .await?;
    Ok(PersonalAgentSetting {
        proactive: row.map_or_else(|| default_for(agent_id), |(on,)| on),
    })
}

/// Stores `setting` for the owner's agent as an explicit row and returns the
/// one in effect before. Turning it on starts the cursor at now, so history
/// is never evaluated. While it is on, the agent's personal session is made
/// ready (created, unhidden, or replaced after a delete). Turning it off
/// cancels the agent's queued evaluations and frees it. Every change tells
/// the owner's devices whether the session is a personal session now.
pub(crate) async fn store_in_transaction(
    transaction: Tx<'_, '_>,
    owner_account_id: &str,
    agent_id: &str,
    setting: PersonalAgentSetting,
) -> Result<PersonalAgentSetting, sqlx_core::Error> {
    let was: Option<(bool,)> = query_as(
        "SELECT proactive FROM cloud_personal_agent_settings WHERE agent_id = $1 FOR UPDATE",
    )
    .bind(agent_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let was = PersonalAgentSetting {
        proactive: was.map_or_else(|| default_for(agent_id), |(on,)| on),
    };
    query(
        "INSERT INTO cloud_personal_agent_settings (agent_id, owner_account_id, proactive)
         VALUES ($1, $2, $3)
         ON CONFLICT (agent_id) DO UPDATE SET proactive = EXCLUDED.proactive, updated_at = now()",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .bind(setting.proactive)
    .execute(&mut **transaction)
    .await?;
    if setting.proactive && !was.proactive {
        seed_in_transaction(transaction, owner_account_id, agent_id).await?;
    } else if was.proactive && !setting.proactive {
        stop_in_transaction(transaction, agent_id).await?;
    }
    let changed = was != setting;
    let announced = if setting.proactive {
        let (_, activation) =
            super::activation::activate_in_transaction(transaction, owner_account_id, agent_id)
                .await
                .map_err(store_error)?;
        // A new conversation's `conversation.created` already carries it.
        changed && activation != super::activation::Activation::Created
    } else {
        changed
    };
    if announced {
        crate::chat_sync::store::announce_personal_session(transaction, agent_id)
            .await
            .map_err(store_error)?;
    }
    Ok(was)
}

fn store_error(error: crate::chat_sync::store::StoreError) -> sqlx_core::Error {
    match error {
        crate::chat_sync::store::StoreError::Database(error) => error,
        other => sqlx_core::Error::Protocol(other.to_string()),
    }
}

/// Starts (or restarts) the agent's cursor at now with a clean schedule, and
/// records now as the time it was turned on: older events are never shown.
async fn seed_in_transaction(
    transaction: Tx<'_, '_>,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_personal_agent_state (agent_id, owner_account_id) VALUES ($1, $2)
         ON CONFLICT (agent_id) DO UPDATE SET cursor_received_at = now(), cursor_event_id = '',
             enabled_at = now(), active_run_id = NULL, run_cursor_received_at = NULL,
             run_cursor_event_id = NULL, retry_after = now(), attempts = 0,
             last_error = NULL, memory_searches = 0, updated_at = now()",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Cancels the agent's queued evaluations and clears its active one. A run
/// a runner or a Mac already holds finishes, but posts nothing: delivery
/// requires it to still be the agent's active run.
pub(crate) async fn stop_in_transaction(
    transaction: Tx<'_, '_>,
    agent_id: &str,
) -> Result<(), sqlx_core::Error> {
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "UPDATE cloud_agent_fallback_runs
         SET status = 'cancelled', updated_at = $3, completed_at = $3
         WHERE execution_agent_id = $1 AND starts_with(run_id, $2) AND status = 'queued'",
    )
    .bind(agent_id)
    .bind(super::RUN_PREFIX)
    .bind(&now)
    .execute(&mut **transaction)
    .await?;
    query(
        "UPDATE cloud_personal_agent_state
         SET active_run_id = NULL, run_cursor_received_at = NULL, run_cursor_event_id = NULL,
             updated_at = now()
         WHERE agent_id = $1",
    )
    .bind(agent_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Removes an archived definition's personal session binding, setting and
/// state, after stopping its evaluations. The conversation and the log of
/// what it posted stay; the chat becomes an ordinary agent chat, and its
/// members' devices get a `conversation.updated` without `personal_agent`.
pub(crate) async fn forget_in_transaction(
    transaction: Tx<'_, '_>,
    agent_id: &str,
) -> Result<(), sqlx_core::Error> {
    stop_in_transaction(transaction, agent_id).await?;
    crate::chat_sync::store::unbind_personal_session(transaction, agent_id)
        .await
        .map_err(store_error)?;
    for table in [
        "cloud_personal_agent_settings",
        "cloud_personal_agent_state",
    ] {
        query(&format!("DELETE FROM {table} WHERE agent_id = $1"))
            .bind(agent_id)
            .execute(&mut **transaction)
            .await?;
    }
    Ok(())
}

/// Stores the default agent's setting, with the same effects.
pub(crate) async fn set_default(
    pool: &PgPool,
    account_id: &str,
    setting: PersonalAgentSetting,
) -> Result<(), sqlx_core::Error> {
    let agent_id = crate::proactive::agents::default_agent_id(account_id);
    let mut transaction = pool.begin().await?;
    store_in_transaction(&mut transaction, account_id, &agent_id, setting).await?;
    transaction.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_the_proactive_boolean_is_accepted() {
        assert_eq!(
            PersonalAgentSetting::parse(&json!({"proactive": true})),
            Ok(PersonalAgentSetting { proactive: true })
        );
        for bad in [
            json!({}),
            json!({"proactive": "true"}),
            json!({"proactive": true, "quietHours": []}),
            json!({"enabled": true}),
            json!(true),
            json!(null),
        ] {
            assert!(PersonalAgentSetting::parse(&bad).is_err(), "{bad}");
        }
        assert_eq!(
            PersonalAgentSetting::default().to_value(),
            json!({"proactive": false})
        );
    }
}
