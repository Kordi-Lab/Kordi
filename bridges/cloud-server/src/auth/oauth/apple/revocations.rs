//! Apple tokens still to revoke after their account was deleted
//! (`cloud_apple_token_revocations`).
//!
//! Account deletion revokes the account's Apple tokens before its
//! transaction. Tokens Apple could not revoke move to this queue inside that
//! transaction, without the account, so none is lost when the account row
//! and its `cloud_apple_tokens` go. A worker retries them with backoff and
//! drops a token after [`MAX_ATTEMPTS`], so a deleted person's sealed token
//! is not kept for ever.

use std::sync::Arc;
use std::time::Duration;

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::api::{AppleApi, AppleHttp};
use super::config::AppleConfig;
use super::tokens::revoke_one;
use crate::cloud_agent_runtime::provider_auth::ProviderAuthCipher;
use crate::server::ServerState;

/// Tokens retried per batch.
const BATCH: i64 = 50;
/// How often the worker looks for due tokens.
const SWEEP_INTERVAL: Duration = Duration::from_secs(600);
/// The longest wait between two attempts on one token.
const MAX_BACKOFF_SECONDS: i64 = 24 * 60 * 60;
/// Attempts before a token is dropped: about two weeks of retries.
pub(crate) const MAX_ATTEMPTS: i32 = 24;

/// Moves the Apple tokens `account_id` still has into the retry queue.
/// Call it in the deletion transaction, before the account row goes.
/// Returns how many were queued.
pub(crate) async fn queue_unrevoked(
    tx: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<u64, sqlx_core::Error> {
    let queued = query(
        "INSERT INTO cloud_apple_token_revocations \
           (token_id, client_id, refresh_token_ciphertext, cipher_key_id) \
         SELECT token_id, client_id, refresh_token_ciphertext, cipher_key_id \
         FROM cloud_apple_tokens WHERE account_id = $1 \
         ON CONFLICT (token_id) DO NOTHING",
    )
    .bind(account_id)
    .execute(&mut **tx)
    .await?;
    Ok(queued.rows_affected())
}

/// The outcome of one [`retry_due`] pass.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct RetryOutcome {
    pub revoked: usize,
    pub failed: usize,
    pub dropped: usize,
}

/// Retries every due token, a batch at a time.
pub(crate) async fn retry_due(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    config: &AppleConfig,
    api: &dyn AppleApi,
    now: i64,
) -> RetryOutcome {
    let mut outcome = RetryOutcome::default();
    loop {
        // Tokens tried in this pass are no longer due, so the loop ends.
        let due: Vec<(String, String, Vec<u8>, i32)> = match query_as(
            "SELECT token_id, client_id, refresh_token_ciphertext, attempts \
             FROM cloud_apple_token_revocations \
             WHERE next_attempt_at <= now() ORDER BY next_attempt_at LIMIT $1",
        )
        .bind(BATCH)
        .fetch_all(pool)
        .await
        {
            Ok(due) => due,
            Err(error) => {
                eprintln!("[apple] Could not read the revocation queue: {error}");
                return outcome;
            }
        };
        if due.is_empty() {
            return outcome;
        }
        for (token_id, client_id, ciphertext, attempts) in due {
            let revoked = revoke_one(
                Some(cipher),
                Some(config),
                api,
                &client_id,
                &ciphertext,
                now,
            )
            .await;
            let result = if revoked || attempts + 1 >= MAX_ATTEMPTS {
                if revoked {
                    outcome.revoked += 1;
                } else {
                    outcome.dropped += 1;
                    eprintln!(
                        "[apple] Dropped an Apple token after {MAX_ATTEMPTS} failed revocations."
                    );
                }
                query("DELETE FROM cloud_apple_token_revocations WHERE token_id = $1")
                    .bind(&token_id)
                    .execute(pool)
                    .await
            } else {
                outcome.failed += 1;
                let backoff = (60_i64 << attempts.clamp(0, 16)).min(MAX_BACKOFF_SECONDS);
                query(
                    "UPDATE cloud_apple_token_revocations SET attempts = attempts + 1, \
                       next_attempt_at = now() + make_interval(secs => $2) \
                     WHERE token_id = $1",
                )
                .bind(&token_id)
                .bind(backoff as f64)
                .execute(pool)
                .await
            };
            if let Err(error) = result {
                eprintln!("[apple] Could not update the revocation queue: {error}");
                return outcome;
            }
        }
    }
}

/// Retries queued tokens in the background. Without Apple configuration or
/// the provider-auth cipher, tokens wait until both are set.
pub fn spawn(state: Arc<ServerState>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut timer = tokio::time::interval(SWEEP_INTERVAL);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let api = AppleHttp::new();
        loop {
            timer.tick().await;
            let (Ok(config), Some(cipher)) = (
                AppleConfig::from_env(),
                state.connectors().cipher.as_deref(),
            ) else {
                continue;
            };
            let now = chrono::Utc::now().timestamp();
            retry_due(state.db_pool(), cipher, &config, &api, now).await;
        }
    })
}
