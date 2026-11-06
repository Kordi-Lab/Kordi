//! Nearby work and resource pools: searches use the pool of the
//! organization the request acts in; request checks and match alerts, which
//! the sweep queues later, use the organization the request was created in
//! or Nearby was turned on in, never the one selected afterwards.
//!
//! Other tests sweep the same database with their own pools, so a run may
//! come from their sweep: the organization a run is charged to is checked
//! always, its pool whenever this test's configuration queued it.

use std::sync::Arc;

use axum::Router;
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::{account, pool, send};
use super::nearby_support::{located, need, north, spot, NEEDS, PEOPLE};
use crate::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use crate::common_ground::nearby::sweep_once;
use crate::events::EventBus;
use crate::resource_pools::{test_provider, ResourcePool, ResourcePoolRegistry, ResourcePools};
use crate::server::ServerState;
use crate::system_agent::{SystemAgentConfig, SystemAgentService};

struct Pools {
    config: SystemAgentConfig,
    app: Router,
    team: String,
    shared: String,
    partner: String,
}

/// A team organization mapped to its own pool, the shared pool as the
/// default, and the app with the System agent using them.
async fn setup(pool: &PgPool) -> Pools {
    let service = account(pool, "service").await;
    let creator = account(pool, "creator").await;
    let suffix = Uuid::new_v4().simple().to_string();
    let team = format!("org_test_{suffix}");
    query(
        "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id) \
         VALUES ($1, 'Example team', 'team', $2)",
    )
    .bind(&team)
    .bind(&creator)
    .execute(pool)
    .await
    .unwrap();
    let (shared, partner) = (format!("shared-{suffix}"), format!("partner-{suffix}"));
    let pools = ResourcePools::new(
        vec![
            ResourcePool::new(shared.clone(), test_provider("shared-model")),
            ResourcePool::new(partner.clone(), test_provider("partner-model")),
        ],
        &shared,
        [(team.clone(), partner.clone())],
    )
    .unwrap();
    let mut config = crate::system_agent::test_config(&service);
    config.resource_pools = ResourcePoolRegistry::new(pools);
    let state = ServerState::new(pool.clone(), EventBus::noop())
        .with_system_agent(SystemAgentService::new(config.clone()));
    let app = crate::server::router(Arc::new(state));
    Pools {
        config,
        app,
        team,
        shared,
        partner,
    }
}

async fn join(pool: &PgPool, organization: &str, account: &str) {
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'member')",
    )
    .bind(organization)
    .bind(account)
    .execute(pool)
    .await
    .unwrap();
}

/// Points the account's session tokens at `organization` (`None`: personal),
/// as the token exchange does.
async fn act_in(pool: &PgPool, account: &str, organization: Option<&str>) {
    query("UPDATE cloud_refresh_tokens SET organization_id = $2 WHERE account_id = $1")
        .bind(account)
        .bind(organization)
        .execute(pool)
        .await
        .unwrap();
}

impl Pools {
    /// Checks the run was charged to `organization`, in `expected` when
    /// this test's configuration queued it.
    fn assert_run(&self, run: (String, Option<String>), organization: &str, expected: &str) {
        assert_eq!(run.1.as_deref(), Some(organization), "{run:?}");
        if run.0 == self.shared || run.0 == self.partner {
            assert_eq!(run.0, expected);
        }
    }
}

/// Lets a new match run of `viewer` queue: open ones no longer block it.
async fn unblock_matches(pool: &PgPool, viewer: &str) {
    query(
        "UPDATE cloud_common_ground_match_runs SET created_at = created_at - interval '1 hour'
         WHERE viewer_account_id = $1",
    )
    .bind(viewer)
    .execute(pool)
    .await
    .unwrap();
}

/// (pool, organization) of the newest run behind `sql`'s run ids.
async fn run_pool(pool: &PgPool, sql: &str, key: &str) -> (String, Option<String>) {
    query_as(&format!(
        "SELECT run.runtime_route_json->>'resourcePool', run.organization_id
         FROM cloud_agent_fallback_runs run JOIN ({sql}) owned ON owned.run_id = run.run_id
         ORDER BY run.created_at DESC LIMIT 1"
    ))
    .bind(key)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn check_pool(pool: &PgPool, need_id: &str) -> (String, Option<String>) {
    let sql = "SELECT run_id FROM cloud_common_ground_nearby_need_runs WHERE need_id = $1";
    run_pool(pool, sql, need_id).await
}

async fn match_pool(pool: &PgPool, viewer: &str) -> (String, Option<String>) {
    let sql = "SELECT run_id FROM cloud_common_ground_match_runs
               WHERE kind = 'match' AND viewer_account_id = $1";
    run_pool(pool, sql, viewer).await
}

async fn personal(pool: &PgPool, account: &str) -> String {
    let (id,): (String,) =
        query_as("SELECT organization_id FROM cloud_organizations WHERE personal_account_id = $1")
            .bind(account)
            .fetch_one(pool)
            .await
            .unwrap();
    id
}

async fn sweep(pool: &PgPool, config: &SystemAgentConfig) {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig::production());
    sweep_once(pool, config, &limiter, None).await.unwrap();
}

