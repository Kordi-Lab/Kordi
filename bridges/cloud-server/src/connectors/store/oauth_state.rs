//! Single-use OAuth state for connector grants.

use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::super::models::ConnectorToolGroup;
use super::StoreResult;

/// OAuth state for a connector grant, as handed back by
/// [`consume_oauth_state`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorOAuthState {
    pub state_id: String,
    pub account_id: String,
    pub provider: String,
    pub grant: ConnectorToolGroup,
    pub redirect_after: Option<String>,
    pub code_verifier: String,
    pub expires_at: DateTime<Utc>,
}

pub async fn insert_oauth_state(pool: &PgPool, state: &ConnectorOAuthState) -> StoreResult<()> {
    // Opportunistic cleanup keeps the table small without another worker.
    query("DELETE FROM cloud_connector_oauth_states WHERE expires_at < now()")
        .execute(pool)
        .await?;
    query(
        "INSERT INTO cloud_connector_oauth_states \
         (state_id, account_id, provider, grant_kind, redirect_after, code_verifier, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&state.state_id)
    .bind(&state.account_id)
    .bind(&state.provider)
    .bind(state.grant.as_str())
    .bind(state.redirect_after.as_deref())
    .bind(&state.code_verifier)
    .bind(state.expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

type OAuthStateRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    DateTime<Utc>,
);

/// Deletes and returns the state in one statement, so a state can be used
/// once even when two callbacks race.
pub async fn consume_oauth_state(
    pool: &PgPool,
    state_id: &str,
) -> StoreResult<Option<ConnectorOAuthState>> {
    let row: Option<OAuthStateRow> = query_as(
        "DELETE FROM cloud_connector_oauth_states WHERE state_id = $1 \
         RETURNING state_id, account_id, provider, grant_kind, redirect_after, code_verifier, \
                   expires_at",
    )
    .bind(state_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(
        |(state_id, account_id, provider, grant, redirect_after, code_verifier, expires_at)| {
            Some(ConnectorOAuthState {
                state_id,
                account_id,
                provider,
                grant: ConnectorToolGroup::parse(&grant)?,
                redirect_after,
                code_verifier,
                expires_at,
            })
        },
    ))
}
