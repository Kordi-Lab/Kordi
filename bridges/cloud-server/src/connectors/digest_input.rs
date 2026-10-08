//! Connector events as a read-only digest input.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

/// Events handed to one digest build, newest first.
pub const MAX_DIGEST_EVENTS: i64 = 100;
/// A payload larger than this is replaced by a marker.
const MAX_PAYLOAD_BYTES: usize = 2000;

/// One connector event as the digest sees it. Payloads are the compact,
/// token-free summaries the providers store.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorEventSummary {
    pub event_id: String,
    pub provider: String,
    pub kind: String,
    pub occurred_at: String,
    pub summary: Value,
}

/// Recent events from the account's live connectors since `since`, at most
/// [`MAX_DIGEST_EVENTS`]. Revoked connectors and expired events are left out.
pub async fn recent_events(
    pool: &PgPool,
    account_id: &str,
    since: DateTime<Utc>,
) -> Result<Vec<ConnectorEventSummary>, sqlx_core::Error> {
    let rows: Vec<(String, String, String, DateTime<Utc>, Value)> = query_as(
        "SELECT e.event_id, e.provider, e.kind, e.occurred_at, e.payload \
         FROM cloud_connector_events e \
         JOIN cloud_connectors c ON c.connector_id = e.connector_id \
         WHERE c.account_id = $1 AND c.status <> 'revoked' \
           AND e.occurred_at >= $2 AND e.expires_at > now() \
         ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT $3",
    )
    .bind(account_id)
    .bind(since)
    .bind(MAX_DIGEST_EVENTS)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(event_id, provider, kind, occurred_at, payload)| {
            let summary = if payload.to_string().len() > MAX_PAYLOAD_BYTES {
                json!({ "truncated": true })
            } else {
                payload
            };
            ConnectorEventSummary {
                event_id,
                provider,
                kind,
                occurred_at: occurred_at.to_rfc3339(),
                summary,
            }
        })
        .collect())
}
