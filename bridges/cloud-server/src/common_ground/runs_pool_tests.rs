//! Grounding runs and resource pools against a real database. Ignored by
//! default; run them with a task-owned PostgreSQL in `DATABASE_URL`.

use std::sync::Arc;

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{insert, mark_failed, NewRun};
use crate::plan_cards::tests::{seed_account, seed_conversation};
use crate::resource_pools::usage::tests::test_db;
use crate::resource_pools::{test_provider, PoolLimits, ResourcePool, ResourcePools};

async fn queue(
    pool: &PgPool,
    config: &crate::system_agent::SystemAgentConfig,
    person: &str,
    conversation_id: Option<Uuid>,
) -> (String, bool) {
    let run_id = format!("cg_card_{}", Uuid::new_v4().simple());
    let mut tx = pool.begin().await.unwrap();
    let queued = insert(
        &mut tx,
        config,
        NewRun {
            run_id: &run_id,
            requester: person,
            conversation_id,
            prompt: "Synthetic evidence.".to_string(),
            system_prompt: "Synthetic instructions.",
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    (run_id, queued)
}

async fn route_of(pool: &PgPool, run_id: &str) -> Option<(String, String, Option<String>)> {
    query_as(
        "SELECT runtime_route_json->>'resourcePool', runtime_route_json->>'defaultModel', organization_id
         FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .unwrap()
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in DATABASE_URL"]
async fn grounding_runs_follow_the_organization_pool_and_its_person_limit() {
    let pool = test_db().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (service, person) = (format!("service-{suffix}"), format!("person-{suffix}"));
    for account in [&service, &person] {
        seed_account(&pool, account).await;
    }
    let team = format!("org_test_{suffix}");
    query(
        "INSERT INTO cloud_organizations (organization_id, name, kind, created_by_account_id) \
         VALUES ($1, 'Example team', 'team', $2)",
    )
    .bind(&team)
    .bind(&person)
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
         VALUES ($1, $2, 'owner')",
    )
    .bind(&team)
    .bind(&person)
    .execute(&pool)
    .await
    .unwrap();
    let team_chat = Uuid::new_v4();
    seed_conversation(&pool, team_chat, &person, &[&person]).await;
    query("UPDATE cloud_chat_conversations SET organization_id = $2 WHERE conversation_id = $1")
        .bind(team_chat)
        .bind(&team)
        .execute(&pool)
        .await
        .unwrap();

    let (shared_id, partner_id) = (format!("shared-{suffix}"), format!("partner-{suffix}"));
    let pools = ResourcePools::new(
        vec![
            ResourcePool::new(shared_id.clone(), test_provider("shared-model")).with_limits(
                PoolLimits {
                    grounding_runs_per_person: Some(2),
                    ..PoolLimits::default()
                },
            ),
            ResourcePool::new(partner_id.clone(), test_provider("partner-model"))
                .with_grounding(test_provider("partner-grounding-model")),
        ],
        &shared_id,
        [(team.clone(), partner_id.clone())],
    )
    .unwrap();
    let mut config = crate::system_agent::test_config(&service);
    config.resource_pools = Arc::new(pools);

    let (first, queued) = queue(&pool, &config, &person, None).await;
    assert!(queued);
    let (route_pool, model, organization) = route_of(&pool, &first).await.unwrap();
    assert_eq!(
        (route_pool.as_str(), model.as_str()),
        (shared_id.as_str(), "shared-model")
    );
    let (personal,): (String,) =
        query_as("SELECT organization_id FROM cloud_organizations WHERE personal_account_id = $1")
            .bind(&person)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(organization.as_deref(), Some(personal.as_str()));
    assert!(queue(&pool, &config, &person, None).await.1);
    let (refused, queued) = queue(&pool, &config, &person, None).await;
    assert!(!queued, "the person's daily Grounding runs are used up");
    assert!(
        route_of(&pool, &refused).await.is_none(),
        "nothing was queued"
    );

    // The same person in a team conversation uses the team's pool.
    let (team_run, queued) = queue(&pool, &config, &person, Some(team_chat)).await;
    assert!(queued);
    let (route_pool, model, organization) = route_of(&pool, &team_run).await.unwrap();
    assert_eq!(route_pool, partner_id);
    assert_eq!(model, "partner-grounding-model");
    assert_eq!(organization.as_deref(), Some(team.as_str()));

    // A run that fails before any runner claims it gives its run back.
    let mut tx = pool.begin().await.unwrap();
    assert!(
        mark_failed(&mut tx, &first, None, "cancelled", "Cancelled.")
            .await
            .unwrap()
    );
    tx.commit().await.unwrap();
    assert!(queue(&pool, &config, &person, None).await.1);
}
