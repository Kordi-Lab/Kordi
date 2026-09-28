//! Saved provider-auth snapshots: publish, list, read, revoke, and audit.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::cipher::ProviderAuthCipher;
use super::provider_family::equivalent_provider_ids;
use super::publish_request::NormalizedProviderAuthSnapshotInput;
use super::readiness::{payload_expiry, payload_refreshable, snapshot_status, READY};
use crate::chat_sync::store::{append_user_sync_events_in_transaction, StoreError};

#[derive(Debug, Clone, Serialize)]
pub struct ProviderAuthSnapshotResponse {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub label: Option<String>,
    #[serde(rename = "modelHint")]
    pub model_hint: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "revokedAt")]
    pub revoked_at: Option<String>,
    /// `ready`, or `needs-reconnect` for an access-only account whose token
    /// expires within five minutes.
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
pub struct CurrentProviderAuthSnapshotResponse {
    pub snapshot: Option<ProviderAuthSnapshotResponse>,
}

#[derive(Debug, Serialize)]
pub struct ProviderAuthSnapshotsResponse {
    pub snapshots: Vec<ProviderAuthSnapshotResponse>,
}

/// Snapshot metadata row: snapshot_id, provider, auth_choice, label,
/// model_hint, created_at, revoked_at, expires_at_ms, refreshable.
type SnapshotRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    Option<i64>,
    bool,
);

/// Live saved accounts one Kordi account may hold.
pub const MAX_LIVE_SNAPSHOTS_PER_ACCOUNT: i64 = 32;

/// Why a publish did not save the account.
#[derive(Debug)]
pub enum PublishSnapshotError {
    /// The account already holds the maximum number of live saved accounts.
    LimitReached,
    Store(StoreError),
}

impl From<StoreError> for PublishSnapshotError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<sqlx_core::Error> for PublishSnapshotError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Store(StoreError::Database(error))
    }
}

impl std::fmt::Display for PublishSnapshotError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LimitReached => formatter.write_str("saved account limit reached"),
            Self::Store(error) => error.fmt(formatter),
        }
    }
}

/// Whether the account can save one more live account.
pub async fn snapshot_capacity_available(
    pool: &PgPool,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let (live,): (i64,) = query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL",
    )
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    Ok(live < MAX_LIVE_SNAPSHOTS_PER_ACCOUNT)
}

#[derive(Debug, Deserialize)]
pub struct CurrentProviderAuthSnapshotQuery {
    pub provider: Option<String>,
    #[serde(rename = "authChoice")]
    pub auth_choice: Option<String>,
    #[serde(rename = "currentDeviceOnly", default)]
    pub current_device_only: bool,
}

