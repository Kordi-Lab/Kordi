//! Object-store keys waiting to be deleted (`cloud_object_deletions`).
//!
//! Keys are queued in the transaction that deletes their rows, so none is
//! lost when the server stops before deleting it. A worker deletes due keys
//! and retries failures with backoff; a key the store no longer has counts
//! as deleted. Without an object store, keys wait until one is configured.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

use crate::attachments::{presign_delete_url, S3Config};
use crate::server::ServerState;

/// Keys deleted per batch.
const BATCH: i64 = 50;
/// How often the worker looks for due keys.
const SWEEP_INTERVAL: Duration = Duration::from_secs(300);
/// The longest wait between two attempts on one key.
const MAX_BACKOFF_SECONDS: i64 = 6 * 60 * 60;

/// Queues `keys` for deletion. Returns how many were new.
pub async fn queue(
    tx: &mut Transaction<'_, Postgres>,
    keys: &[String],
) -> Result<usize, sqlx_core::Error> {
    if keys.is_empty() {
        return Ok(0);
    }
    let inserted = query(
        "INSERT INTO cloud_object_deletions (object_key) \
         SELECT DISTINCT key FROM UNNEST($1::TEXT[]) AS queued(key) \
         ON CONFLICT (object_key) DO NOTHING",
    )
    .bind(keys)
    .execute(&mut **tx)
    .await?;
    Ok(inserted.rows_affected() as usize)
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    })
}

async fn delete_object(s3: &S3Config, key: &str) -> Result<(), String> {
    let url = presign_delete_url(s3, key).map_err(|error| error.to_string())?;
    let response = client()
        .delete(url.to_string())
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    let status = response.status();
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!("object store answered {status}"))
    }
}

/// Deletes every due key, a batch at a time. Returns how many were deleted.
pub async fn drain(state: &ServerState) -> usize {
    let Some(s3) = state.s3() else {
        return 0;
    };
    let pool = state.db_pool();
    let mut deleted = 0;
    loop {
        let due: Vec<(String, i32)> = match query_as(
            "SELECT object_key, attempts FROM cloud_object_deletions \
             WHERE next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1",
        )
        .bind(BATCH)
        .fetch_all(pool)
        .await
        {
            Ok(due) => due,
            Err(error) => {
                eprintln!("[object-deletions] Could not read the queue: {error}");
                return deleted;
            }
        };
        if due.is_empty() {
            return deleted;
        }
        for (key, attempts) in due {
            let result = match delete_object(s3, &key).await {
                Ok(()) => {
                    deleted += 1;
                    query("DELETE FROM cloud_object_deletions WHERE object_key = $1")
                        .bind(&key)
                        .execute(pool)
                        .await
                }
                Err(error) => {
                    eprintln!("[object-deletions] Could not delete an object: {error}");
                    let backoff = (60_i64 << attempts.clamp(0, 16)).min(MAX_BACKOFF_SECONDS);
                    query(
                        "UPDATE cloud_object_deletions SET attempts = attempts + 1, \
                           last_error = $2, next_attempt_at = now() + make_interval(secs => $3) \
                         WHERE object_key = $1",
                    )
                    .bind(&key)
                    .bind(error)
                    .bind(backoff as f64)
                    .execute(pool)
                    .await
                }
            };
            if let Err(error) = result {
                eprintln!("[object-deletions] Could not update the queue: {error}");
                return deleted;
            }
        }
    }
}

/// Retries queued keys in the background.
pub fn spawn(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(SWEEP_INTERVAL);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            drain(&state).await;
        }
    })
}
