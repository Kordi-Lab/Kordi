//! Pool workers: the control plane side.
//!
//! A resource pool with executor `pool_worker` runs its System agent and
//! Grounding work on its own worker, in the sponsor's own cloud project, so
//! the control plane never holds that pool's model credential. Runs of such a
//! pool are queued here tagged with the pool id ([`store::tag_run`]). The
//! worker authenticates every request with a workload identity token checked
//! against the pool's configured identity ([`token`]), leases only its own
//! pool's runs, receives a one-time lease token and the model input of one
//! run, calls its own provider, and posts the reply. The control plane checks
//! the lease and hands the reply to the feature that queued the run, which
//! validates it and writes it into the conversation.
//!
//! Endpoints (all `POST`, `Authorization: Bearer <identity token>`):
//! `/v1/cloud/pool-workers/lease`, and under
//! `/v1/cloud/pool-workers/runs/{run_id}/`: `heartbeat`, `plan-card`,
//! `complete`, `fail`. See `docs/development/resource-pools.md`.

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::cloud_agent_runtime::runs::error_response;
use crate::resource_pools::{Executor, ResourcePool, ResourcePools};
use crate::server::ServerState;

pub use maintenance::{maintain, spawn_maintenance};

mod keys;
mod maintenance;
pub mod store;
#[cfg(test)]
pub(crate) mod test_signer;
pub mod token;

