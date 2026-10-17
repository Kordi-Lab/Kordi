//! Saved accounts a provider refused during a run (issue 1800). A refused
//! account reads `needs-reconnect` until it is connected again, so route
//! resolution stops handing it out and its owner's clients show it.

use chrono::Utc;
use sqlx_core::query_as::query_as;
use sqlx_postgres::Postgres;

use super::readiness::{snapshot_status, READY};
use crate::chat_sync::store::{append_user_sync_events_in_transaction, StoreError};

/// Marks the saved account `run_id` used as needing reconnection, and returns
/// its provider. `None` when the run used no saved account, for example a
/// service key, or the account was already marked or revoked.
pub(crate) async fn mark_run_account_rejected(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    run_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let now_ms = Utc::now().timestamp_millis();
    // Not refreshable and expired now: the same state as a refused refresh token.
    let marked: Option<(String, String, String)> = query_as(
        "UPDATE cloud_agent_provider_auth_snapshots s \
         SET refreshable = false, expires_at_ms = LEAST(COALESCE(s.expires_at_ms, $2), $2) \
         WHERE s.snapshot_id = ( \
             SELECT a.snapshot_id FROM cloud_agent_provider_auth_snapshot_audit a \
             WHERE a.run_id = $1 AND a.action = 'used' ORDER BY a.created_at DESC LIMIT 1) \
           AND s.revoked_at IS NULL \
           AND (s.refreshable OR s.expires_at_ms IS NULL OR s.expires_at_ms > $2) \
         RETURNING s.snapshot_id, s.account_id, s.provider",
    )
    .bind(run_id)
    .bind(now_ms)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((snapshot_id, account_id, provider)) = marked else {
        return Ok(None);
    };
    append_user_sync_events_in_transaction(
        tx,
        &[account_id],
        "provider-auth.updated",
        None,
        &serde_json::json!({
            "action": "needs-reconnect",
            "provider": &provider,
            "snapshotId": snapshot_id,
        }),
    )
    .await
    .map_err(|error| match error {
        StoreError::Database(error) => error,
        other => sqlx_core::Error::Protocol(other.to_string()),
    })?;
    Ok(Some(provider))
}

/// The provider of the owner's newest live saved account that needs
/// reconnecting, which the digest names when sign-in failed.
pub(crate) async fn newest_account_needing_reconnect(
    pool: &sqlx_postgres::PgPool,
    account_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let rows: Vec<(String, bool, Option<i64>)> = query_as(
        "SELECT provider, refreshable, expires_at_ms FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .find(|(_, refreshable, expires_at_ms)| {
            snapshot_status(*refreshable, *expires_at_ms) != READY
        })
        .map(|(provider, _, _)| provider))
}