/// The pool and organization of the match run `token`'s search queues.
async fn searched(
    pools: &Pools,
    pool: &PgPool,
    viewer: &str,
    token: &str,
) -> (String, Option<String>) {
    for _ in 0..5 {
        unblock_matches(pool, viewer).await;
        let (status, body) = send(&pools.app, "GET", PEOPLE, token, None).await;
        assert_eq!(status, 200, "{body}");
        let ours: Option<(String, Option<String>)> = query_as(
            "SELECT run.runtime_route_json->>'resourcePool', run.organization_id
             FROM cloud_agent_fallback_runs run
             JOIN cloud_common_ground_match_runs owned ON owned.run_id = run.run_id
             WHERE owned.viewer_account_id = $1 AND owned.kind = 'match'
               AND run.runtime_route_json->>'resourcePool' = ANY($2)
             ORDER BY run.created_at DESC LIMIT 1",
        )
        .bind(viewer)
        .bind([pools.shared.as_str(), pools.partner.as_str()])
        .fetch_optional(pool)
        .await
        .unwrap();
        if let Some(run) = ours {
            return run;
        }
    }
    panic!("the search queued no match run");
}

#[tokio::test]
async fn nearby_searches_use_the_pool_of_the_request_organization() {
    let Some(pool) = pool().await else {
        return;
    };
    let pools = setup(&pool).await;
    let here = spot();
    let (in_team, team_token) = located(&pools.app, &pool, "InTeam", here).await;
    let (in_personal, personal_token) =
        located(&pools.app, &pool, "InPersonal", north(here, 100.0)).await;
    located(&pools.app, &pool, "Other", north(here, 200.0)).await;
    // Both belong to the team; only one has it selected.
    join(&pool, &pools.team, &in_team).await;
    join(&pool, &pools.team, &in_personal).await;
    act_in(&pool, &in_team, Some(&pools.team)).await;

    let run = searched(&pools, &pool, &in_team, &team_token).await;
    pools.assert_run(run, &pools.team, &pools.partner);
    let run = searched(&pools, &pool, &in_personal, &personal_token).await;
    let mine = personal(&pool, &in_personal).await;
    pools.assert_run(run, &mine, &pools.shared);
}

#[tokio::test]
async fn nearby_background_work_keeps_the_organization_it_was_created_in() {
    let Some(pool) = pool().await else {
        return;
    };
    let pools = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&pools.app, &pool, "Viewer", here).await;
    located(&pools.app, &pool, "Other", north(here, 200.0)).await;
    join(&pool, &pools.team, &me).await;

    // Nearby turned on again and a request created in the team, a second
    // request in Personal; then the person goes back to Personal.
    act_in(&pool, &me, Some(&pools.team)).await;
    let nearby = "/v1/cloud/common-ground/nearby";
    let (status, body) = send(
        &pools.app,
        "PUT",
        nearby,
        &token,
        Some(json!({"enabled": false})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = send(
        &pools.app,
        "PUT",
        nearby,
        &token,
        Some(json!({"enabled": true, "consent": true})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = super::nearby_support::locate(&pools.app, &token, here).await;
    assert_eq!(status, 200, "{body}");
    let team_need = need(&pools.app, &token, json!({"text": "Retrieval people"})).await;
    act_in(&pool, &me, None).await;
    let personal_need = need(&pools.app, &token, json!({"text": "Eval people"})).await;

    // The sweep runs later, with Personal selected.
    unblock_matches(&pool, &me).await;
    sweep(&pool, &pools.config).await;
    let mine = personal(&pool, &me).await;
    let run = check_pool(&pool, &team_need).await;
    pools.assert_run(run, &pools.team, &pools.partner);
    let run = check_pool(&pool, &personal_need).await;
    pools.assert_run(run, &mine, &pools.shared);
    // Match alerts use the organization Nearby was turned on in.
    let run = match_pool(&pool, &me).await;
    pools.assert_run(run, &pools.team, &pools.partner);

    // Once the person leaves the team, its pool is no longer charged.
    query("DELETE FROM cloud_organization_members WHERE organization_id = $1 AND account_id = $2")
        .bind(&pools.team)
        .bind(&me)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(
        &pools.app,
        "PUT",
        &format!("{NEEDS}/{team_need}"),
        &token,
        Some(json!({"text": "Retrieval people nearby"})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    sweep(&pool, &pools.config).await;
    let run = check_pool(&pool, &team_need).await;
    pools.assert_run(run, &mine, &pools.shared);
}
