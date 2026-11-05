//! Routing members' personal work to a covering organization's pool. The
//! database tests are ignored by default; run them with a task-owned
//! PostgreSQL in `DATABASE_URL`.

use std::time::Duration;

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_scalar::query_scalar;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::*;
use crate::plan_cards::tests::seed_account;
use crate::resource_pools::test_provider;
use crate::resource_pools::usage::tests::test_db;

/// Adds `account` to `organization` as a member, until `expires_at`.
pub(crate) async fn join(
    db: &PgPool,
    organization: &str,
    account: &str,
    expires_at: Option<chrono::DateTime<Utc>>,
) {
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role, expires_at) \
         VALUES ($1, $2, 'member', $3)",
    )
    .bind(organization)
    .bind(account)
    .bind(expires_at)
    .execute(db)
    .await
    .unwrap();
}

pub(crate) async fn personal_organization(db: &PgPool, account: &str) -> String {
    query_scalar("SELECT organization_id FROM cloud_organizations WHERE personal_account_id = $1")
        .bind(account)
        .fetch_one(db)
        .await
        .unwrap()
}

/// A shared default pool and a sponsor pool bound to `sponsor`, which covers
/// its members' personal work when `covering`.
pub(crate) fn sponsored(
    sponsor: &str,
    sponsor_pool: ResourcePool,
    covering: bool,
) -> ResourcePools {
    let sponsor_id = sponsor_pool.id().to_string();
    let pools = ResourcePools::new(
        vec![
            ResourcePool::new("shared", test_provider("shared-model")),
            sponsor_pool,
        ],
        "shared",
        [(sponsor.to_string(), sponsor_id)],
    )
    .unwrap();
    if covering {
        pools.with_covering([sponsor.to_string()])
    } else {
        pools
    }
}

struct People {
    db: PgPool,
    sponsor: String,
    member: String,
    outsider: String,
    expired: String,
}

async fn people() -> People {
    let db = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let [owner, member, outsider, expired] =
        ["owner", "member", "outsider", "expired"].map(|name| format!("{name}-{suffix}"));
    for account in [&owner, &member, &outsider, &expired] {
        seed_account(&db, account).await;
    }
    let sponsor = crate::system_agent::pool_tests::team(&db, &owner).await;
    join(
        &db,
        &sponsor,
        &member,
        Some(Utc::now() + chrono::Duration::days(30)),
    )
    .await;
    join(
        &db,
        &sponsor,
        &expired,
        Some(Utc::now() - chrono::Duration::minutes(1)),
    )
    .await;
    People {
        member: personal_organization(&db, &member).await,
        outsider: personal_organization(&db, &outsider).await,
        expired: personal_organization(&db, &expired).await,
        db,
        sponsor,
    }
}

