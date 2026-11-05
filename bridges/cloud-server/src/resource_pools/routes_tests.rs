//! Who sees which usage: pool-wide rows only for an organization that has
//! its pool to itself, and nothing for an expired membership. The database
//! tests use `$DATABASE_URL` and return early without one.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::*;
use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};
use crate::resource_pools::snapshot::{Reached, Scope};
use crate::resource_pools::usage::{POOL_FEATURE, POOL_SCOPE};
use crate::resource_pools::{test_provider, PoolLimits};

fn plain(id: &str) -> ResourcePool {
    ResourcePool::new(id, test_provider("synthetic-model"))
}

#[test]
fn only_an_exclusively_bound_organization_has_its_pool_to_itself() {
    let pools = ResourcePools::new(
        vec![plain("default"), plain("team"), plain("shared")],
        "default",
        [
            ("org-a".to_string(), "team".to_string()),
            ("org-b".to_string(), "shared".to_string()),
            ("org-c".to_string(), "shared".to_string()),
            ("org-d".to_string(), "default".to_string()),
        ],
    )
    .unwrap();
    assert!(has_pool_to_itself(&pools, "org-a"));
    for organization in ["org-b", "org-c"] {
        assert!(
            !has_pool_to_itself(&pools, organization),
            "{organization} shares its pool"
        );
    }
    assert!(
        !has_pool_to_itself(&pools, "org-d"),
        "unbound organizations share the default pool"
    );
    assert!(!has_pool_to_itself(&pools, "org-unbound"));
    assert!(!has_pool_to_itself(
        &ResourcePools::single(plain("default")),
        "org-a"
    ));
}

/// A team organization owned by `owner`.
async fn team(pool: &PgPool, owner: &str) -> String {
    let id = format!("org_usage_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id) \
         VALUES ($1, 'Example team', 'team', $2)",
    )
    .bind(&id)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(&id)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn an_expired_membership_sees_no_usage() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (owner, _) = signed_in(&pool, "usage_owner").await;
    let (guest, guest_token) = signed_in(&pool, "usage_guest").await;
    let organization = team(&pool, &owner).await;
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role, expires_at) \
         VALUES ($1, $2, 'member', now() + interval '1 hour')",
    )
    .bind(&organization)
    .bind(&guest)
    .execute(&pool)
    .await
    .unwrap();
    let path = format!("/v1/cloud/organizations/{organization}/usage");
    let listed = |answer: &serde_json::Value| {
        answer["organizations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["organizationId"] == organization.as_str())
    };

    let (status, answer) = send(&app, "GET", &path, &guest_token, None).await;
    assert_eq!(status, 200, "{answer}");
    let (status, answer) = send(&app, "GET", "/v1/cloud/account/usage", &guest_token, None).await;
    assert_eq!(status, 200, "{answer}");
    assert!(listed(&answer), "{answer}");

    query(
        "UPDATE cloud_organization_members SET expires_at = now() - interval '1 minute' \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(&organization)
    .bind(&guest)
    .execute(&pool)
    .await
    .unwrap();
    let (status, answer) = send(&app, "GET", &path, &guest_token, None).await;
    assert_eq!(
        (status, answer["errorCode"].as_str()),
        (404, Some("organization_not_found"))
    );
    let (status, answer) = send(&app, "GET", "/v1/cloud/account/usage", &guest_token, None).await;
    assert_eq!(status, 200, "{answer}");
    assert!(!listed(&answer), "an expired membership is not listed");
}

/// Records that another organization's conversation used `pool_id` up
/// today and was paused.
async fn used_up_by_another(db: &PgPool, pool_id: &str, organization: &str) {
    let now = Utc::now();
    query(
        "INSERT INTO cloud_resource_pool_usage \
         (pool_id, usage_day, feature, scope_id, runs, spend_micros) \
         VALUES ($1, $2, $3, $4, 5, 50000)",
    )
    .bind(pool_id)
    .bind(now.date_naive())
    .bind(POOL_FEATURE)
    .bind(POOL_SCOPE)
    .execute(db)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_usage_pauses \
         (pool_id, usage_day, conversation_id, organization_id, limit_id, reached, paused_at) \
         VALUES ($1, $2, $3, $4, 'pool.runs', 'daily_limit', $5)",
    )
    .bind(pool_id)
    .bind(now.date_naive())
    .bind(format!("chat-{}", Uuid::new_v4().simple()))
    .bind(organization)
    .bind(now)
    .execute(db)
    .await
    .unwrap();
}

