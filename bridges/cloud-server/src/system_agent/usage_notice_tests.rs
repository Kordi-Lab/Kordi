//! Usage notices against a real database: the paused line in a conversation
//! and the owners' threshold notices, each once per window. Ignored by
//! default; run them with a task-owned PostgreSQL in `DATABASE_URL`.

use chrono::Utc;
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::pool_tests::{config_with, group_chat, runs_in, say, sweep, team};
use crate::plan_cards::tests::seed_account;
use crate::resource_pools::notices::{record_thresholds, NewThreshold};
use crate::resource_pools::snapshot::resets_at;
use crate::resource_pools::usage::tests::test_db;
use crate::resource_pools::usage::{reserve, Request};
use crate::resource_pools::{test_provider, Feature, PoolLimits, ResourcePool, ResourcePools};

/// (text, usageLimit) of each System notice in the conversation.
async fn notices(pool: &PgPool, chat: Uuid) -> Vec<(String, Value)> {
    let rows: Vec<(Value,)> = query_as(
        "SELECT content FROM cloud_chat_messages
         WHERE conversation_id = $1 AND message_kind = 'system-notice'
         ORDER BY conversation_sequence",
    )
    .bind(chat)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(content,)| {
            (
                content["blocks"][0]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                content["usageLimit"].clone(),
            )
        })
        .collect()
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

/// Moves a pool's counters and a conversation's notices to yesterday, as if
/// the window had rolled over.
async fn roll_over(pool: &PgPool, pool_id: &str, chat: Uuid) {
    query("UPDATE cloud_resource_pool_usage SET usage_day = usage_day - 1 WHERE pool_id = $1")
        .bind(pool_id)
        .execute(pool)
        .await
        .unwrap();
    query("UPDATE cloud_usage_notices SET usage_day = usage_day - 1 WHERE scope_id = $1")
        .bind(chat.to_string())
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_pool_at_its_cap_posts_one_paused_line_per_window() {
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
    let config = config_with(&system_agent, ResourcePools::single(capped));
    let chat = group_chat(&pool, &jordan, &system_agent).await;

    say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    assert_eq!(sweep(&pool, &config).await, 1);
    finish(&pool, &runs_in(&pool, chat).await[0].0).await;
    assert!(
        notices(&pool, chat).await.is_empty(),
        "no line below the cap"
    );

    // Three refused passes in one window: one line.
    for text in ["Or Saturday at 8?", "Anyone?", "Dinner Sunday then?"] {
        say(&pool, &jordan, chat, text).await;
        assert_eq!(sweep(&pool, &config).await, 0);
    }
    let lines = notices(&pool, chat).await;
    assert_eq!(lines.len(), 1, "one paused line per window");
    let (text, limit) = &lines[0];
    assert_eq!(text, "Daily limit reached. Resets at 00:00 UTC.");
    assert_eq!(limit["reached"], "daily_limit");
    let reset = resets_at(Utc::now()).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    assert_eq!(limit["resetsAt"], reset.as_str());
    let organization: Option<String> = sqlx_core::query_scalar::query_scalar(
        "SELECT organization_id FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(limit["organizationId"].as_str(), organization.as_deref());
    let paused = crate::resource_pools::notices::paused_on(&pool, chat, Utc::now().date_naive())
        .await
        .unwrap()
        .expect("the pause is recorded on the conversation");
    assert_eq!(paused.resets_at, reset);
    // The line wakes no pass of its own.
    assert_eq!(sweep(&pool, &config).await, 0);

    // A new window admits a pass again, and a refusal posts a new line.
    roll_over(&pool, &pool_id, chat).await;
    say(&pool, &jordan, chat, "New day, dinner tonight?").await;
    assert_eq!(sweep(&pool, &config).await, 1, "the new window admits");
    finish(&pool, &runs_in(&pool, chat).await[1].0).await;
    say(&pool, &jordan, chat, "Dinner Saturday at 7?").await;
    assert_eq!(sweep(&pool, &config).await, 0);
    say(&pool, &jordan, chat, "Lunch Sunday at noon?").await;
    assert_eq!(sweep(&pool, &config).await, 0);
    assert_eq!(
        notices(&pool, chat).await.len(),
        2,
        "one line in each window"
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_stopped_pool_says_an_owner_paused_it() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&pool, account).await;
    }
    let stopped =
        ResourcePool::new(format!("stopped-{suffix}"), test_provider("model")).stopped(true);
    let config = config_with(&system_agent, ResourcePools::single(stopped));
    let chat = group_chat(&pool, &jordan, &system_agent).await;
    for text in ["Dinner Friday at 7?", "Hello?"] {
        say(&pool, &jordan, chat, text).await;
        assert_eq!(sweep(&pool, &config).await, 0);
    }
    assert!(runs_in(&pool, chat).await.is_empty());
    let lines = notices(&pool, chat).await;
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].0, "Paused by an owner.");
    assert_eq!(lines[0].1["reached"], "stopped");
}

