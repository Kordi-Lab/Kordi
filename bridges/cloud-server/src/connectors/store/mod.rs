//! Postgres access for connectors.
//!
//! This module writes `cloud_connector_secrets` but never reads it. The one
//! reader is `broker::read_sealed_secret`.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::models::{ConnectorRecord, ConnectorStatus, ConnectorSummary, CONNECTOR_COLUMNS};

mod audit;
mod grant;
mod oauth_state;
mod provider_state;

pub use audit::{insert_audit, list_audit, NewAuditEntry};
pub use grant::{apply_grant, disconnect, merge_scopes, write_secret, GrantUpdate, SealedSecret};
pub use oauth_state::{consume_oauth_state, insert_oauth_state, ConnectorOAuthState};
pub use provider_state::{account_agents, live_connectors_for_account_id, set_settings};

pub type StoreResult<T> = Result<T, sqlx_core::Error>;

pub(crate) fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

pub(crate) type ConnectorRow = (
    String,
    String,
    String,
    String,
    Vec<String>,
    Vec<String>,
    bool,
    DateTime<Utc>,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
    serde_json::Value,
    Option<String>,
    Option<DateTime<Utc>>,
);

pub(crate) fn record_from_row(row: ConnectorRow) -> StoreResult<ConnectorRecord> {
    let (
        connector_id,
        account_id,
        provider,
        status,
        read_scopes,
        act_scopes,
        act_enabled,
        created_at,
        updated_at,
        revoked_at,
        settings,
        provider_account_id,
        last_event_at,
    ) = row;
    let status = ConnectorStatus::parse(&status).ok_or_else(|| {
        sqlx_core::Error::Protocol(format!("unknown connector status {status:?}"))
    })?;
    Ok(ConnectorRecord {
        connector_id,
        account_id,
        provider,
        status,
        read_scopes,
        act_scopes,
        act_enabled,
        created_at,
        updated_at,
        revoked_at,
        settings,
        provider_account_id,
        last_event_at,
    })
}

/// Loads a connector only when it belongs to `account_id`.
pub async fn load_account_connector<'e, E>(
    executor: E,
    account_id: &str,
    connector_id: &str,
) -> StoreResult<Option<ConnectorRecord>>
where
    E: Executor<'e, Database = Postgres>,
{
    let row: Option<ConnectorRow> = query_as(&format!(
        "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors \
         WHERE connector_id = $1 AND account_id = $2"
    ))
    .bind(connector_id)
    .bind(account_id)
    .fetch_optional(executor)
    .await?;
    row.map(record_from_row).transpose()
}

pub async fn list_live_connectors(
    pool: &PgPool,
    account_id: &str,
) -> StoreResult<Vec<ConnectorRecord>> {
    let rows: Vec<ConnectorRow> = query_as(&format!(
        "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors \
         WHERE account_id = $1 AND status <> 'revoked' \
         ORDER BY created_at ASC, connector_id ASC"
    ))
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(record_from_row).collect()
}

pub async fn agent_grants(
    pool: &PgPool,
    connector_ids: &[String],
) -> StoreResult<HashMap<String, Vec<String>>> {
    let rows: Vec<(String, String)> = query_as(
        "SELECT connector_id, agent_id FROM cloud_connector_agent_grants \
         WHERE connector_id = ANY($1) ORDER BY connector_id, agent_id",
    )
    .bind(connector_ids)
    .fetch_all(pool)
    .await?;
    let mut grants: HashMap<String, Vec<String>> = HashMap::new();
    for (connector_id, agent_id) in rows {
        grants.entry(connector_id).or_default().push(agent_id);
    }
    Ok(grants)
}

pub async fn connector_summaries(
    pool: &PgPool,
    account_id: &str,
) -> StoreResult<Vec<ConnectorSummary>> {
    let records = list_live_connectors(pool, account_id).await?;
    let ids = records
        .iter()
        .map(|record| record.connector_id.clone())
        .collect::<Vec<_>>();
    let mut grants = agent_grants(pool, &ids).await?;
    Ok(records
        .into_iter()
        .map(|record| {
            let agents = grants.remove(&record.connector_id).unwrap_or_default();
            ConnectorSummary::from_record(record, agents)
        })
        .collect())
}

pub async fn summary_for(pool: &PgPool, record: ConnectorRecord) -> StoreResult<ConnectorSummary> {
    let mut grants = agent_grants(pool, std::slice::from_ref(&record.connector_id)).await?;
    let agents = grants.remove(&record.connector_id).unwrap_or_default();
    Ok(ConnectorSummary::from_record(record, agents))
}

pub async fn agent_has_grant(
    pool: &PgPool,
    connector_id: &str,
    agent_id: &str,
) -> StoreResult<bool> {
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_connector_agent_grants WHERE connector_id = $1 AND agent_id = $2",
    )
    .bind(connector_id)
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// The account's built-in agent id, as used by `cloud_agent_fallback_runs`.
pub fn default_agent_id(account_id: &str) -> String {
    format!("cloud-agent:{}", account_id.trim())
}

/// True for the account's built-in agent and for its active, user-defined
/// agents in `cloud_agent_definitions`.
pub async fn agent_owned_by_account(
    pool: &PgPool,
    account_id: &str,
    agent_id: &str,
) -> StoreResult<bool> {
    if agent_id == default_agent_id(account_id) {
        return Ok(true);
    }
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_agent_definitions \
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'",
    )
    .bind(agent_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn replace_agent_grants(
    pool: &PgPool,
    connector_id: &str,
    agent_ids: &[String],
) -> StoreResult<()> {
    let mut tx = pool.begin().await?;
    query("DELETE FROM cloud_connector_agent_grants WHERE connector_id = $1")
        .bind(connector_id)
        .execute(&mut *tx)
        .await?;
    query(
        "INSERT INTO cloud_connector_agent_grants (connector_id, agent_id) \
         SELECT $1, agent_id FROM unnest($2::text[]) AS agent_id",
    )
    .bind(connector_id)
    .bind(agent_ids)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

pub async fn set_act_enabled(
    pool: &PgPool,
    connector_id: &str,
    enabled: bool,
) -> StoreResult<Option<ConnectorRecord>> {
    let row: Option<ConnectorRow> = query_as(&format!(
        "UPDATE cloud_connectors SET act_enabled = $2, updated_at = now() \
         WHERE connector_id = $1 AND status <> 'revoked' RETURNING {CONNECTOR_COLUMNS}"
    ))
    .bind(connector_id)
    .bind(enabled)
    .fetch_optional(pool)
    .await?;
    row.map(record_from_row).transpose()
}

pub async fn mark_needs_reauth(pool: &PgPool, connector_id: &str) -> StoreResult<()> {
    query(
        "UPDATE cloud_connectors SET status = 'needs_reauth', updated_at = now() \
         WHERE connector_id = $1 AND status = 'connected'",
    )
    .bind(connector_id)
    .execute(pool)
    .await?;
    Ok(())
}
