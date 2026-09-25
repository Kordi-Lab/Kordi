//! Resolves the exact saved account for a run route and refreshes Codex
//! access tokens before handing material to a runner.

use std::time::{Duration, Instant};

use serde_json::Value;
use sqlx_core::pool::PoolConnection;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::cipher::ProviderAuthCipher;
use super::codex_refresh::{codex_payload_needs_refresh, refresh_codex_payload, CodexRefreshError};
use super::readiness::{payload_expiry, payload_refreshable, snapshot_status, READY};
use super::service::{
    service_provider_auth_for_run, RunnerProviderAuthMaterial, ServiceProviderAuth,
};
use super::snapshots::{live_snapshot_for_route, record_snapshot_used};
use crate::chat_sync::store::{append_user_sync_events_in_transaction, StoreError};

const REFRESH_LOCK_WAIT: Duration = Duration::from_secs(30);
const REFRESH_LOCK_POLL: Duration = Duration::from_millis(100);

#[derive(Debug)]
pub enum ProviderAuthForRunResult {
    Found(RunnerProviderAuthMaterial),
    RunNotFound,
    ProviderAuthNotFound,
    ProviderAuthCipherUnavailable,
}

pub async fn provider_auth_for_run(
    pool: &PgPool,
    cipher: Option<&dyn ProviderAuthCipher>,
    service_auths: Vec<ServiceProviderAuth<'_>>,
    run_id: &str,
    runner_id: &str,
) -> Result<ProviderAuthForRunResult, sqlx_core::Error> {
    let run: Option<(String, Value)> = query_as(
        "SELECT owner_account_id, runtime_route_json FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner_account_id, runtime_route)) = run else {
        return Ok(ProviderAuthForRunResult::RunNotFound);
    };

    if let Some(provider_auth) =
        service_provider_auth_for_run(&owner_account_id, run_id, &runtime_route, service_auths)
    {
        return Ok(ProviderAuthForRunResult::Found(provider_auth));
    }

    provider_auth_for_account_route(
        pool,
        cipher,
        &owner_account_id,
        &runtime_route,
        Some(run_id),
    )
    .await
}

pub async fn provider_auth_for_account_route(
    pool: &PgPool,
    cipher: Option<&dyn ProviderAuthCipher>,
    owner_account_id: &str,
    runtime_route: &Value,
    run_id: Option<&str>,
) -> Result<ProviderAuthForRunResult, sqlx_core::Error> {
    let Some(cipher) = cipher else {
        return Ok(ProviderAuthForRunResult::ProviderAuthCipherUnavailable);
    };
    let Some(snapshot_id) = live_snapshot_for_route(pool, owner_account_id, runtime_route).await?
    else {
        return Ok(ProviderAuthForRunResult::ProviderAuthNotFound);
    };
    let Some(mut snapshot) =
        read_live_snapshot(pool, cipher, owner_account_id, &snapshot_id).await?
    else {
        return Ok(ProviderAuthForRunResult::ProviderAuthNotFound);
    };
    if !stored_readiness_confirmed(pool, owner_account_id, &snapshot_id, &snapshot).await? {
        return Ok(ProviderAuthForRunResult::ProviderAuthNotFound);
    }
    if codex_payload_needs_refresh(&snapshot.payload) {
        match refresh_snapshot(pool, cipher, owner_account_id, &snapshot_id).await? {
            Some(refreshed) => snapshot = refreshed,
            None => return Ok(ProviderAuthForRunResult::ProviderAuthNotFound),
        }
    }
    record_snapshot_used(pool, &snapshot_id, owner_account_id, run_id).await?;

    // Refresh capability stays with the server. The runner only needs the
    // short-lived access token for this claimed run.
    let mut payload = snapshot.payload;
    if let Some(material) = payload.as_object_mut() {
        material.remove("refreshToken");
        material.remove("expiresAtMs");
    }

    Ok(ProviderAuthForRunResult::Found(
        RunnerProviderAuthMaterial {
            snapshot_id,
            provider: snapshot.provider,
            auth_choice: snapshot.auth_choice,
            payload,
        },
    ))
}

struct LiveSnapshot {
    provider: String,
    auth_choice: String,
    payload: Value,
    version: i64,
    /// The row's `expires_at_ms`, which rows saved before it existed lack.
    stored_expiry: Option<i64>,
    stored_refreshable: bool,
}