async fn routed(
    db: &PgPool,
    pools: &ResourcePools,
    sightings: &WorkerSightings,
    org: &str,
) -> String {
    let mut conn = db.acquire().await.unwrap();
    route(&mut conn, pools, sightings, Some(org))
        .await
        .unwrap()
        .id()
        .to_string()
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn only_current_members_personal_work_uses_the_covering_pool() {
    let p = people().await;
    let sightings = WorkerSightings::default();
    let pools = sponsored(
        &p.sponsor,
        ResourcePool::new("sponsor", test_provider("m")),
        true,
    );
    assert_eq!(
        routed(&p.db, &pools, &sightings, &p.member).await,
        "sponsor"
    );
    assert_eq!(
        routed(&p.db, &pools, &sightings, &p.outsider).await,
        "shared"
    );
    assert_eq!(
        routed(&p.db, &pools, &sightings, &p.expired).await,
        "shared"
    );
    // The sponsor's own work is routed as before.
    assert_eq!(
        routed(&p.db, &pools, &sightings, &p.sponsor).await,
        "sponsor"
    );
    let mut conn = p.db.acquire().await.unwrap();
    assert!(serves(&mut conn, &pools, Some(&p.member), "sponsor")
        .await
        .unwrap());
    assert!(!serves(&mut conn, &pools, Some(&p.outsider), "sponsor")
        .await
        .unwrap());
    assert!(serves(&mut conn, &pools, Some(&p.outsider), "shared")
        .await
        .unwrap());

    // Without the flag nothing changes, and neither does a disabled sponsor.
    let plain = sponsored(
        &p.sponsor,
        ResourcePool::new("sponsor", test_provider("m")),
        false,
    );
    assert_eq!(routed(&p.db, &plain, &sightings, &p.member).await, "shared");
    let disabled = pools.clone().with_blocked([p.sponsor.clone()]);
    assert_eq!(
        routed(&p.db, &disabled, &sightings, &p.member).await,
        "shared"
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn an_unavailable_covering_pool_falls_back_to_the_default_pool() {
    let p = people().await;
    let sightings = WorkerSightings::default();
    let stopped = sponsored(
        &p.sponsor,
        ResourcePool::new("sponsor", test_provider("m")).stopped(true),
        true,
    );
    assert_eq!(
        routed(&p.db, &stopped, &sightings, &p.member).await,
        "shared"
    );
    // The sponsor's own conversations get no fallback.
    assert_eq!(
        routed(&p.db, &stopped, &sightings, &p.sponsor).await,
        "sponsor"
    );

    let worker_pool = format!("worker-{}", Uuid::new_v4().simple());
    let workers = sponsored(
        &p.sponsor,
        ResourcePool::pool_worker(&worker_pool, None, 0),
        true,
    );
    assert_eq!(
        routed(&p.db, &workers, &sightings, &p.member).await,
        "shared",
        "no worker was ever seen"
    );
    seen_ago(&p.db, &worker_pool, 180).await;
    assert_eq!(
        routed(&p.db, &workers, &WorkerSightings::default(), &p.member).await,
        "shared",
        "the worker was last seen too long ago"
    );
    // A worker noted by another replica counts here too.
    let mut conn = p.db.acquire().await.unwrap();
    WorkerSightings::default()
        .note(&mut conn, &worker_pool)
        .await
        .unwrap();
    assert_eq!(
        routed(&p.db, &workers, &WorkerSightings::default(), &p.member).await,
        worker_pool
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn the_first_joined_available_covering_organization_serves() {
    let p = people().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let owner = format!("second-owner-{suffix}");
    seed_account(&p.db, &owner).await;
    let second = crate::system_agent::pool_tests::team(&p.db, &owner).await;
    let member: String = query_scalar(
        "SELECT personal_account_id FROM cloud_organizations WHERE organization_id = $1",
    )
    .bind(&p.member)
    .fetch_one(&p.db)
    .await
    .unwrap();
    join(&p.db, &second, &member, None).await;
    let pools_with = |first: ResourcePool| {
        ResourcePools::new(
            vec![
                ResourcePool::new("shared", test_provider("shared-model")),
                first,
                ResourcePool::new("second", test_provider("m")),
            ],
            "shared",
            [
                (p.sponsor.clone(), "first".to_string()),
                (second.clone(), "second".to_string()),
            ],
        )
        .unwrap()
        .with_covering([p.sponsor.clone(), second.clone()])
    };
    let sightings = WorkerSightings::default();
    let both = pools_with(ResourcePool::new("first", test_provider("m")));
    assert_eq!(routed(&p.db, &both, &sightings, &p.member).await, "first");
    let first_stopped = pools_with(ResourcePool::new("first", test_provider("m")).stopped(true));
    assert_eq!(
        routed(&p.db, &first_stopped, &sightings, &p.member).await,
        "second"
    );
}

/// Records in the database that `pool_id`'s worker was seen `seconds` ago.
async fn seen_ago(db: &PgPool, pool_id: &str, seconds: i32) {
    query(
        "INSERT INTO cloud_pool_worker_sightings (pool_id, last_seen_at)
         VALUES ($1, now() - make_interval(secs => $2))
         ON CONFLICT (pool_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at",
    )
    .bind(pool_id)
    .bind(seconds)
    .execute(db)
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn sightings_are_shared_between_processes() {
    let db = test_db().await;
    let pool_id = format!("worker-{}", Uuid::new_v4().simple());
    let mut conn = db.acquire().await.unwrap();
    // Two replicas: one receives the worker's lease requests, one routes.
    let (leasing, routing) = (WorkerSightings::default(), WorkerSightings::default());
    assert!(!routing
        .seen_within(&mut conn, &pool_id, WORKER_SEEN_WINDOW)
        .await
        .unwrap());
    leasing.note(&mut conn, &pool_id).await.unwrap();
    // The routing replica reuses its read for a few seconds, then sees it.
    assert!(!routing
        .seen_within(&mut conn, &pool_id, WORKER_SEEN_WINDOW)
        .await
        .unwrap());
    let later = WorkerSightings::default();
    assert!(later
        .seen_within(&mut conn, &pool_id, WORKER_SEEN_WINDOW)
        .await
        .unwrap());

    // Writes are throttled per process: a second note right away writes
    // nothing, so an old row stays old for other replicas.
    seen_ago(&db, &pool_id, 180).await;
    leasing.note(&mut conn, &pool_id).await.unwrap();
    assert!(leasing
        .seen_within(&mut conn, &pool_id, WORKER_SEEN_WINDOW)
        .await
        .unwrap());
    let other = WorkerSightings::default();
    assert!(!other
        .seen_within(&mut conn, &pool_id, WORKER_SEEN_WINDOW)
        .await
        .unwrap());
    // A process that has not written lately writes at once.
    other.note(&mut conn, &pool_id).await.unwrap();
    assert!(WorkerSightings::default()
        .seen_within(&mut conn, &pool_id, Duration::from_secs(5))
        .await
        .unwrap());
}

#[test]
fn a_covering_pool_must_be_bound_and_admitted() {
    let pools = sponsored(
        "org_sponsor",
        ResourcePool::new("sponsor", test_provider("m")),
        true,
    )
    .with_covering(["org_unbound".to_string()]);
    assert_eq!(
        pools.covering_organizations(),
        vec!["org_sponsor".to_string()]
    );
    let blocked = pools.with_blocked(["org_sponsor".to_string()]);
    assert!(blocked.covering_organizations().is_empty());
}
