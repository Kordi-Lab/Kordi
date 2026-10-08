//! Replay state, run lease, and audit helpers used by the memory routes.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::MemoryResult;

/// Number of private runtime replay rows kept for the account's cloud runs.
pub(crate) async fn omp_state_count(pool: &PgPool, account_id: &str) -> MemoryResult<i64> {
    let (count,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_agent_omp_state WHERE owner_account_id = $1")
            .bind(account_id)
            .fetch_one(pool)
            .await?;
    Ok(count)
}

/// Deletes every private runtime replay row kept for the account's cloud runs.
pub(crate) async fn clear_omp_state(pool: &PgPool, account_id: &str) -> MemoryResult<u64> {
    let result = query("DELETE FROM cloud_agent_omp_state WHERE owner_account_id = $1")
        .bind(account_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Owner account of a cloud run currently leased by `runner_id`, matching the
/// lease check used by the runner context routes.
pub(crate) async fn leased_run_owner(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> MemoryResult<Option<String>> {
    let row: Option<(String,)> = query_as(
        "SELECT owner_account_id FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'cloud' \
           AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now()",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(owner,)| owner))
}

/// Writes one audit row. Mirrors the account routes' `write_audit` so runner
/// writes land in the same table with the same shape.
pub(crate) async fn write_memory_audit(
    pool: &PgPool,
    account_id: &str,
    device_id: Option<&str>,
    event_type: &str,
    metadata: serde_json::Value,
) {
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    let result = query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&event_id)
    .bind(account_id)
    .bind(device_id)
    .bind(event_type)
    .bind(metadata.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await;
    if let Err(error) = result {
        eprintln!("[memory_store] audit {event_type}: {error}");
    }
}
