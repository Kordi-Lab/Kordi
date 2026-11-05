//! System agent passes in personal conversations of members whose
//! organization covers their personal work. Ignored by default; run them
//! with a task-owned PostgreSQL in `DATABASE_URL`.

use chrono::Utc;
use uuid::Uuid;

use super::pool_tests::{config_with, group_chat, runs_in, say, sweep, team};
use crate::plan_cards::tests::seed_account;
use crate::resource_pools::coverage::tests::{join, personal_organization, sponsored};
use crate::resource_pools::usage::{runs_on, usage_day};
use crate::resource_pools::{Feature, PoolLimits, ResourcePool};

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_covered_members_personal_chat_uses_the_sponsor_pool_and_its_worker() {
    let db = crate::resource_pools::usage::tests::test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let [system_agent, owner, member, outsider, expired] =
        ["system-agent", "owner", "member", "outsider", "expired"]
            .map(|name| format!("{name}-{suffix}"));
    for account in [&system_agent, &owner, &member, &outsider, &expired] {
        seed_account(&db, account).await;
    }
    let sponsor = team(&db, &owner).await;
    join(&db, &sponsor, &member, None).await;
    join(
        &db,
        &sponsor,
        &expired,
        Some(Utc::now() - chrono::Duration::hours(1)),
    )
    .await;
    let sponsor_pool = format!("sponsor-{suffix}");
    let limited = ResourcePool::pool_worker(&sponsor_pool, None, 0).with_limits(PoolLimits {
        system_agent_runs_per_conversation: Some(5),
        ..PoolLimits::default()
    });
    let config = config_with(&system_agent, sponsored(&sponsor, limited, true));
    config
        .resource_pool_registry()
        .worker_sightings()
        .note(&sponsor_pool);

    let chats = [
        group_chat(&db, &member, &system_agent).await,
        group_chat(&db, &outsider, &system_agent).await,
        group_chat(&db, &expired, &system_agent).await,
    ];
    for (chat, person) in chats.iter().zip([&member, &outsider, &expired]) {
        say(&db, person, *chat, "Dinner Friday at 7?").await;
    }
    assert_eq!(sweep(&db, &config).await, 3);
    let [covered, outside, lapsed] = [0, 1, 2].map(|i| chats[i]);
    let run = runs_in(&db, covered).await.remove(0);
    assert_eq!(run.1.as_deref(), Some(sponsor_pool.as_str()));
    // The run still belongs to the member's personal organization.
    let personal = personal_organization(&db, &member).await;
    assert_eq!(run.2.as_deref(), Some(personal.as_str()));
    for chat in [outside, lapsed] {
        assert_eq!(runs_in(&db, chat).await[0].1.as_deref(), Some("shared"));
    }
    // The pass counts against the sponsor pool's limits.
    let counted = runs_on(
        &db,
        &sponsor_pool,
        usage_day(),
        Some(Feature::SystemAgent),
        &covered.to_string(),
    )
    .await
    .unwrap();
    assert_eq!(counted, 1);

    // The sponsor's worker leases it: the covered run is not refused as
    // rebound.
    let leased =
        crate::pool_workers::store::lease(&db, &config.resource_pools(), &sponsor_pool, "worker-a")
            .await
            .unwrap()
            .expect("the covered run");
    assert_eq!(leased.run_id, run.0);

    // Without a recently seen worker the member's next chat uses the
    // default pool.
    let unseen = config_with(&system_agent, (*config.resource_pools()).clone());
    let next = group_chat(&db, &member, &system_agent).await;
    say(&db, &member, next, "Lunch tomorrow?").await;
    assert_eq!(sweep(&db, &unseen).await, 1);
    assert_eq!(runs_in(&db, next).await[0].1.as_deref(), Some("shared"));
}
