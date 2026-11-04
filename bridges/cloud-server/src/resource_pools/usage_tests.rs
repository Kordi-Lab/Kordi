//! Pool usage against a real database. Ignored by default; run them with a
//! task-owned PostgreSQL in `DATABASE_URL` and `--include-ignored`.

use std::sync::Arc;

use chrono::NaiveDate;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::*;
use crate::resource_pools::{PoolLimits, ResourcePool};

pub(crate) async fn test_db() -> PgPool {
    let url = std::env::var("DATABASE_URL").expect("a task-owned DATABASE_URL is required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(24)
        .connect(&url)
        .await
        .expect("connect test database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    pool
}

/// A pool with a unique id, so tests sharing a database never meet.
fn pool_with(limits: PoolLimits, cost: u64) -> ResourcePool {
    ResourcePool::new(
        format!("pool-{}", Uuid::new_v4().simple()),
        crate::resource_pools::test_provider("synthetic-model").with_estimated_cost_micros(cost),
    )
    .with_limits(limits)
}

fn day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2030, 1, 2).unwrap()
}

/// Run ids are unique per pool, so tests can run again on the same database.
fn key(pool: &ResourcePool, run_id: &str) -> String {
    format!("{}:{run_id}", pool.id())
}

async fn admit(
    db: &PgPool,
    pool: &ResourcePool,
    feature: Feature,
    scope: &str,
    run_id: &str,
) -> Admission {
    let mut tx = db.begin().await.unwrap();
    let run_id = key(pool, run_id);
    let request = Request {
        run_id: &run_id,
        pool,
        feature,
        scope_id: scope,
        organization_id: None,
    };
    let admission = reserve_on(&mut tx, &request, day()).await.unwrap();
    tx.commit().await.unwrap();
    admission
}

async fn scope_runs(db: &PgPool, pool: &ResourcePool, feature: Feature, scope: &str) -> i64 {
    runs_on(db, pool.id(), day(), Some(feature), scope)
        .await
        .unwrap()
}