/// provider, auth_choice, encrypted_payload, payload_version, expires_at_ms,
/// refreshable.
type LiveSnapshotRow = (String, String, Vec<u8>, i64, Option<i64>, bool);

async fn read_live_snapshot(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    account_id: &str,
    snapshot_id: &str,
) -> Result<Option<LiveSnapshot>, sqlx_core::Error> {
    let row: Option<LiveSnapshotRow> = query_as(
        "SELECT provider, auth_choice, encrypted_payload, payload_version, expires_at_ms, \
                refreshable \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE snapshot_id = $1 AND account_id = $2 AND revoked_at IS NULL",
    )
    .bind(snapshot_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    let Some((
        provider,
        auth_choice,
        encrypted_payload,
        version,
        stored_expiry,
        stored_refreshable,
    )) = row
    else {
        return Ok(None);
    };
    let plaintext = cipher
        .decrypt(&encrypted_payload)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let payload = serde_json::from_slice(&plaintext)
        .map_err(|err| sqlx_core::Error::Decode(Box::new(err)))?;
    Ok(Some(LiveSnapshot {
        provider,
        auth_choice,
        payload,
        version,
        stored_expiry,
        stored_refreshable,
    }))
}

/// Confirms the readiness columns against the decrypted payload before use.
/// Rows saved before those columns existed have no stored expiry, so their
/// payload decides. Rows saved while any refresh token counted as
/// refreshable may claim a capability the server lacks, so that claim is only
/// ever withdrawn here, never granted: a refused refresh stays recorded.
/// Corrected facts are written back so later listings agree.
async fn stored_readiness_confirmed(
    pool: &PgPool,
    account_id: &str,
    snapshot_id: &str,
    snapshot: &LiveSnapshot,
) -> Result<bool, sqlx_core::Error> {
    let expires_at_ms = snapshot
        .stored_expiry
        .or_else(|| payload_expiry(&snapshot.payload));
    let refreshable = payload_refreshable(&snapshot.payload)
        && (snapshot.stored_expiry.is_none() || snapshot.stored_refreshable);
    if expires_at_ms == snapshot.stored_expiry && refreshable == snapshot.stored_refreshable {
        return Ok(true);
    }
    query(
        "UPDATE cloud_agent_provider_auth_snapshots SET expires_at_ms = $3, refreshable = $4 \
         WHERE snapshot_id = $1 AND account_id = $2 AND payload_version = $5",
    )
    .bind(snapshot_id)
    .bind(account_id)
    .bind(expires_at_ms)
    .bind(refreshable)
    .bind(snapshot.version)
    .execute(pool)
    .await?;
    Ok(snapshot_status(refreshable, expires_at_ms) == READY)
}

/// Refreshes one snapshot's Codex token at most once across requests and
/// replicas. The lock is keyed on the snapshot being refreshed, and no
/// database transaction stays open during the provider call.
async fn refresh_snapshot(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    account_id: &str,
    snapshot_id: &str,
) -> Result<Option<LiveSnapshot>, sqlx_core::Error> {
    let lock = SnapshotRefreshLock::acquire(pool, snapshot_id).await?;
    let result = refresh_locked(pool, cipher, account_id, snapshot_id).await;
    lock.release().await;
    result
}

async fn refresh_locked(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    account_id: &str,
    snapshot_id: &str,
) -> Result<Option<LiveSnapshot>, sqlx_core::Error> {
    // Another request may have refreshed the token while this one waited.
    let Some(mut snapshot) = read_live_snapshot(pool, cipher, account_id, snapshot_id).await?
    else {
        return Ok(None);
    };
    if !codex_payload_needs_refresh(&snapshot.payload) {
        return Ok(Some(snapshot));
    }
    match refresh_codex_payload(&mut snapshot.payload).await {
        Ok(()) => {}
        Err(CodexRefreshError::Rejected) => {
            mark_needs_reconnect(pool, account_id, snapshot_id, &snapshot).await?;
            return Ok(None);
        }
        Err(CodexRefreshError::Failed(error)) => return Err(error),
    }
    let refreshed = serde_json::to_vec(&snapshot.payload)
        .map_err(|err| sqlx_core::Error::Encode(Box::new(err)))?;
    let encrypted = cipher
        .encrypt(&refreshed)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let written = query(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET encrypted_payload = $3, payload_version = payload_version + 1, \
             expires_at_ms = $5, refreshable = $6 \
         WHERE snapshot_id = $1 AND account_id = $2 AND revoked_at IS NULL \
           AND payload_version = $4",
    )
    .bind(snapshot_id)
    .bind(account_id)
    .bind(encrypted)
    .bind(snapshot.version)
    .bind(payload_expiry(&snapshot.payload))
    .bind(payload_refreshable(&snapshot.payload))
    .execute(pool)
    .await?;
    if written.rows_affected() == 1 {
        snapshot.version += 1;
        return Ok(Some(snapshot));
    }
    // Revoked meanwhile, or changed by another writer: never overwrite it.
    match read_live_snapshot(pool, cipher, account_id, snapshot_id).await? {
        None => Ok(None),
        Some(_) => Err(sqlx_core::Error::Protocol(
            "Codex credential changed during refresh".to_string(),
        )),
    }
}

/// Records that the provider refused this account's refresh token. The row
/// stops being refreshable, so its expired token reads `needs-reconnect` and
/// no run is handed it, and the account's clients are told to reload it.
async fn mark_needs_reconnect(
    pool: &PgPool,
    account_id: &str,
    snapshot_id: &str,
    snapshot: &LiveSnapshot,
) -> Result<(), sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let marked = query(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET refreshable = false, expires_at_ms = COALESCE(expires_at_ms, $4) \
         WHERE snapshot_id = $1 AND account_id = $2 AND revoked_at IS NULL \
           AND payload_version = $3",
    )
    .bind(snapshot_id)
    .bind(account_id)
    .bind(snapshot.version)
    .bind(payload_expiry(&snapshot.payload))
    .execute(&mut *tx)
    .await?;
    if marked.rows_affected() == 1 {
        append_user_sync_events_in_transaction(
            &mut tx,
            &[account_id.to_string()],
            "provider-auth.updated",
            None,
            &serde_json::json!({
                "action": "needs-reconnect",
                "provider": &snapshot.provider,
                "snapshotId": snapshot_id,
            }),
        )
        .await
        .map_err(store_error)?;
    }
    tx.commit().await
}

