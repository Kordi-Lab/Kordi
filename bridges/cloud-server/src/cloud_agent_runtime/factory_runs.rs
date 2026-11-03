//! Factory smoke tests leased to the owner Mac. Draft contents stay local;
//! the server admits only the selected provider route. A test never becomes
//! cloud work, shares no chat history, and cannot outlive its bounded lease.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::{executor::Executor, query::query, query_as::query_as};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::runs::AgentRuntimeRoute;

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// Run id prefix of Factory test runs. The runner lease query names the
/// same literal.
pub(crate) const RUN_PREFIX: &str = "factory_";
/// Seconds a Mac holds a Factory test before it must renew, as for chat.
pub(crate) const LEASE_SECONDS: i64 = 45;
/// A Factory test still open this long after it started has failed.
const MAX_AGE_MINUTES: i32 = 10;
const TIMEOUT_ERROR_CODE: &str = "factory_timeout";
/// A Mac that cannot finish ends the test with this code; nothing else runs it.
const RELEASED_ERROR_CODE: &str = "desktop_released";

pub(crate) fn is_factory_run(run_id: &str) -> bool {
    run_id.starts_with(RUN_PREFIX)
}

fn session_id(account: &str) -> String {
    format!("factory:{account}")
}

/// Fails open Factory tests that started more than [`MAX_AGE_MINUTES`] ago or whose
/// lease lapsed, for `account` or for every account.
pub(crate) async fn expire_stale<'e, E>(executor: E, account: Option<&str>) -> Result<u64>
where
    E: Executor<'e, Database = Postgres>,
{
    let expired = query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = 'failed', error_code = $3, completed_at = now()::text, updated_at = now()::text \
         WHERE starts_with(run_id, $1) AND status IN ('leased', 'running') \
           AND ($2::text IS NULL OR owner_account_id = $2) \
           AND (created_at::timestamptz < now() - make_interval(mins => $4::INT) \
                OR lease_expires_at IS NULL OR lease_expires_at::timestamptz <= now())",
    )
    .bind(RUN_PREFIX)
    .bind(account)
    .bind(TIMEOUT_ERROR_CODE)
    .bind(MAX_AGE_MINUTES)
    .execute(executor)
    .await?;
    Ok(expired.rows_affected())
}

/// Creates a test with the exact selected route, without digest preferences.
pub(crate) async fn start(
    pool: &PgPool,
    account: &str,
    executor: &str,
    route: Option<&AgentRuntimeRoute>,
) -> Result<Value> {
    let Some(stored) = super::runs::claimed_route_json(route)
        .and_then(|value| serde_json::from_value::<AgentRuntimeRoute>(value).ok())
        .filter(|route| {
            route.default_model.is_some()
                && route.default_auth_provider.is_some()
                && route.default_auth_choice.is_some()
        })
    else {
        return Ok(
            json!({"acquired": false, "errorCode": "missing_runtime_route",
            "message": "Choose a connected provider account and model in Factory, then test again."}),
        );
    };
    let session = session_id(account);
    let mut tx = pool.begin().await?;
    super::run_locks::lock_session(&mut tx, &session).await?;
    expire_stale(&mut *tx, Some(account)).await?;
    let (live,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_agent_fallback_runs \
           WHERE owner_account_id = $1 AND starts_with(run_id, $2) \
             AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now())",
    )
    .bind(account)
    .bind(RUN_PREFIX)
    .fetch_one(&mut *tx)
    .await?;
    if live {
        tx.commit().await?;
        return Ok(json!({
            "acquired": false,
            "errorCode": "factory_test_in_progress",
            "message": "A Factory test is already running.",
        }));
    }
    let run_id = format!("{RUN_PREFIX}{}", Uuid::new_v4().simple());
    let now = Utc::now();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
           session_id, owner_account_id, requester_account_id, status, prompt, system_prompt, \
           runtime_route_json, created_at, updated_at, run_trigger, connector_audience, \
           execution_backend, claimed_by, lease_expires_at) \
         VALUES ($1, $1, $1, $2, $3, $3, 'leased', '{}', '', $4, $5, $5, 'background', \
           'owner_private', 'desktop', $6, $7)",
    )
    .bind(&run_id)
    .bind(&session)
    .bind(account)
    .bind(serde_json::to_value(&stored).map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?)
    .bind(now.to_rfc3339())
    .bind(executor)
    .bind((now + chrono::Duration::seconds(LEASE_SECONDS)).to_rfc3339())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({"runId": run_id, "acquired": true, "leaseSeconds": LEASE_SECONDS}))
}

/// Ends the Factory test `executor` holds, as `completed` or released (`failed`).
/// Returns false when it no longer holds the run.
pub(crate) async fn finish(
    pool: &PgPool,
    run_id: &str,
    account: &str,
    executor: &str,
    completed: bool,
) -> Result<bool> {
    expire_stale(pool, Some(account)).await?;
    let (status, error_code) = if completed {
        ("completed", None)
    } else {
        ("failed", Some(RELEASED_ERROR_CODE))
    };
    let ended = query(
        "UPDATE cloud_agent_fallback_runs \
         SET status = $5, error_code = $6, completed_at = $7, updated_at = $7 \
         WHERE run_id = $1 AND starts_with(run_id, $2) AND owner_account_id = $3 \
           AND claimed_by = $4 AND execution_backend = 'desktop' \
           AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now()",
    )
    .bind(run_id)
    .bind(RUN_PREFIX)
    .bind(account)
    .bind(executor)
    .bind(status)
    .bind(error_code)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(ended.rows_affected() == 1)
}
