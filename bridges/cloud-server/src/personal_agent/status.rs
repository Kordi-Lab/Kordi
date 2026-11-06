//! What the owner sees of one agent's Proactive setting: whether it is on,
//! whether it can be (a live connector granted to the agent), the sources it
//! watches, when it last looked, and what it shared recently.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

/// The newest shares the status lists.
const RECENT: i64 = 5;

/// `{"proactive", "connected", "sources", "checkedAt", "recent"}` for the
/// owner's agent. `proactive` is the setting in effect, so it is false
/// without a live grant; `connected` says whether there is one.
pub(crate) async fn status(
    pool: &PgPool,
    owner_account_id: &str,
    agent_id: &str,
) -> Result<Value, sqlx_core::Error> {
    let (proactive, connected): (bool, bool) = query_as(concat!(
        "SELECT ",
        super::setting::effective_on_sql!("$1", "$2"),
        ", ",
        super::setting::live_grant_sql!("$1", "$2")
    ))
    .bind(agent_id)
    .bind(owner_account_id)
    .fetch_one(pool)
    .await?;
    let sources: Vec<(String, String, String)> = query_as(
        "SELECT connector.connector_id, connector.provider, connector.status
         FROM cloud_connector_agent_grants agent_grant
         JOIN cloud_connectors connector ON connector.connector_id = agent_grant.connector_id
         WHERE agent_grant.agent_id = $1 AND connector.account_id = $2
           AND connector.status <> 'revoked'
         ORDER BY connector.created_at ASC, connector.connector_id ASC",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .fetch_all(pool)
    .await?;
    let checked_at: Option<(DateTime<Utc>,)> =
        query_as("SELECT checked_at FROM cloud_personal_agent_state WHERE agent_id = $1")
            .bind(agent_id)
            .fetch_optional(pool)
            .await?;
    let recent: Vec<(DateTime<Utc>, String)> = query_as(
        "SELECT created_at, text FROM cloud_personal_agent_messages
         WHERE agent_id = $1 AND owner_account_id = $2
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(agent_id)
    .bind(owner_account_id)
    .bind(RECENT)
    .fetch_all(pool)
    .await?;
    Ok(json!({
        "proactive": proactive,
        "connected": connected,
        "sources": sources.into_iter().map(|(connector_id, provider, status)| json!({
            "connectorId": connector_id, "provider": provider, "status": status,
        })).collect::<Vec<_>>(),
        "checkedAt": checked_at.filter(|_| proactive).map(|(at,)| at.to_rfc3339()),
        "recent": recent.into_iter().map(|(at, text)| json!({
            "at": at.to_rfc3339(), "text": text,
        })).collect::<Vec<_>>(),
    }))
}