fn store_error(error: StoreError) -> sqlx_core::Error {
    match error {
        StoreError::Database(error) => error,
        other => sqlx_core::Error::Protocol(other.to_string()),
    }
}

/// A session-level advisory lock on one snapshot, held on a dedicated pooled
/// connection outside any transaction.
struct SnapshotRefreshLock {
    connection: Option<PoolConnection<Postgres>>,
    key: String,
}

impl SnapshotRefreshLock {
    async fn acquire(pool: &PgPool, snapshot_id: &str) -> Result<Self, sqlx_core::Error> {
        let key = format!("provider-auth-refresh\u{1f}{snapshot_id}");
        let deadline = Instant::now() + REFRESH_LOCK_WAIT;
        loop {
            // Waiters return their connection to the pool between attempts.
            let mut connection = pool.acquire().await?;
            let (locked,): (bool,) =
                query_as("SELECT pg_try_advisory_lock(hashtextextended($1, 0))")
                    .bind(&key)
                    .fetch_one(&mut *connection)
                    .await?;
            if locked {
                return Ok(Self {
                    connection: Some(connection),
                    key,
                });
            }
            drop(connection);
            if Instant::now() >= deadline {
                return Err(sqlx_core::Error::Protocol(
                    "Timed out waiting for a Codex token refresh".to_string(),
                ));
            }
            tokio::time::sleep(REFRESH_LOCK_POLL).await;
        }
    }

    async fn release(mut self) {
        let Some(mut connection) = self.connection.take() else {
            return;
        };
        let unlocked: Result<(bool,), _> =
            query_as("SELECT pg_advisory_unlock(hashtextextended($1, 0))")
                .bind(&self.key)
                .fetch_one(&mut *connection)
                .await;
        if !matches!(unlocked, Ok((true,))) {
            // Closing the session releases every lock it holds.
            drop(connection.detach());
        }
    }
}

impl Drop for SnapshotRefreshLock {
    /// A cancelled request must not return a connection that still holds the
    /// lock to the pool, so the session is closed instead.
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            drop(connection.detach());
        }
    }
}