async fn pool_runs(db: &PgPool, pool: &ResourcePool) -> i64 {
    runs_on(db, pool.id(), day(), None, "").await.unwrap()
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn concurrent_admissions_never_pass_a_conversation_limit() {
    let db = test_db().await;
    let pool = Arc::new(pool_with(
        PoolLimits {
            system_agent_runs_per_conversation: Some(3),
            ..PoolLimits::default()
        },
        0,
    ));
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let (db, pool) = (db.clone(), pool.clone());
        tasks.push(tokio::spawn(async move {
            let run_id = format!("pip_{}", Uuid::new_v4().simple());
            admit(&db, &pool, Feature::SystemAgent, "conversation-a", &run_id).await
        }));
    }
    let mut admitted = 0;
    for task in tasks {
        if task.await.unwrap().admitted() {
            admitted += 1;
        }
    }
    assert_eq!(admitted, 3);
    assert_eq!(
        scope_runs(&db, &pool, Feature::SystemAgent, "conversation-a").await,
        3
    );
    assert_eq!(pool_runs(&db, &pool).await, 3);
    // Another conversation has its own allowance.
    assert!(admit(
        &db,
        &pool,
        Feature::SystemAgent,
        "conversation-b",
        "pip_other"
    )
    .await
    .admitted());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_retried_admission_counts_once_and_a_rollback_counts_nothing() {
    let db = test_db().await;
    let pool = pool_with(
        PoolLimits {
            grounding_runs_per_person: Some(2),
            ..PoolLimits::default()
        },
        0,
    );
    let run_id = format!("cg_card_{}", Uuid::new_v4().simple());
    for _ in 0..3 {
        assert!(admit(&db, &pool, Feature::Grounding, "person-a", &run_id)
            .await
            .admitted());
    }
    assert_eq!(
        scope_runs(&db, &pool, Feature::Grounding, "person-a").await,
        1
    );

    // A queue transaction that rolls back takes its reservation with it.
    let mut tx = db.begin().await.unwrap();
    let rolled_back = key(&pool, "cg_card_rolled_back");
    let request = Request {
        run_id: &rolled_back,
        pool: &pool,
        feature: Feature::Grounding,
        scope_id: "person-a",
        organization_id: None,
    };
    assert!(reserve_on(&mut tx, &request, day())
        .await
        .unwrap()
        .admitted());
    tx.rollback().await.unwrap();
    assert_eq!(
        scope_runs(&db, &pool, Feature::Grounding, "person-a").await,
        1
    );

    assert!(
        admit(&db, &pool, Feature::Grounding, "person-a", "cg_card_second")
            .await
            .admitted()
    );
    assert_eq!(
        admit(&db, &pool, Feature::Grounding, "person-a", "cg_card_third").await,
        Admission::Exhausted
    );
    // An exhausted admission leaves no reservation behind.
    let mut conn = db.acquire().await.unwrap();
    assert!(!settle(
        &mut conn,
        &key(&pool, "cg_card_third"),
        Settlement::Released
    )
    .await
    .unwrap());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn settlement_is_idempotent_and_only_a_release_gives_a_run_back() {
    let db = test_db().await;
    let pool = pool_with(
        PoolLimits {
            system_agent_runs_per_conversation: Some(2),
            ..PoolLimits::default()
        },
        250,
    );
    let scope = "conversation-settle";
    for run_id in ["pip_done", "pip_never_claimed"] {
        assert!(admit(&db, &pool, Feature::SystemAgent, scope, run_id)
            .await
            .admitted());
    }
    assert_eq!(
        admit(&db, &pool, Feature::SystemAgent, scope, "pip_over").await,
        Admission::Exhausted
    );
    let mut conn = db.acquire().await.unwrap();
    assert!(
        settle(&mut conn, &key(&pool, "pip_done"), Settlement::Consumed)
            .await
            .unwrap()
    );
    assert!(
        !settle(&mut conn, &key(&pool, "pip_done"), Settlement::Consumed)
            .await
            .unwrap()
    );
    assert!(
        !settle(&mut conn, &key(&pool, "pip_done"), Settlement::Released)
            .await
            .unwrap()
    );
    assert_eq!(scope_runs(&db, &pool, Feature::SystemAgent, scope).await, 2);
    drop(conn);

    // Concurrent releases of one run give it back once.
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (db, run_id) = (db.clone(), key(&pool, "pip_never_claimed"));
        tasks.push(tokio::spawn(async move {
            let mut conn = db.acquire().await.unwrap();
            settle(&mut conn, &run_id, Settlement::Released)
                .await
                .unwrap()
        }));
    }
    let mut released = 0;
    for task in tasks {
        if task.await.unwrap() {
            released += 1;
        }
    }
    assert_eq!(released, 1);
    assert_eq!(scope_runs(&db, &pool, Feature::SystemAgent, scope).await, 1);
    assert_eq!(pool_runs(&db, &pool).await, 1);
    // The freed run can be used again.
    assert!(
        admit(&db, &pool, Feature::SystemAgent, scope, "pip_after_release")
            .await
            .admitted()
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn pool_wide_run_and_spend_ceilings_cover_every_scope() {
    let db = test_db().await;
    let runs = pool_with(
        PoolLimits {
            pool_runs: Some(3),
            ..PoolLimits::default()
        },
        0,
    );
    for (index, feature) in [
        Feature::SystemAgent,
        Feature::Grounding,
        Feature::SystemAgent,
    ]
    .into_iter()
    .enumerate()
    {
        let run_id = format!("run-{index}");
        assert!(
            admit(&db, &runs, feature, &format!("scope-{index}"), &run_id)
                .await
                .admitted()
        );
    }
    assert_eq!(
        admit(&db, &runs, Feature::Grounding, "scope-new", "run-4").await,
        Admission::Exhausted
    );
    // The scope counter of the refused run was rolled back too.
    assert_eq!(
        scope_runs(&db, &runs, Feature::Grounding, "scope-new").await,
        0
    );

    let spend = pool_with(
        PoolLimits {
            pool_spend_micros: Some(1_000),
            ..PoolLimits::default()
        },
        400,
    );
    assert!(admit(&db, &spend, Feature::Grounding, "a", "spend-1")
        .await
        .admitted());
    assert!(admit(&db, &spend, Feature::Grounding, "b", "spend-2")
        .await
        .admitted());
    assert_eq!(
        admit(&db, &spend, Feature::Grounding, "c", "spend-3").await,
        Admission::Exhausted
    );
    let expensive = pool_with(
        PoolLimits {
            pool_spend_micros: Some(100),
            ..PoolLimits::default()
        },
        400,
    );
    assert_eq!(
        admit(&db, &expensive, Feature::Grounding, "a", "spend-4").await,
        Admission::Exhausted
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_stopped_pool_or_a_zero_limit_admits_nothing() {
    let db = test_db().await;
    let stopped = pool_with(PoolLimits::default(), 0).stopped(true);
    assert_eq!(
        admit(&db, &stopped, Feature::SystemAgent, "c", "stop-1").await,
        Admission::Stopped
    );
    assert_eq!(pool_runs(&db, &stopped).await, 0);
    let zero = pool_with(
        PoolLimits {
            system_agent_runs_per_conversation: Some(0),
            ..PoolLimits::default()
        },
        0,
    );
    assert_eq!(
        admit(&db, &zero, Feature::SystemAgent, "c", "zero-1").await,
        Admission::Exhausted
    );
    // Grounding is unlimited in that pool.
    assert!(admit(&db, &zero, Feature::Grounding, "p", "zero-2")
        .await
        .admitted());
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn each_utc_day_starts_over() {
    let db = test_db().await;
    let pool = pool_with(
        PoolLimits {
            system_agent_runs_per_conversation: Some(1),
            ..PoolLimits::default()
        },
        0,
    );
    let next = day().succ_opt().unwrap();
    let ids: Vec<String> = ["day-1", "day-2", "day-3"]
        .iter()
        .map(|id| key(&pool, id))
        .collect();
    let request = |index: usize| Request {
        run_id: &ids[index],
        pool: &pool,
        feature: Feature::SystemAgent,
        scope_id: "conversation-days",
        organization_id: None,
    };
    for (index, on, expected) in [
        (0, day(), Admission::Admitted),
        (1, day(), Admission::Exhausted),
        (2, next, Admission::Admitted),
    ] {
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            reserve_on(&mut tx, &request(index), on).await.unwrap(),
            expected
        );
        tx.commit().await.unwrap();
    }
}