pub async fn publish_snapshot(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    account_id: &str,
    device_id: &str,
    input: NormalizedProviderAuthSnapshotInput,
) -> Result<ProviderAuthSnapshotResponse, PublishSnapshotError> {
    let now = Utc::now().to_rfc3339();
    let snapshot_id = format!("snap_{}", Uuid::new_v4().simple());
    let payload_bytes = serde_json::to_vec(&input.payload)
        .map_err(|err| sqlx_core::Error::Encode(Box::new(err)))?;
    let encrypted_payload = cipher
        .encrypt(&payload_bytes)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let model_hint = input
        .payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.chars().count() <= 160
                && !value.chars().any(char::is_control)
        });

    let mut tx = pool.begin().await?;
    let provider_ids = equivalent_provider_ids(Some(&input.provider))
        .unwrap_or_else(|| vec![input.provider.clone()]);
    // One lock per account serializes its publishes, so concurrent saves of
    // one choice leave one live snapshot and cannot pass the limit together.
    let account_lock_key = format!("provider-auth-publish\u{1f}{account_id}");
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(account_lock_key)
        .execute(&mut *tx)
        .await?;
    let revoked_rows: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET revoked_at = $3 \
         WHERE account_id = $1 AND provider = ANY($2) AND auth_choice = $4 AND revoked_at IS NULL \
         RETURNING snapshot_id",
    )
    .bind(account_id)
    .bind(&provider_ids)
    .bind(&now)
    .bind(&input.auth_choice)
    .fetch_all(&mut *tx)
    .await?;
    for (revoked_snapshot_id,) in revoked_rows {
        insert_audit_in_tx(
            &mut tx,
            &revoked_snapshot_id,
            account_id,
            None,
            "revoked",
            &now,
        )
        .await?;
    }
    // Replacing a choice frees its slot first; dropping the transaction
    // undoes that revocation when the limit is still reached.
    let (live,): (i64,) = query_as(
        "SELECT COUNT(*)::BIGINT FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL",
    )
    .bind(account_id)
    .fetch_one(&mut *tx)
    .await?;
    if live >= MAX_LIVE_SNAPSHOTS_PER_ACCOUNT {
        return Err(PublishSnapshotError::LimitReached);
    }

    let row: SnapshotRow = query_as(
        "INSERT INTO cloud_agent_provider_auth_snapshots (
            snapshot_id, account_id, device_id, provider, auth_choice, label, model_hint, encrypted_payload,
            encryption_key_id, created_at, revoked_at, expires_at_ms, refreshable
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12)
         RETURNING snapshot_id, provider, auth_choice, label, model_hint, created_at, revoked_at,
                   expires_at_ms, refreshable",
    )
    .bind(&snapshot_id)
    .bind(account_id)
    .bind(device_id)
    .bind(&input.provider)
    .bind(&input.auth_choice)
    .bind(&input.label)
    .bind(model_hint)
    .bind(encrypted_payload)
    .bind(cipher.key_id())
    .bind(&now)
    .bind(payload_expiry(&input.payload))
    .bind(payload_refreshable(&input.payload))
    .fetch_one(&mut *tx)
    .await?;
    insert_audit_in_tx(&mut tx, &snapshot_id, account_id, None, "created", &now).await?;
    append_user_sync_events_in_transaction(
        &mut tx,
        &[account_id.to_string()],
        "provider-auth.updated",
        None,
        &serde_json::json!({
            "action": "published",
            "provider": &row.1,
            "snapshotId": &row.0,
        }),
    )
    .await?;
    tx.commit().await?;

    Ok(snapshot_response_from_row(row))
}

