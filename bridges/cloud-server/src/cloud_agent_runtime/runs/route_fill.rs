//! Cloud fallback route recovery for claims that arrive without a model.
//!
//! A phone or another device may send a request without the owner's agent
//! route. The owner Mac records the route it ran with on every run, so a
//! Cloud claim reuses the owner's latest route that a hosted account can
//! still serve: first from the same session, then from any session.

use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::AgentRuntimeRoute;
use crate::cloud_agent_runtime::provider_auth::{
    live_snapshot_for_route, snapshot_available_for_route, snapshot_status, READY,
};

const CANDIDATE_LIMIT: i64 = 16;

/// The route a Cloud claim runs with. A route that already names a model is
/// kept. Otherwise the owner's latest recorded route with a model replaces it
/// when the owner has a live hosted account for that route. A thinking level
/// the claim chose is kept, and a claim that names an account only takes a
/// route for that same account.
pub(crate) async fn fill_cloud_route(
    pool: &PgPool,
    owner_account_id: &str,
    session_id: &str,
    route: AgentRuntimeRoute,
) -> Result<AgentRuntimeRoute, sqlx_core::Error> {
    if route.default_model.is_some() {
        return Ok(route);
    }
    for session in [Some(session_id), None] {
        if let Some(found) = recent_route(pool, owner_account_id, session, &route).await? {
            return Ok(AgentRuntimeRoute {
                thinking: route.thinking.or(found.thinking),
                ..found
            });
        }
    }
    Ok(route)
}

/// The route a background run, such as the digest, runs with. It has no
/// claim to carry a route, and an empty route only resolves while the owner
/// holds exactly one saved account. It reuses the owner's latest route that a
/// hosted account can serve, then falls back to the most recently connected
/// account that is ready. Saved accounts in `exclude` are passed over.
/// `None` means no other saved account can run it.
pub(crate) async fn background_route(
    pool: &PgPool,
    owner_account_id: &str,
    session_id: &str,
    exclude: &[String],
) -> Result<Option<AgentRuntimeRoute>, sqlx_core::Error> {
    let route = fill_cloud_route(
        pool,
        owner_account_id,
        session_id,
        AgentRuntimeRoute::default(),
    )
    .await?;
    if route.default_model.is_some() {
        let route_json = serde_json::to_value(&route)
            .map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
        let resolved = live_snapshot_for_route(pool, owner_account_id, &route_json).await?;
        if resolved.is_some_and(|snapshot_id| !exclude.contains(&snapshot_id)) {
            return Ok(Some(route));
        }
    }
    let rows: Vec<(String, String, String, bool, Option<i64>)> = query_as(
        "SELECT snapshot_id, provider, auth_choice, refreshable, expires_at_ms \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC",
    )
    .bind(owner_account_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .find(|(snapshot_id, _, _, refreshable, expires_at_ms)| {
            snapshot_status(*refreshable, *expires_at_ms) == READY && !exclude.contains(snapshot_id)
        })
        .map(|(_, provider, auth_choice, _, _)| AgentRuntimeRoute {
            default_auth_provider: Some(provider),
            default_auth_choice: Some(auth_choice),
            ..AgentRuntimeRoute::default()
        }))
}

async fn recent_route(
    pool: &PgPool,
    owner_account_id: &str,
    session_id: Option<&str>,
    claim: &AgentRuntimeRoute,
) -> Result<Option<AgentRuntimeRoute>, sqlx_core::Error> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT runtime_route_json FROM cloud_agent_fallback_runs \
         WHERE owner_account_id = $1 AND ($2::TEXT IS NULL OR session_id = $2) \
           AND NOT legacy_duplicate \
           AND COALESCE(runtime_route_json->>'defaultModel', '') <> '' \
           AND ($3::TEXT IS NULL OR runtime_route_json->>'defaultAuthChoice' = $3) \
           AND ($4::TEXT IS NULL OR runtime_route_json->>'defaultAuthProvider' = $4) \
         ORDER BY created_at DESC LIMIT $5",
    )
    .bind(owner_account_id)
    .bind(session_id)
    .bind(claim.default_auth_choice.as_deref())
    .bind(claim.default_auth_provider.as_deref())
    .bind(CANDIDATE_LIMIT)
    .fetch_all(pool)
    .await?;
    for (value,) in rows {
        let Some(route) = serde_json::from_value::<AgentRuntimeRoute>(value)
            .ok()
            .and_then(|route| route.normalized())
        else {
            continue;
        };
        // A route for a Mac-only account (for example a local profile) cannot
        // run in Cloud; skip it rather than lose the hosted account.
        let route_json = serde_json::to_value(&route)
            .map_err(|error| sqlx_core::Error::Encode(Box::new(error)))?;
        if snapshot_available_for_route(pool, owner_account_id, &route_json).await? {
            return Ok(Some(route));
        }
    }
    Ok(None)
}

/// Records the hosted account a Cloud run resolved on the run itself when the
/// claim stored no account, so the run's route is never empty. Keys already
/// present on the run are kept. The model stays the runner's choice.
pub(crate) async fn record_resolved_route(
    pool: &PgPool,
    run_id: &str,
    provider: &str,
    auth_choice: &str,
) -> Result<(), sqlx_core::Error> {
    let resolved = serde_json::json!({
        "defaultAuthProvider": provider,
        "defaultAuthChoice": auth_choice,
    });
    query(
        "UPDATE cloud_agent_fallback_runs SET runtime_route_json = $2::JSONB || runtime_route_json \
         WHERE run_id = $1 AND execution_backend = 'cloud' \
           AND COALESCE(runtime_route_json->>'defaultAuthChoice', '') = ''",
    )
    .bind(run_id)
    .bind(resolved)
    .execute(pool)
    .await?;
    Ok(())
}