async fn team_snapshots(
    db: &PgPool,
    pools: &ResourcePools,
    organization: &str,
    role: OrganizationRole,
) -> Vec<UsageSnapshot> {
    organization_snapshots(
        db,
        pools,
        "acct-owner",
        organization,
        "team",
        Some(role),
        Utc::now(),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn pool_wide_usage_is_shown_only_to_the_organization_that_has_the_pool() {
    let Some(db) = pool().await else { return };
    let suffix = Uuid::new_v4().simple().to_string();
    let (ours, theirs) = (format!("org-ours-{suffix}"), format!("org-theirs-{suffix}"));
    let (pool_id, default) = (format!("busy-{suffix}"), format!("default-{suffix}"));
    let busy = plain(&pool_id).with_limits(PoolLimits {
        pool_runs: Some(5),
        pool_spend_micros: Some(1_000_000),
        ..PoolLimits::default()
    });
    used_up_by_another(&db, &pool_id, &theirs).await;

    // On the default pool, or a pool bound to another organization too, the
    // pool's runs, spend and pauses are not this organization's own.
    let on_default = ResourcePools::single(busy.clone());
    let bound_to_both = ResourcePools::new(
        vec![plain(&default), busy.clone()],
        &default,
        [
            (ours.clone(), pool_id.clone()),
            (theirs.clone(), pool_id.clone()),
        ],
    )
    .unwrap();
    for pools in [on_default, bound_to_both] {
        let rows = team_snapshots(&db, &pools, &ours, OrganizationRole::Owner).await;
        assert!(
            rows.iter().all(|row| row.scope != Scope::Pool),
            "a shared pool shows no pool-wide rows: {rows:?}"
        );
    }

    let own = ResourcePools::new(
        vec![plain(&default), busy],
        &default,
        [(ours.clone(), pool_id.clone())],
    )
    .unwrap();
    let rows = team_snapshots(&db, &own, &ours, OrganizationRole::Owner).await;
    let runs = rows.iter().find(|row| row.limit_id == "pool.runs").unwrap();
    assert_eq!((runs.used, runs.limit), (Some(5), Some(5)));
    assert_eq!(runs.reached, Reached::DailyLimit);
    assert!(runs.paused_since.is_some());
    let rows = team_snapshots(&db, &own, &ours, OrganizationRole::Member).await;
    let runs = rows.iter().find(|row| row.limit_id == "pool.runs").unwrap();
    assert_eq!((runs.used, runs.used_percent), (None, 100));
}

#[tokio::test]
async fn a_stopped_shared_pool_says_so_without_pause_times() {
    let Some(db) = pool().await else { return };
    let suffix = Uuid::new_v4().simple().to_string();
    let pool_id = format!("stopped-{suffix}");
    let stopped = plain(&pool_id)
        .with_limits(PoolLimits {
            pool_runs: Some(100),
            ..PoolLimits::default()
        })
        .stopped(true);
    let now = Utc::now();
    query(
        "INSERT INTO cloud_usage_pauses \
         (pool_id, usage_day, conversation_id, limit_id, reached, paused_at) \
         VALUES ($1, $2, $3, 'pool.stopped', 'stopped', $4)",
    )
    .bind(&pool_id)
    .bind(now.date_naive())
    .bind(format!("chat-{suffix}"))
    .bind(now)
    .execute(&db)
    .await
    .unwrap();
    let rows = organization_snapshots(
        &db,
        &ResourcePools::single(stopped),
        "acct-owner",
        &format!("org-{suffix}"),
        "personal",
        Some(OrganizationRole::Owner),
        now,
    )
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(
        (rows[0].limit_id, rows[0].reached, rows[0].used),
        ("pool.stopped", Reached::Stopped, None)
    );
    assert_eq!(rows[0].paused_since, None);
}
