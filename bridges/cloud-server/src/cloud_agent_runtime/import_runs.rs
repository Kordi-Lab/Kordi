//! Memory import runs on the owner's Mac (issue 2054).
//!
//! The Mac gets hosted provider credentials only for a run the server admitted
//! and the Mac holds. A memory import has no chat message, digest, or task
//! behind it, so the Mac asks for one with `POST
//! /v1/cloud/agent-runs/desktop/tasks` (kind `memory_import`). The run is
//! created already leased to the asking Mac and runs only there: the cloud
//! runner never leases an `import_` run, and a release ends it instead of
//! queueing it for the cloud. An account holds at most one live import. An
//! import still open [`MAX_AGE_MINUTES`] after it started, or whose lease
//! lapsed, fails with `import_timeout`, both in the desktop run sweep and on
//! the account's next tasks call.

use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::{executor::Executor, query::query, query_as::query_as};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::runs::AgentRuntimeRoute;
use crate::auth::routes::CloudSession;
use crate::digest::model_choice;

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// Run id prefix of memory import runs. The runner lease query names the
/// same literal.
pub(crate) const RUN_PREFIX: &str = "import_";
/// Seconds a Mac holds an import before it must renew, as for chat.
pub(crate) const LEASE_SECONDS: i64 = 45;
/// An import still open this long after it started has failed.
const MAX_AGE_MINUTES: i32 = 10;
const TIMEOUT_ERROR_CODE: &str = "import_timeout";
/// A Mac that cannot finish ends the import with this code; nothing else runs it.
const RELEASED_ERROR_CODE: &str = "desktop_released";

pub(crate) fn is_import_run(run_id: &str) -> bool {
    run_id.starts_with(RUN_PREFIX)
}

fn session_id(account: &str) -> String {
    format!("import:{account}")
}

/// Fails open imports that started more than [`MAX_AGE_MINUTES`] ago or whose
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

/// Whether this signed-in device is an active Mac of its account.
pub(crate) async fn is_owner_mac(pool: &PgPool, session: &CloudSession) -> Result<bool> {
    let (mac,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_devices WHERE device_id = $1 AND account_id = $2 \
           AND revoked_at IS NULL AND device_platform IN ('macos', 'desktop'))",
    )
    .bind(&session.device_id)
    .bind(&session.account_id)
    .fetch_one(pool)
    .await?;
    Ok(mac)
}

/// Creates an import run leased to `executor`, or refuses while the account
/// already has a live import. The route is resolved as for a digest claim:
/// the Mac's hosted account with the owner's digest model choice.
pub(crate) async fn start(
    pool: &PgPool,
    account: &str,
    executor: &str,
    route: Option<&AgentRuntimeRoute>,
) -> Result<Value> {
    let preference = model_choice::preference(pool, account).await?;
    let claimed = super::runs::claimed_route_json(route)
        .and_then(|value| serde_json::from_value::<AgentRuntimeRoute>(value).ok())
        .map(|mac| model_choice::claimed_route(mac, &preference, false));
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
            "errorCode": "import_in_progress",
            "message": "An import is already running.",
        }));
    }
    let run_id = format!("{RUN_PREFIX}{}", Uuid::new_v4().simple());
    let now = Utc::now();
    let stored = claimed.clone().unwrap_or_default();
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
    let fast_models: serde_json::Map<String, Value> = model_choice::FAST_MODELS
        .iter()
        .map(|(provider, model)| (provider.to_string(), json!(model)))
        .collect();
    // The same fields as a digest claim's `digest`, so the Mac reuses them.
    Ok(json!({
        "runId": run_id,
        "acquired": true,
        "leaseSeconds": LEASE_SECONDS,
        "import": {
            "systemPrompt": "",
            "prompt": "",
            "tools": [],
            "model": stored.default_model,
            "thinking": stored.thinking,
            "provider": stored.default_auth_provider,
            "modelChoice": model_choice::choice_kind(&preference),
            "triage": false,
            "fastModels": fast_models,
        },
    }))
}

/// Ends the import `executor` holds, as `completed` or released (`failed`).
/// Returns false when it no longer holds the run.
pub(crate) async fn finish(
    pool: &PgPool,
    run_id: &str,
    account: &str,
    executor: &str,
    completed: bool,
) -> Result<bool> {
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
