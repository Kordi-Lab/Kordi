//! Which saved provider account a digest run uses after another one failed
//! (issues 1800 and 1806). A refused sign-in marks its account as needing
//! reconnection; any other failure only steers the next runs to the owner's
//! other accounts for a while, since its cause may be temporary.

use chrono::{Duration, Utc};
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use crate::cloud_agent_runtime::provider_auth::mark_run_account_rejected;
use crate::cloud_agent_runtime::runs::route_fill::background_route;
use crate::cloud_agent_runtime::runs::AgentRuntimeRoute;

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// How long an account that failed a digest run is passed over.
const AVOID_FAILED_ACCOUNT_MINUTES: i64 = 30;

/// Failures that say nothing about the account the run used.
fn failure_concerns_account(code: &str) -> bool {
    code != "sources_changed"
}

/// Saved accounts used by this owner's digest runs that failed recently.
async fn recently_failed_accounts(pool: &PgPool, account: &str) -> Result<Vec<String>> {
    let since = (Utc::now() - Duration::minutes(AVOID_FAILED_ACCOUNT_MINUTES)).to_rfc3339();
    let rows: Vec<(String,)> = query_as(
        "SELECT DISTINCT a.snapshot_id FROM cloud_agent_fallback_runs r \
         JOIN cloud_agent_provider_auth_snapshot_audit a ON a.run_id = r.run_id AND a.action = 'used' \
         WHERE r.owner_account_id = $1 AND r.run_id LIKE 'digest\\_%' AND r.status = 'failed' \
           AND r.error_code IS DISTINCT FROM 'sources_changed' AND r.updated_at >= $2",
    )
    .bind(account)
    .bind(since)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// The route the next digest run uses: an account that has not failed
/// recently when there is one, otherwise any ready account, so avoiding
/// failed accounts never blocks the digest on its own.
pub(super) async fn route(
    pool: &PgPool,
    account: &str,
    session: &str,
) -> Result<Option<AgentRuntimeRoute>> {
    let failed = recently_failed_accounts(pool, account).await?;
    if !failed.is_empty() {
        if let Some(route) = background_route(pool, account, session, &failed).await? {
            return Ok(Some(route));
        }
    }
    background_route(pool, account, session, &[]).await
}

/// Whether the digest retries at once with another account after `run`
/// failed with `code`. A refused account is marked and never handed out
/// again; for other failures this holds only while an account that has not
/// failed recently remains, which bounds the retries.
pub(super) async fn switches_account(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    pool: &PgPool,
    run: &str,
    code: &str,
) -> Result<bool> {
    if code == "provider_auth_rejected" {
        return Ok(mark_run_account_rejected(tx, run).await?.is_some());
    }
    if !failure_concerns_account(code) {
        return Ok(false);
    }
    let used: Option<(String, String)> = query_as(
        "SELECT a.snapshot_id, r.owner_account_id FROM cloud_agent_fallback_runs r \
         JOIN cloud_agent_provider_auth_snapshot_audit a ON a.run_id = r.run_id AND a.action = 'used' \
         WHERE r.run_id = $1 ORDER BY a.created_at DESC LIMIT 1",
    )
    .bind(run)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((snapshot_id, account)) = used else {
        return Ok(false);
    };
    // This run's failure is not committed yet, so its account is added here.
    let mut failed = recently_failed_accounts(pool, &account).await?;
    failed.push(snapshot_id);
    let session = format!("digest:{account}");
    Ok(background_route(pool, &account, &session, &failed)
        .await?
        .is_some())
}
