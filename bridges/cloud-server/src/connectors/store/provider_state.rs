//! Connector settings, provider-account lookup for webhooks, and the agents
//! a person can grant connectors to.

use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::super::models::{ConnectorAgent, ConnectorRecord, CONNECTOR_COLUMNS};
use super::{default_agent_id, record_from_row, ConnectorRow, StoreResult};

/// Name of the built-in agent when the account has no profile name.
const DEFAULT_AGENT_NAME: &str = "Kordi";

/// Replaces the settings of a live connector. `settings` must already be
/// validated by the provider.
pub async fn set_settings(
    pool: &PgPool,
    connector_id: &str,
    settings: &Value,
) -> StoreResult<Option<ConnectorRecord>> {
    let row: Option<ConnectorRow> = query_as(&format!(
        "UPDATE cloud_connectors SET settings = $2, updated_at = now() \
         WHERE connector_id = $1 AND status <> 'revoked' RETURNING {CONNECTOR_COLUMNS}"
    ))
    .bind(connector_id)
    .bind(settings)
    .fetch_optional(pool)
    .await?;
    row.map(record_from_row).transpose()
}

/// Live connectors for one provider account, across Kordi accounts.
pub async fn live_connectors_for_account_id(
    pool: &PgPool,
    provider: &str,
    provider_account_id: &str,
) -> StoreResult<Vec<ConnectorRecord>> {
    let rows: Vec<ConnectorRow> = query_as(&format!(
        "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors \
         WHERE provider = $1 AND provider_account_id = $2 AND status <> 'revoked' \
         ORDER BY connector_id LIMIT 100"
    ))
    .bind(provider)
    .bind(provider_account_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(record_from_row).collect()
}

/// The built-in agent (named from the account's agent profile) and the
/// account's active agents.
pub async fn account_agents(pool: &PgPool, account_id: &str) -> StoreResult<Vec<ConnectorAgent>> {
    let profile: Option<(String,)> = query_as(
        "SELECT display_name FROM cloud_default_agent_profiles WHERE owner_account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    let name = profile
        .map(|(name,)| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| DEFAULT_AGENT_NAME.to_string());
    let mut agents = vec![ConnectorAgent {
        agent_id: default_agent_id(account_id),
        name,
        is_default: true,
    }];
    let rows: Vec<(String, String)> = query_as(
        "SELECT agent_id, name FROM cloud_agent_definitions \
         WHERE owner_account_id = $1 AND status = 'active' \
         ORDER BY created_at, agent_id LIMIT 200",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    // Only the built-in agent is the default, listed once, whatever the
    // definitions table holds.
    let default_id = default_agent_id(account_id);
    let rows = rows
        .into_iter()
        .filter(|(agent_id, _)| *agent_id != default_id);
    agents.extend(rows.map(|(agent_id, name)| ConnectorAgent {
        agent_id,
        name,
        is_default: false,
    }));
    Ok(agents)
}
