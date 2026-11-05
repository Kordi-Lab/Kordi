//! Usage pauses and Settings snapshots against a real database: a pool at its
//! cap adds nothing to any conversation, the pause is recorded once per
//! window, and Settings shows it with the caller's role. Ignored by default;
//! run them with a task-owned PostgreSQL in `DATABASE_URL`.

use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::pool_tests::{config_with, group_chat, runs_in, say, sweep, team};
use crate::organizations::{OrganizationRole, PERSONAL_KIND, TEAM_KIND};
use crate::plan_cards::tests::seed_account;
use crate::resource_pools::routes::organization_snapshots;
use crate::resource_pools::snapshot::{Reached, UsageSnapshot};
use crate::resource_pools::usage::tests::test_db;
use crate::resource_pools::{test_provider, PoolLimits, ResourcePool, ResourcePools};

/// Messages in the conversation not sent by `member`: anything the System
/// agent, System or the server added.
async fn added_messages(pool: &PgPool, chat: Uuid, member: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_chat_messages WHERE conversation_id = $1 AND sender_account_id <> $2",
    )
    .bind(chat)
    .bind(member)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

/// (limit id, reached, paused at) of each pause recorded for `chat`.
async fn pauses(pool: &PgPool, chat: Uuid) -> Vec<(String, String, DateTime<Utc>)> {
    query_as(
        "SELECT limit_id, reached, paused_at FROM cloud_usage_pauses
         WHERE conversation_id = $1 ORDER BY usage_day, paused_at",
    )
    .bind(chat.to_string())
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn finish(pool: &PgPool, run_id: &str) {
    query("UPDATE cloud_agent_fallback_runs SET status = 'running', claimed_by = 'runner-test' WHERE run_id = $1")
        .bind(run_id)
        .execute(pool)
        .await
        .unwrap();
    super::store::complete(
        pool,
        run_id,
        "runner-test",
        r#"{"message":null,"hooksHandled":[]}"#,
    )
    .await
    .unwrap();
}

/// Moves a pool's counters and pauses to yesterday, as if the window had
/// rolled over.
async fn roll_over(pool: &PgPool, pool_id: &str) {
    for table in ["cloud_resource_pool_usage", "cloud_usage_pauses"] {
        query(&format!(
            "UPDATE {table} SET usage_day = usage_day - 1 WHERE pool_id = $1"
        ))
        .bind(pool_id)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn organization_of(pool: &PgPool, chat: Uuid) -> String {
    let (organization,): (String,) =
        query_as("SELECT organization_id FROM cloud_chat_conversations WHERE conversation_id = $1")
            .bind(chat)
            .fetch_one(pool)
            .await
            .unwrap();
    organization
}

fn by_id<'a>(snapshots: &'a [UsageSnapshot], id: &str) -> &'a UsageSnapshot {
    snapshots
        .iter()
        .find(|snapshot| snapshot.limit_id == id)
        .unwrap_or_else(|| panic!("no snapshot {id}"))
}

fn rfc3339(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_pool_at_its_cap_adds_nothing_to_the_chat_and_records_one_pause_per_window() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&pool, account).await;
    }
    let pool_id = format!("capped-{suffix}");
    let capped = ResourcePool::new(&pool_id, test_provider("model")).with_limits(PoolLimits {
        system_agent_runs_per_conversation: Some(1),
        ..PoolLimits::default()
    });
    let pools = ResourcePools::single(capped);
    let config = config_with(&system_agent, pools.clone());
    let chat = group_chat(&pool, &jordan, &system_agent).await;
    let quiet = group_chat(&pool, &jordan, &system_agent).await;

    say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    assert_eq!(sweep(&pool, &config).await, 1);
    finish(&pool, &runs_in(&pool, chat).await[0].0).await;
    assert!(
        pauses(&pool, chat).await.is_empty(),
        "no pause below the cap"
    );

    // Three refused passes in one window: nothing in the chat, one pause.
    for text in [
        "Or Saturday at 8?",
        "Lunch Sunday at noon?",
        "Dinner Monday at 7?",
    ] {
        say(&pool, &jordan, chat, text).await;
        assert_eq!(sweep(&pool, &config).await, 0);
    }
    assert_eq!(
        added_messages(&pool, chat, &jordan).await,
        0,
        "a pool at its cap adds nothing to the conversation"
    );
    let recorded = pauses(&pool, chat).await;
    assert_eq!(recorded.len(), 1, "one pause per window");
    assert_eq!(
        (recorded[0].0.as_str(), recorded[0].1.as_str()),
        ("conversation.system_agent_runs", "daily_limit")
    );

    // Settings shows the busiest chat, the reason, and since when.
    let organization = organization_of(&pool, chat).await;
    assert_eq!(organization, organization_of(&pool, quiet).await);
    let now = Utc::now();
    let snapshots = organization_snapshots(
        &pool,
        &pools,
        &jordan,
        &organization,
        PERSONAL_KIND,
        Some(OrganizationRole::Owner),
        now,
    )
    .await
    .unwrap();
    let busiest = by_id(&snapshots, "conversation.system_agent_runs");
    assert_eq!(busiest.conversation_id, Some(chat.to_string()));
    assert_eq!((busiest.used, busiest.limit), (Some(1), Some(1)));
    assert_eq!(busiest.reached, Reached::DailyLimit);
    assert_eq!(
        busiest.resets_at,
        rfc3339(crate::resource_pools::snapshot::resets_at(now))
    );
    assert_eq!(busiest.paused_since, Some(rfc3339(recorded[0].2)));

    // A new window admits a pass again, and the next refusal records a new
    // pause.
    roll_over(&pool, &pool_id).await;
    let fresh = organization_snapshots(
        &pool,
        &pools,
        &jordan,
        &organization,
        PERSONAL_KIND,
        Some(OrganizationRole::Owner),
        Utc::now(),
    )
    .await
    .unwrap();
    let fresh = by_id(&fresh, "conversation.system_agent_runs");
    assert_eq!(
        (fresh.used, fresh.reached, fresh.paused_since.as_deref()),
        (Some(0), Reached::None, None)
    );
    say(&pool, &jordan, chat, "New day, dinner tonight at 7?").await;
    assert_eq!(sweep(&pool, &config).await, 1, "the new window admits");
    finish(&pool, &runs_in(&pool, chat).await[1].0).await;
    for text in ["Dinner Saturday at 7?", "Lunch Sunday at noon?"] {
        say(&pool, &jordan, chat, text).await;
        assert_eq!(sweep(&pool, &config).await, 0);
    }
    assert_eq!(
        pauses(&pool, chat).await.len(),
        2,
        "one pause in each window"
    );
    assert_eq!(added_messages(&pool, chat, &jordan).await, 0);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_stopped_pool_is_paused_by_an_owner_without_a_word_in_the_chat() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&pool, account).await;
    }
    let stopped = ResourcePool::new(format!("stopped-{suffix}"), test_provider("model"))
        .with_limits(PoolLimits {
            pool_runs: Some(100),
            ..PoolLimits::default()
        })
        .stopped(true);
    let pools = ResourcePools::single(stopped);
    let config = config_with(&system_agent, pools.clone());
    let chat = group_chat(&pool, &jordan, &system_agent).await;
    for text in ["Dinner Friday at 7?", "Lunch Saturday at noon?"] {
        say(&pool, &jordan, chat, text).await;
        assert_eq!(sweep(&pool, &config).await, 0);
    }
    assert!(runs_in(&pool, chat).await.is_empty());
    assert_eq!(added_messages(&pool, chat, &jordan).await, 0);
    let recorded = pauses(&pool, chat).await;
    assert_eq!(recorded.len(), 1);
    assert_eq!(
        (recorded[0].0.as_str(), recorded[0].1.as_str()),
        ("pool.stopped", "stopped")
    );
    let organization = organization_of(&pool, chat).await;
    let snapshots = organization_snapshots(
        &pool,
        &pools,
        &jordan,
        &organization,
        PERSONAL_KIND,
        Some(OrganizationRole::Owner),
        Utc::now(),
    )
    .await
    .unwrap();
    let runs = by_id(&snapshots, "pool.runs");
    assert_eq!(runs.reached, Reached::Stopped);
    assert_eq!(runs.paused_since, Some(rfc3339(recorded[0].2)));
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn members_see_percentages_and_owners_see_amounts() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (system_agent, jordan, sam) = (
        format!("system-agent-{suffix}"),
        format!("jordan-{suffix}"),
        format!("sam-{suffix}"),
    );
    for account in [&system_agent, &jordan, &sam] {
        seed_account(&pool, account).await;
    }
    let organization = team(&pool, &jordan).await;
    for (account, role) in [(&jordan, "owner"), (&sam, "member")] {
        query(
            "INSERT INTO cloud_organization_members (organization_id, account_id, role)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(&organization)
        .bind(account)
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    }
    let pool_id = format!("team-{suffix}");
    let capped = ResourcePool::new(
        &pool_id,
        test_provider("model").with_estimated_cost_micros(10_000),
    )
    .with_limits(PoolLimits {
        system_agent_runs_per_conversation: Some(4),
        pool_runs: Some(10),
        pool_spend_micros: Some(1_000_000),
        ..PoolLimits::default()
    });
    let pools = ResourcePools::new(
        vec![capped],
        &pool_id,
        [(organization.clone(), pool_id.clone())],
    )
    .unwrap();
    let config = config_with(&system_agent, pools.clone());
    let chat = group_chat(&pool, &jordan, &system_agent).await;
    query("INSERT INTO cloud_chat_conversation_members (conversation_id, account_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(chat)
        .bind(&sam)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE cloud_chat_conversations SET organization_id = $2 WHERE conversation_id = $1")
        .bind(chat)
        .bind(&organization)
        .execute(&pool)
        .await
        .unwrap();
    say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    assert_eq!(sweep(&pool, &config).await, 1);

    let now = Utc::now();
    let owner = organization_snapshots(
        &pool,
        &pools,
        &jordan,
        &organization,
        TEAM_KIND,
        Some(OrganizationRole::Owner),
        now,
    )
    .await
    .unwrap();
    let ids: Vec<_> = owner.iter().map(|s| s.limit_id).collect();
    assert_eq!(
        ids,
        ["conversation.system_agent_runs", "pool.runs", "pool.spend"],
        "no Grounding limit outside a personal organization"
    );
    let spend = by_id(&owner, "pool.spend");
    assert_eq!(
        (spend.used, spend.limit, spend.used_percent),
        (Some(10_000), Some(1_000_000), 1)
    );
    assert_eq!(
        by_id(&owner, "conversation.system_agent_runs").used_percent,
        25
    );

    let member = organization_snapshots(
        &pool,
        &pools,
        &sam,
        &organization,
        TEAM_KIND,
        Some(OrganizationRole::Member),
        now,
    )
    .await
    .unwrap();
    assert_eq!(member.len(), owner.len());
    for snapshot in &member {
        assert_eq!(
            (snapshot.used, snapshot.limit),
            (None, None),
            "{} hides amounts from members",
            snapshot.limit_id
        );
    }
    assert_eq!(by_id(&member, "pool.spend").used_percent, 1);
    let shared = by_id(&member, "conversation.system_agent_runs");
    assert_eq!(
        (shared.conversation_id.clone(), shared.used_percent),
        (Some(chat.to_string()), 25)
    );
}