async fn admit(
    pool: &PgPool,
    resource_pool: &ResourcePool,
    organization: &str,
    scope: &str,
) -> bool {
    let run_id = format!("pip_{}", Uuid::new_v4().simple());
    let mut tx = pool.begin().await.unwrap();
    let admitted = reserve(
        &mut tx,
        &Request {
            run_id: &run_id,
            pool: resource_pool,
            feature: Feature::SystemAgent,
            scope_id: scope,
            organization_id: Some(organization),
        },
    )
    .await
    .unwrap()
    .admitted();
    tx.commit().await.unwrap();
    admitted
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn owners_get_one_notice_at_75_and_one_at_90_per_window() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (jordan, sam) = (format!("jordan-{suffix}"), format!("sam-{suffix}"));
    for account in [&jordan, &sam] {
        seed_account(&pool, account).await;
    }
    let busy = team(&pool, &jordan).await;
    let idle = team(&pool, &sam).await;
    let capped = ResourcePool::new(format!("shared-{suffix}"), test_provider("model")).with_limits(
        PoolLimits {
            pool_runs: Some(10),
            ..PoolLimits::default()
        },
    );
    let pools = ResourcePools::new(
        vec![capped.clone()],
        capped.id(),
        [
            (busy.clone(), capped.id().to_string()),
            (idle.clone(), capped.id().to_string()),
        ],
    )
    .unwrap();
    let mine = |notices: Vec<NewThreshold>| -> Vec<u8> {
        notices
            .into_iter()
            .filter(|n| n.organization_id == busy || n.organization_id == idle)
            .map(|n| {
                assert_eq!(
                    n.organization_id, busy,
                    "only organizations that used the pool today"
                );
                n.threshold
            })
            .collect()
    };

    for _ in 0..7 {
        assert!(admit(&pool, &capped, &busy, "chat-a").await);
    }
    assert!(mine(record_thresholds(&pool, &pools, Utc::now()).await.unwrap()).is_empty());
    assert!(admit(&pool, &capped, &busy, "chat-b").await);
    assert_eq!(
        mine(record_thresholds(&pool, &pools, Utc::now()).await.unwrap()),
        [75]
    );
    assert!(mine(record_thresholds(&pool, &pools, Utc::now()).await.unwrap()).is_empty());
    assert!(admit(&pool, &capped, &busy, "chat-b").await);
    assert_eq!(
        mine(record_thresholds(&pool, &pools, Utc::now()).await.unwrap()),
        [90]
    );
    assert!(admit(&pool, &capped, &busy, "chat-c").await);
    assert!(
        !admit(&pool, &capped, &busy, "chat-c").await,
        "the cap holds"
    );
    assert!(mine(record_thresholds(&pool, &pools, Utc::now()).await.unwrap()).is_empty());

    let sent = crate::resource_pools::notices::thresholds_on(&pool, &busy, Utc::now().date_naive())
        .await
        .unwrap();
    assert_eq!(
        sent.iter().map(|n| n.threshold).collect::<Vec<_>>(),
        [90, 75]
    );
    assert!(
        crate::resource_pools::notices::thresholds_on(&pool, &idle, Utc::now().date_naive())
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn passing_both_thresholds_at_once_sends_only_the_higher() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let jordan = format!("jordan-{suffix}");
    seed_account(&pool, &jordan).await;
    let busy = team(&pool, &jordan).await;
    let capped = ResourcePool::new(format!("burst-{suffix}"), test_provider("model")).with_limits(
        PoolLimits {
            pool_runs: Some(2),
            ..PoolLimits::default()
        },
    );
    let pools = ResourcePools::single(capped.clone());
    assert!(admit(&pool, &capped, &busy, "chat").await);
    assert!(admit(&pool, &capped, &busy, "chat").await);
    let due: Vec<u8> = record_thresholds(&pool, &pools, Utc::now())
        .await
        .unwrap()
        .into_iter()
        .filter(|n| n.organization_id == busy)
        .map(|n| n.threshold)
        .collect();
    assert_eq!(due, [90]);
    let recorded =
        crate::resource_pools::notices::thresholds_on(&pool, &busy, Utc::now().date_naive())
            .await
            .unwrap();
    assert_eq!(
        recorded.len(),
        2,
        "both thresholds count as sent for the window"
    );
}
