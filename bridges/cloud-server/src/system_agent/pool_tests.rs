//! System agent passes and resource pools against a real database. Ignored
//! by default; run them with a task-owned PostgreSQL in `DATABASE_URL`.

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;
use crate::plan_cards::models::{PlanCardProposeArgs, PlanCardState};
use crate::plan_cards::tests::{participant, seed_account, seed_conversation};
use crate::resource_pools::usage::tests::test_db;
use crate::resource_pools::{test_provider, PoolLimits, ResourcePool, ResourcePools};

pub(crate) async fn say(pool: &PgPool, sender: &str, conversation_id: Uuid, text: &str) {
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v4(),
        kind: "text".to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    crate::chat_sync::store::send_message(pool, sender, conversation_id, request)
        .await
        .expect("send message");
    query("UPDATE cloud_chat_messages SET created_at = now() - interval '5 minutes' WHERE conversation_id = $1")
        .bind(conversation_id)
        .execute(pool)
        .await
        .unwrap();
}

pub(crate) async fn group_chat(pool: &PgPool, creator: &str, system_agent: &str) -> Uuid {
    let chat = Uuid::new_v4();
    seed_conversation(pool, chat, creator, &[creator, system_agent]).await;
    query("UPDATE cloud_chat_conversations SET legacy_session_id = $2 WHERE conversation_id = $1")
        .bind(chat)
        .bind(format!("session-{chat}"))
        .execute(pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_pip_conversation_state (conversation_id) VALUES ($1)")
        .bind(chat)
        .execute(pool)
        .await
        .unwrap();
    chat
}

/// A team organization owned by `owner`.
pub(crate) async fn team(pool: &PgPool, owner: &str) -> String {
    let id = format!("org_test_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id) \
         VALUES ($1, 'Example team', 'team', $2)",
    )
    .bind(&id)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    id
}

pub(crate) async fn sweep(pool: &PgPool, config: &super::SystemAgentConfig) -> usize {
    query("UPDATE cloud_pip_conversation_state SET checked_at = now() - interval '1 hour'")
        .execute(pool)
        .await
        .unwrap();
    super::store::sweep(pool, config).await.expect("sweep")
}

/// (run id, pool in its route, organization) of each System agent run.
async fn runs_in(pool: &PgPool, chat: Uuid) -> Vec<(String, Option<String>, Option<String>)> {
    query_as(
        "SELECT run.run_id, run.runtime_route_json->>'resourcePool', run.organization_id
         FROM cloud_agent_fallback_runs run
         JOIN cloud_chat_conversations c ON c.legacy_session_id = run.session_id
         WHERE c.conversation_id = $1 AND run.run_id LIKE 'pip\\_%'
         ORDER BY run.created_at",
    )
    .bind(chat)
    .fetch_all(pool)
    .await
    .unwrap()
}

pub(crate) fn config_with(system_agent: &str, pools: ResourcePools) -> super::SystemAgentConfig {
    let mut config = super::test_config(system_agent);
    config.resource_pools = crate::resource_pools::ResourcePoolRegistry::new(pools);
    config
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn conversations_of_two_organizations_use_their_own_pools() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&pool, account).await;
    }
    let team = team(&pool, &jordan).await;
    let pools = ResourcePools::new(
        vec![
            ResourcePool::new(format!("shared-{suffix}"), test_provider("shared-model")),
            ResourcePool::new(format!("partner-{suffix}"), test_provider("partner-model")),
        ],
        &format!("shared-{suffix}"),
        [(team.clone(), format!("partner-{suffix}"))],
    )
    .unwrap();
    let config = config_with(&system_agent, pools);

    // Jordan's personal chat and a chat of Jordan's team.
    let personal_chat = group_chat(&pool, &jordan, &system_agent).await;
    let team_chat = group_chat(&pool, &jordan, &system_agent).await;
    query("UPDATE cloud_chat_conversations SET organization_id = $2 WHERE conversation_id = $1")
        .bind(team_chat)
        .bind(&team)
        .execute(&pool)
        .await
        .unwrap();
    let (personal_org,): (String,) =
        query_as("SELECT organization_id FROM cloud_organizations WHERE personal_account_id = $1")
            .bind(&jordan)
            .fetch_one(&pool)
            .await
            .unwrap();
    for chat in [personal_chat, team_chat] {
        say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    }
    assert_eq!(sweep(&pool, &config).await, 2);

    let personal = runs_in(&pool, personal_chat).await;
    assert_eq!(personal.len(), 1);
    assert_eq!(
        personal[0].1.as_deref(),
        Some(format!("shared-{suffix}").as_str())
    );
    assert_eq!(personal[0].2.as_deref(), Some(personal_org.as_str()));
    let teams = runs_in(&pool, team_chat).await;
    assert_eq!(teams.len(), 1);
    assert_eq!(
        teams[0].1.as_deref(),
        Some(format!("partner-{suffix}").as_str())
    );
    // The run belongs to the conversation's organization, not the System
    // agent's personal one.
    assert_eq!(teams[0].2.as_deref(), Some(team.as_str()));
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn an_exhausted_pool_stays_silent_without_a_backlog() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&pool, account).await;
    }
    let limited = ResourcePool::new(format!("limited-{suffix}"), test_provider("model"))
        .with_limits(PoolLimits {
            system_agent_runs_per_conversation: Some(1),
            ..PoolLimits::default()
        });
    let config = config_with(&system_agent, ResourcePools::single(limited));
    let chat = group_chat(&pool, &jordan, &system_agent).await;

    // The day's one pass runs and finishes.
    say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    assert_eq!(sweep(&pool, &config).await, 1);
    let (run_id, _, _) = runs_in(&pool, chat).await.remove(0);
    query("UPDATE cloud_agent_fallback_runs SET status = 'running', claimed_by = 'runner-test' WHERE run_id = $1")
        .bind(&run_id)
        .execute(&pool)
        .await
        .unwrap();
    super::store::complete(
        &pool,
        &run_id,
        "runner-test",
        r#"{"message":null,"hooksHandled":[]}"#,
    )
    .await
    .unwrap();
    let (state,): (String,) =
        query_as("SELECT state FROM cloud_resource_pool_reservations WHERE run_id = $1")
            .bind(&run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(state, "consumed");

    // A plan due within two hours and a new message: the reminder and the
    // message are both due, but the pool is used up.
    let card = crate::plan_cards::store::propose(
        &pool,
        &jordan,
        PlanCardProposeArgs {
            conversation_id: chat,
            existing_event_id: None,
            existing_revision: None,
            title: "Dinner".to_string(),
            start_at: Some((Utc::now() + Duration::minutes(90)).to_rfc3339()),
            end_at: None,
            location: None,
            state: PlanCardState::AwaitingConfirmation,
            unresolved_fields: Vec::new(),
            participants: vec![participant(&jordan, "Jordan", true)],
            source_message_ids: Vec::new(),
            options: Vec::new(),
        },
    )
    .await
    .expect("propose");
    say(&pool, &jordan, chat, "Should we move dinner to 8?").await;
    assert_eq!(sweep(&pool, &config).await, 0, "nothing is queued");
    assert_eq!(runs_in(&pool, chat).await.len(), 1, "no new run");

    let (seen, latest, hooks): (i64, i64, Value) = query_as(
        "SELECT state.seen_sequence, c.latest_message_sequence, state.hooks_fired
         FROM cloud_pip_conversation_state state
         JOIN cloud_chat_conversations c ON c.conversation_id = state.conversation_id
         WHERE state.conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(seen, latest, "the messages are not kept for later");
    assert_eq!(
        hooks[format!("t_minus_2h:{}", card.event_id)],
        json!(true),
        "the reminder will not fire later"
    );
    let (posted,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_chat_messages WHERE conversation_id = $1 AND sender_account_id = $2",
    )
    .bind(chat)
    .bind(&system_agent)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(posted, 0, "the System agent says nothing");
    // The chat is quiet now: nothing makes the next sweep pick it again.
    assert_eq!(sweep(&pool, &config).await, 0);
    assert_eq!(runs_in(&pool, chat).await.len(), 1);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn a_failed_pass_that_never_left_the_queue_gives_its_run_back() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&pool, account).await;
    }
    let pool_id = format!("retry-{suffix}");
    let limited =
        ResourcePool::new(pool_id.clone(), test_provider("model")).with_limits(PoolLimits {
            system_agent_runs_per_conversation: Some(1),
            ..PoolLimits::default()
        });
    let config = config_with(&system_agent, ResourcePools::single(limited));
    let chat = group_chat(&pool, &jordan, &system_agent).await;
    say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    assert_eq!(sweep(&pool, &config).await, 1);
    let (run_id, _, _) = runs_in(&pool, chat).await.remove(0);
    // Cancelled before any runner claimed it, as a stale-run release does.
    super::store::fail(&pool, &run_id, None, "cancelled")
        .await
        .unwrap();
    super::store::fail(&pool, &run_id, None, "cancelled")
        .await
        .unwrap();
    let runs = crate::resource_pools::usage::runs_on(
        &pool,
        &pool_id,
        crate::resource_pools::usage::usage_day(),
        Some(crate::resource_pools::Feature::SystemAgent),
        &chat.to_string(),
    )
    .await
    .unwrap();
    assert_eq!(runs, 0);
}
