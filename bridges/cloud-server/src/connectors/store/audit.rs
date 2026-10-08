//! The connector audit log.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
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

/// Opaque paging cursor for the entry at `(created_at, audit_id)`: the
/// RFC 3339 time and the id joined by a space, base64url encoded.
pub fn encode_audit_cursor(created_at: &str, audit_id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{created_at} {audit_id}"))
}

pub fn decode_audit_cursor(cursor: &str) -> Option<(DateTime<Utc>, String)> {
    let bytes = URL_SAFE_NO_PAD.decode(cursor.trim()).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let (time, audit_id) = text.split_once(' ')?;
    if audit_id.is_empty() {
        return None;
    }
    let time = DateTime::parse_from_rfc3339(time).ok()?;
    Some((time.with_timezone(&Utc), audit_id.to_string()))
}

/// Newest first. `before` is an exclusive `(created_at, audit_id)` bound,
/// so entries that share a timestamp are neither skipped nor repeated.
pub async fn list_audit(
    pool: &PgPool,
    connector_id: &str,
    limit: i64,
    before: Option<(DateTime<Utc>, String)>,
) -> StoreResult<Vec<ConnectorAuditEntry>> {
    let (before_at, before_id) = before.unzip();
    let rows: Vec<AuditRow> = query_as(
        "SELECT audit_id, connector_id, run_id, agent_id, tool, tool_group, outcome, summary, \
                created_at \
         FROM cloud_connector_audit \
         WHERE connector_id = $1 \
           AND ($2::timestamptz IS NULL OR (created_at, audit_id) < ($2, $3::text)) \
         ORDER BY created_at DESC, audit_id DESC LIMIT $4",
    )
    .bind(connector_id)
    .bind(before_at)
    .bind(before_id)
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