pub async fn current_snapshot(
    pool: &PgPool,
    account_id: &str,
    query: &CurrentProviderAuthSnapshotQuery,
) -> Result<Option<ProviderAuthSnapshotResponse>, sqlx_core::Error> {
    let provider_ids = equivalent_provider_ids(query.provider.as_deref());
    let auth_choice = query
        .auth_choice
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let row: Option<SnapshotRow> = query_as(
        "SELECT snapshot_id, provider, auth_choice, label, model_hint, created_at, revoked_at, \
                expires_at_ms, refreshable \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
           AND ($2::TEXT[] IS NULL OR provider = ANY($2)) \
           AND ($3::TEXT IS NULL OR auth_choice = $3) \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(provider_ids.as_deref())
    .bind(auth_choice.as_deref())
    .fetch_optional(pool)
    .await?;
    Ok(row.map(snapshot_response_from_row))
}

pub async fn list_snapshots(
    pool: &PgPool,
    account_id: &str,
    provider: Option<&str>,
    device_id: Option<&str>,
) -> Result<Vec<ProviderAuthSnapshotResponse>, sqlx_core::Error> {
    let provider_ids = equivalent_provider_ids(provider);
    let rows: Vec<SnapshotRow> = query_as(
        "SELECT snapshot_id, provider, auth_choice, label, model_hint, created_at, revoked_at, \
                expires_at_ms, refreshable \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
           AND ($2::TEXT[] IS NULL OR provider = ANY($2)) \
           AND ($3::TEXT IS NULL OR device_id = $3) \
         ORDER BY created_at DESC, snapshot_id DESC",
    )
    .bind(account_id)
    .bind(provider_ids.as_deref())
    .bind(device_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(snapshot_response_from_row).collect())
}

pub async fn revoke_snapshot(
    pool: &PgPool,
    account_id: &str,
    snapshot_id: &str,
) -> Result<Option<ProviderAuthSnapshotResponse>, StoreError> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let row: Option<SnapshotRow> = query_as(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET revoked_at = COALESCE(revoked_at, $3) \
         WHERE account_id = $1 AND snapshot_id = $2 \
         RETURNING snapshot_id, provider, auth_choice, label, model_hint, created_at, revoked_at, \
                   expires_at_ms, refreshable",
    )
    .bind(account_id)
    .bind(snapshot_id)
    .bind(&now)
    .fetch_optional(&mut *tx)
    .await?;
    if row.is_some() {
        insert_audit_in_tx(&mut tx, snapshot_id, account_id, None, "revoked", &now).await?;
    }
    if let Some(snapshot) = row.as_ref() {
        append_user_sync_events_in_transaction(
            &mut tx,
            &[account_id.to_string()],
            "provider-auth.updated",
            None,
            &serde_json::json!({
                "action": "revoked",
                "provider": &snapshot.1,
                "snapshotId": &snapshot.0,
            }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(row.map(snapshot_response_from_row))
}

pub(crate) async fn snapshot_available_for_route(
    pool: &PgPool,
    account_id: &str,
    route: &Value,
) -> Result<bool, sqlx_core::Error> {
    Ok(live_snapshot_for_route(pool, account_id, route)
        .await?
        .is_some())
}

/// The live snapshot a run route names. A route with an account choice gets
/// that saved account. A route without a choice, or without a provider, fails
/// closed unless exactly one live snapshot matches, so the server never picks
/// one of several saved accounts on the user's behalf: the same choice name
/// (such as `local-active-oauth`) can exist once per provider.
pub(super) async fn live_snapshot_for_route(
    pool: &PgPool,
    account_id: &str,
    route: &Value,
) -> Result<Option<String>, sqlx_core::Error> {
    let provider_ids = equivalent_provider_ids(
        route
            .get("defaultAuthProvider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    );
    let auth_choice = route
        .get("defaultAuthChoice")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let rows: Vec<(String, bool, Option<i64>)> = query_as(
        "SELECT snapshot_id, refreshable, expires_at_ms FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
           AND ($2::TEXT[] IS NULL OR provider = ANY($2)) \
           AND ($3::TEXT IS NULL OR auth_choice = $3) \
         ORDER BY created_at DESC LIMIT 2",
    )
    .bind(account_id)
    .bind(provider_ids.as_deref())
    .bind(auth_choice)
    .fetch_all(pool)
    .await?;
    let ambiguous = auth_choice.is_none() || provider_ids.is_none();
    // A named account that needs reconnecting is unusable; never substitute
    // another saved account for it.
    Ok(match rows.as_slice() {
        [_, _, ..] if ambiguous => None,
        [(snapshot_id, refreshable, expires_at_ms), ..]
            if snapshot_status(*refreshable, *expires_at_ms) == READY =>
        {
            Some(snapshot_id.clone())
        }
        _ => None,
    })
}

pub async fn record_snapshot_used(
    pool: &PgPool,
    snapshot_id: &str,
    account_id: &str,
    run_id: Option<&str>,
) -> Result<(), sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_provider_auth_snapshot_audit \
         (audit_id, snapshot_id, account_id, run_id, action, created_at) \
         VALUES ($1, $2, $3, $4, 'used', $5)",
    )
    .bind(format!("audit_{}", Uuid::new_v4().simple()))
    .bind(snapshot_id)
    .bind(account_id)
    .bind(run_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_audit_in_tx(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    snapshot_id: &str,
    account_id: &str,
    run_id: Option<&str>,
    action: &str,
    now: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_agent_provider_auth_snapshot_audit \
         (audit_id, snapshot_id, account_id, run_id, action, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(format!("audit_{}", Uuid::new_v4().simple()))
    .bind(snapshot_id)
    .bind(account_id)
    .bind(run_id)
    .bind(action)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn snapshot_response_from_row(row: SnapshotRow) -> ProviderAuthSnapshotResponse {
    ProviderAuthSnapshotResponse {
        snapshot_id: row.0,
        provider: row.1,
        auth_choice: row.2,
        label: row.3,
        model_hint: row.4,
        created_at: row.5,
        revoked_at: row.6,
        status: snapshot_status(row.8, row.7),
    }
}