const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// JSON escaping can make a 1 MiB reply up to six times longer on the wire.
const MAX_COMPLETE_BODY_BYTES: usize = 6 * MAX_RESPONSE_BYTES + 64 * 1024;
const MAX_ID_CHARS: usize = 64;
/// Requests allowed per pool in each [`RATE_WINDOW`].
const RATE_LIMIT: u32 = 600;
const RATE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/pool-workers/lease", post(lease))
        .route(
            "/v1/cloud/pool-workers/runs/:run_id/heartbeat",
            post(heartbeat),
        )
        .route(
            "/v1/cloud/pool-workers/runs/:run_id/plan-card",
            post(plan_card),
        )
        .route(
            "/v1/cloud/pool-workers/runs/:run_id/complete",
            post(complete).layer(DefaultBodyLimit::max(MAX_COMPLETE_BODY_BYTES)),
        )
        .route("/v1/cloud/pool-workers/runs/:run_id/fail", post(fail))
        .with_state(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRequest {
    pool_id: String,
    worker_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest {
    pool_id: String,
    worker_id: String,
    lease_token: String,
    #[serde(default)]
    response_text: Option<String>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    request: Option<serde_json::Value>,
}

fn unauthorized() -> Response {
    error_response(
        "pool_worker_unauthorized",
        "The pool worker identity was not accepted.",
        StatusCode::UNAUTHORIZED,
    )
}

fn rate_limited() -> Response {
    error_response(
        "rate_limited",
        "Too many pool worker requests. Try again shortly.",
        StatusCode::TOO_MANY_REQUESTS,
    )
}

/// Counts a request for `pool_id` and says whether it is within the pool's
/// rate. Unknown pool ids share one counter, so they cannot grow the table.
fn within_rate(pool_id: Option<&str>) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    static WINDOWS: OnceLock<Mutex<HashMap<String, (Instant, u32)>>> = OnceLock::new();
    let mut windows = WINDOWS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();
    let window = windows
        .entry(pool_id.unwrap_or("").to_string())
        .or_insert((now, 0));
    if now.duration_since(window.0) >= RATE_WINDOW {
        *window = (now, 0);
    }
    window.1 += 1;
    window.1 <= RATE_LIMIT
}

fn pool_stopped() -> Response {
    error_response(
        "pool_stopped",
        "This pool is stopped.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

fn run_not_found() -> Response {
    error_response(
        "run_not_found",
        "This worker holds no lease on that run.",
        StatusCode::NOT_FOUND,
    )
}

fn server_error(what: &str, error: sqlx_core::Error) -> Response {
    eprintln!("[pool-workers] Could not {what}: {error}");
    error_response(
        "server_error",
        "The pool worker request failed.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_CHARS
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

/// An authenticated worker request: the pool snapshot it was checked
/// against and the worker's pool.
struct Authorized {
    pools: Arc<ResourcePools>,
    pool: ResourcePool,
}

/// Checks the identity token against `pool_id`'s configured worker identity.
/// A token for another pool, an unknown pool, or a pool that executes in
/// the control plane is refused alike, so pool ids cannot be probed.
async fn authorize(
    state: &ServerState,
    headers: &HeaderMap,
    pool_id: &str,
    worker_id: &str,
) -> Result<Authorized, Box<Response>> {
    let Some(system_agent) = state.system_agent() else {
        return Err(Box::new(unauthorized()));
    };
    if !valid_id(pool_id) || !valid_id(worker_id) {
        return Err(Box::new(error_response(
            "invalid_pool_worker_request",
            "poolId and workerId must be 1-64 letters, digits, '.', '_' or '-'.",
            StatusCode::BAD_REQUEST,
        )));
    }
    let pools = system_agent.config().resource_pools();
    let pool = pools
        .by_id(pool_id)
        .filter(|pool| pool.executor() == Executor::PoolWorker)
        .cloned();
    if !within_rate(pool.as_ref().map(ResourcePool::id)) {
        return Err(Box::new(rate_limited()));
    }
    let Some(pool) = pool else {
        return Err(Box::new(unauthorized()));
    };
    let Some(token) = bearer(headers) else {
        return Err(Box::new(unauthorized()));
    };
    let Some(identity) = pool.worker_identity() else {
        eprintln!("[pool-workers] Pool {pool_id} accepts no worker identity");
        return Err(Box::new(unauthorized()));
    };
    let now = chrono::Utc::now().timestamp();
    let cache = keys::KeyCache::shared();
    let mut outcome = Err(token::TokenError::UnknownKey);
    for refresh in [false, true] {
        let keys = match cache.keys(identity, refresh).await {
            Ok(keys) => keys,
            Err(_) => {
                eprintln!("[pool-workers] Signing keys for pool {pool_id} are unavailable");
                return Err(Box::new(unauthorized()));
            }
        };
        outcome = token::verify(token, identity, &keys, now);
        if outcome != Err(token::TokenError::UnknownKey) {
            break;
        }
    }
    if let Err(reason) = outcome {
        eprintln!("[pool-workers] Refused a token for pool {pool_id}: {reason:?}");
        return Err(Box::new(unauthorized()));
    }
    Ok(Authorized { pools, pool })
}

async fn lease(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Json(input): Json<LeaseRequest>,
) -> Response {
    let auth = match authorize(&state, &headers, &input.pool_id, &input.worker_id).await {
        Ok(auth) => auth,
        Err(response) => return *response,
    };
    // The worker is running: every replica may route covered members' work
    // to its pool. A failed write only delays that.
    if let Some(system_agent) = state.system_agent() {
        let sightings = system_agent
            .config()
            .resource_pool_registry()
            .worker_sightings();
        let noted = match state.db_pool().acquire().await {
            Ok(mut conn) => sightings.note(&mut conn, auth.pool.id()).await,
            Err(error) => Err(error),
        };
        if let Err(error) = noted {
            eprintln!(
                "[pool-workers] Could not note a worker of pool {}: {error}",
                auth.pool.id()
            );
        }
    }
    if auth.pool.is_stopped() {
        return pool_stopped();
    }
    match store::lease(
        state.db_pool(),
        &auth.pools,
        auth.pool.id(),
        &input.worker_id,
    )
    .await
    {
        Ok(None) => Json(json!({ "run": null })).into_response(),
        Ok(Some(run)) => Json(json!({
            "run": {
                "runId": run.run_id,
                "feature": run.feature,
                "leaseToken": run.lease_token,
                "systemPrompt": run.system_prompt,
                "prompt": run.prompt,
                "thinking": run.thinking,
                "leaseSeconds": store::LEASE_SECONDS,
            }
        }))
        .into_response(),
        Err(error) => server_error("lease a run", error),
    }
}

/// Authorizes a request about one run and checks the worker's lease on it.
/// With `spend`, the lease token is used up in the same statement (complete
/// and fail), so a replayed or concurrent call finds no lease.
async fn held_run(
    state: &ServerState,
    headers: &HeaderMap,
    run_id: &str,
    input: &RunRequest,
    spend: bool,
) -> Result<(Authorized, store::HeldRun), Box<Response>> {
    let auth = authorize(state, headers, &input.pool_id, &input.worker_id).await?;
    let (db, pool_id) = (state.db_pool(), auth.pool.id());
    let found = if spend {
        store::take(db, run_id, pool_id, &input.worker_id, &input.lease_token).await
    } else {
        store::held(db, run_id, pool_id, &input.worker_id, &input.lease_token).await
    };
    match found {
        Ok(Some(held)) => Ok((auth, held)),
        Ok(None) => Err(Box::new(run_not_found())),
        Err(error) => Err(Box::new(server_error("check a lease", error))),
    }
}

async fn heartbeat(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<RunRequest>,
) -> Response {
    let (auth, held) = match held_run(&state, &headers, &run_id, &input, false).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    if auth.pool.is_stopped() {
        return pool_stopped();
    }
    if held.cancel_requested {
        return Json(json!({ "cancelRequested": true })).into_response();
    }
    match store::renew(state.db_pool(), &run_id, &held.runner_id).await {
        Ok(true) => Json(json!({ "cancelRequested": false })).into_response(),
        Ok(false) => run_not_found(),
        Err(error) => server_error("renew a lease", error),
    }
}

async fn plan_card(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<RunRequest>,
) -> Response {
    let (auth, held) = match held_run(&state, &headers, &run_id, &input, false).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    if auth.pool.is_stopped() {
        return pool_stopped();
    }
    let Some(request) = input.request else {
        return error_response(
            "invalid_pool_worker_request",
            "request is required.",
            StatusCode::BAD_REQUEST,
        );
    };
    if held.feature != crate::resource_pools::Feature::SystemAgent.as_str() {
        return run_not_found();
    }
    crate::plan_cards::runner_action(&state, &run_id, &held.runner_id, request).await
}

async fn complete(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<RunRequest>,
) -> Response {
    // A malformed body leaves the lease alone, so the worker can still
    // report the run as failed.
    let Some(text) = input
        .response_text
        .clone()
        .filter(|text| text.len() <= MAX_RESPONSE_BYTES)
    else {
        return error_response(
            "invalid_pool_worker_request",
            "responseText is required and at most 1 MiB.",
            StatusCode::BAD_REQUEST,
        );
    };
    let (auth, held) = match held_run(&state, &headers, &run_id, &input, true).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let db = state.db_pool();
    if auth.pool.is_stopped() {
        // A stopped pool's results are not applied.
        if let Err(error) = store::fail(db, &run_id, Some(&held.runner_id), "pool_stopped").await {
            return server_error("fail a stopped pool's run", error);
        }
        return pool_stopped();
    }
    match store::complete(db, &run_id, &held.runner_id, &text).await {
        Ok(true) => {}
        Ok(false) => {
            // The feature no longer wanted this run's result; end the run
            // rather than leave it to lapse.
            if let Err(error) = store::fail(
                db,
                &run_id,
                Some(&held.runner_id),
                "pool_worker_result_ignored",
            )
            .await
            {
                return server_error("fail an ignored run", error);
            }
            return error_response(
                "run_not_completed",
                "The run could not take this result.",
                StatusCode::CONFLICT,
            );
        }
        Err(error) => return server_error("complete a run", error),
    }
    let response_message_id: Option<String> = sqlx_core::query_scalar::query_scalar(
        "SELECT response_message_id FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
    .flatten();
    crate::cloud_agent_runtime::routes::notify_run_response(&state, response_message_id.as_deref())
        .await;
    Json(json!({ "ok": true })).into_response()
}

async fn fail(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Json(input): Json<RunRequest>,
) -> Response {
    let code = input.error_code.clone().unwrap_or_default();
    let valid_code = !code.is_empty()
        && code.len() <= MAX_ID_CHARS
        && code
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if !valid_code {
        return error_response(
            "invalid_pool_worker_request",
            "errorCode must be 1-64 lowercase letters, digits or '_'.",
            StatusCode::BAD_REQUEST,
        );
    }
    let (_, held) = match held_run(&state, &headers, &run_id, &input, true).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    match store::fail(state.db_pool(), &run_id, Some(&held.runner_id), &code).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => server_error("fail a run", error),
    }
}

#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod tests;
