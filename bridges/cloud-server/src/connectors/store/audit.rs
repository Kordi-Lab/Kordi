//! The connector audit log.

use chrono::{DateTime, Utc};
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::super::models::{AuditOutcome, ConnectorAuditEntry, ConnectorToolGroup};
use super::{new_id, StoreResult};

pub struct NewAuditEntry<'a> {
    pub connector_id: &'a str,
    pub account_id: &'a str,
    pub run_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub tool: &'a str,
    pub tool_group: ConnectorToolGroup,
    pub outcome: AuditOutcome,
    pub summary: &'a str,
}

pub async fn insert_audit<'e, E>(executor: E, entry: NewAuditEntry<'_>) -> StoreResult<String>
where
    E: Executor<'e, Database = Postgres>,
{
    let audit_id = new_id("cnaud");
    query(
        "INSERT INTO cloud_connector_audit \
         (audit_id, connector_id, account_id, run_id, agent_id, tool, tool_group, outcome, summary) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&audit_id)
    .bind(entry.connector_id)
    .bind(entry.account_id)
    .bind(entry.run_id)
    .bind(entry.agent_id)
    .bind(entry.tool)
    .bind(entry.tool_group.as_str())
    .bind(entry.outcome.as_str())
    .bind(entry.summary)
    .execute(executor)
    .await?;
    Ok(audit_id)
}

type AuditRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
    DateTime<Utc>,
);

/// Newest first. `before` is exclusive.
pub async fn list_audit(
    pool: &PgPool,
    connector_id: &str,
    limit: i64,
    before: Option<DateTime<Utc>>,
) -> StoreResult<Vec<ConnectorAuditEntry>> {
    let rows: Vec<AuditRow> = query_as(
        "SELECT audit_id, connector_id, run_id, agent_id, tool, tool_group, outcome, summary, \
                created_at \
         FROM cloud_connector_audit \
         WHERE connector_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) \
         ORDER BY created_at DESC, audit_id DESC LIMIT $3",
    )
    .bind(connector_id)
    .bind(before)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(audit_id, connector_id, run_id, agent_id, tool, group, outcome, summary, created)| {
                ConnectorAuditEntry {
                    audit_id,
                    connector_id,
                    run_id,
                    agent_id,
                    tool,
                    tool_group: ConnectorToolGroup::parse(&group)
                        .unwrap_or(ConnectorToolGroup::Act),
                    outcome,
                    summary,
                    created_at: created.to_rfc3339(),
                }
            },
        )
        .collect())
}
