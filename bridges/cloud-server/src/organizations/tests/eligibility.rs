//! The owner-eligibility rule: with "content must be owned by a member" on,
//! content whose owner is not a member moves to the owner's personal
//! organization, and runs are charged to a team only while its content
//! qualifies.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::selection::organization_of;
use super::{add, personal_organization, team, ORGS};
use crate::common_ground::tests::db_fixture::{account, app, pool, send, signed_in};

async fn require_member_owners(app: &axum::Router, token: &str, organization: &str) {
    let path = format!("{ORGS}/{organization}");
    let (status, body) = send(
        app,
        "PATCH",
        &path,
        token,
        Some(json!({"memberOwnedContent": true})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["organization"]["memberOwnedContent"], true);
}

/// A group in `organization` owned by `owner`, with `others` as members.
pub(super) async fn group(
    pool: &PgPool,
    organization: &str,
    owner: &str,
    others: &[&str],
) -> (Uuid, String) {
    let id = Uuid::now_v7();
    let session = format!("session:group:{id}");
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, created_by_account_id, \
          client_operation_id, creation_fingerprint, legacy_session_id, organization_id) \
         VALUES ($1, 'group', $2, $3, 'fixture', $4, $5)",
    )
    .bind(id)
    .bind(owner)
    .bind(Uuid::now_v7())
    .bind(&session)
    .bind(organization)
    .execute(pool)
    .await
    .unwrap();
    for (member, role) in
        std::iter::once((owner, "owner")).chain(others.iter().map(|m| (*m, "member")))
    {
        query(
            "INSERT INTO cloud_chat_conversation_members (conversation_id, account_id, role) \
             VALUES ($1, $2, $3)",
        )
        .bind(id)
        .bind(member)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    }
    (id, session)
}

pub(super) async fn conversation_org(pool: &PgPool, id: Uuid) -> String {
    organization_of(
        pool,
        "cloud_chat_conversations",
        "conversation_id",
        &id.to_string(),
    )
    .await
}

async fn queue_run(pool: &PgPool, session: &str, agent_owner: &str) -> String {
    let run_id = format!("run_elig_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
          session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
          updated_at) VALUES ($1, $1, $1, $2, $3, $3, 'queued', '{}', now()::text, now()::text)",
    )
    .bind(&run_id)
    .bind(session)
    .bind(agent_owner)
    .execute(pool)
    .await
    .unwrap();
    run_id
}

async fn agent(pool: &PgPool, owner: &str, organization: &str) -> String {
    let agent_id = format!("agent_elig_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_definitions (agent_id, owner_account_id, name, role, \
          system_prompt, created_at, updated_at, avatar_source, avatar_style, avatar_seed, \
          avatar_renderer_version, avatar_version, avatar_updated_at, organization_id) \
         VALUES ($1, $2, 'Helper', 'helper', 'Help.', now()::text, now()::text, 'generated', \
                 'thumbs', $1, 'fixture', 1, now()::text, $3)",
    )
    .bind(&agent_id)
    .bind(owner)
    .bind(organization)
    .execute(pool)
    .await
    .unwrap();
    agent_id
}

async fn hand_over(app: &axum::Router, token: &str, conversation: Uuid, to: &str) {
    let path = format!("/v2/chat/conversations/{conversation}/owner");
    let body = json!({"client_operation_id": Uuid::now_v7(), "account_id": to});
    let (status, answer) = send(app, "PUT", &path, token, Some(body)).await;
    assert_eq!(status, 200, "{answer}");
}

#[tokio::test]
async fn handing_a_group_to_an_outsider_follows_the_rule() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "elig_hand_owner").await;
    let priya = account(&pool, "elig_hand_outsider").await;
    let relaxed = team(&pool, &alex).await;
    let strict = team(&pool, &alex).await;
    require_member_owners(&app, &alex_token, &strict).await;

    let (kept, _) = group(&pool, &relaxed, &alex, &[&priya]).await;
    hand_over(&app, &alex_token, kept, &priya).await;
    assert_eq!(
        conversation_org(&pool, kept).await,
        relaxed,
        "rule off: it stays"
    );

    let (moved, _) = group(&pool, &strict, &alex, &[&priya]).await;
    hand_over(&app, &alex_token, moved, &priya).await;
    assert_eq!(
        conversation_org(&pool, moved).await,
        personal_organization(&pool, &priya).await,
        "rule on: it moves to the new owner's personal organization"
    );
    let (roles,): (Vec<String>,) = sqlx_core::query_as::query_as(
        "SELECT array_agg(role ORDER BY role) FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND membership_state = 'active'",
    )
    .bind(moved)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(roles, ["admin", "owner"], "everyone stays in the group");
}

#[tokio::test]
async fn removal_moves_content_only_under_the_rule() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "elig_rm_owner").await;
    let priya = account(&pool, "elig_rm_member").await;
    let chen = account(&pool, "elig_rm_relaxed").await;
    let strict = team(&pool, &alex).await;
    let relaxed = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &strict, &priya, "member").await;
    add(&app, &pool, &alex_token, &relaxed, &chen, "member").await;
    require_member_owners(&app, &alex_token, &strict).await;
    let (conversation, _) = group(&pool, &strict, &priya, &[&alex]).await;
    let strict_agent = agent(&pool, &priya, &strict).await;
    let relaxed_agent = agent(&pool, &chen, &relaxed).await;

    let path = format!("{ORGS}/{strict}/members/{priya}");
    assert_eq!(send(&app, "DELETE", &path, &alex_token, None).await.0, 204);
    let home = personal_organization(&pool, &priya).await;
    assert_eq!(conversation_org(&pool, conversation).await, home);
    let stored = organization_of(&pool, "cloud_agent_definitions", "agent_id", &strict_agent).await;
    assert_eq!(stored, home);
    // Priya still owns the group.
    let (owner,): (String,) = sqlx_core::query_as::query_as("SELECT cloud_conversation_owner($1)")
        .bind(conversation)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(owner, priya);

    let path = format!("{ORGS}/{relaxed}/members/{chen}");
    assert_eq!(send(&app, "DELETE", &path, &alex_token, None).await.0, 204);
    let stored =
        organization_of(&pool, "cloud_agent_definitions", "agent_id", &relaxed_agent).await;
    assert_eq!(stored, relaxed, "without the rule, content stays");
}

#[tokio::test]
async fn turning_the_rule_on_moves_content_owned_by_outsiders() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "elig_on_owner").await;
    let (priya, priya_token) = signed_in(&pool, "elig_on_member").await;
    let sam = account(&pool, "elig_on_outsider").await;
    let organization = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &organization, &priya, "member").await;
    let (conversation, _) = group(&pool, &organization, &alex, &[&sam]).await;
    hand_over(&app, &alex_token, conversation, &sam).await;
    assert_eq!(conversation_org(&pool, conversation).await, organization);

    let path = format!("{ORGS}/{organization}");
    let (status, _) = send(
        &app,
        "PATCH",
        &path,
        &priya_token,
        Some(json!({"memberOwnedContent": true})),
    )
    .await;
    assert_eq!(status, 403, "a plain member cannot change the rule");
    require_member_owners(&app, &alex_token, &organization).await;
    assert_eq!(
        conversation_org(&pool, conversation).await,
        personal_organization(&pool, &sam).await
    );
}

#[tokio::test]
async fn runs_are_checked_when_queued_and_when_they_start() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "elig_run_owner").await;
    let priya = account(&pool, "elig_run_guest").await;
    let dana = account(&pool, "elig_run_agent").await;
    let organization = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &organization, &priya, "member").await;
    require_member_owners(&app, &alex_token, &organization).await;
    query(
        "UPDATE cloud_organization_members SET expires_at = now() + interval '1 hour' \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(&organization)
    .bind(&priya)
    .execute(&pool)
    .await
    .unwrap();
    let (conversation, session) = group(&pool, &organization, &priya, &[&dana]).await;
    let task_id = format!("task_elig_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO scheduled_tool_tasks (task_id, owner_account_id, created_by_account_id, \
          title, prompt, schedule_json, target_runtime, status, created_at, updated_at, \
          organization_id) \
         VALUES ($1, $2, $2, 'Check', 'Check.', '{}', 'cloud', 'active', now()::text, \
                 now()::text, $3)",
    )
    .bind(&task_id)
    .bind(&priya)
    .bind(&organization)
    .execute(&pool)
    .await
    .unwrap();
    let task_run = format!("taskrun_elig_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO scheduled_tool_task_runs (run_id, task_id, owner_account_id, status, \
          target_runtime, due_at, created_at, updated_at) \
         VALUES ($1, $2, $3, 'queued', 'cloud', now()::text, now()::text, now()::text)",
    )
    .bind(&task_run)
    .bind(&task_id)
    .bind(&priya)
    .execute(&pool)
    .await
    .unwrap();

    // While Priya is a member, a run in her team group, even by Dana's
    // agent, is charged to the team.
    let early = queue_run(&pool, &session, &dana).await;
    let runs = "cloud_agent_fallback_runs";
    assert_eq!(
        organization_of(&pool, runs, "run_id", &early).await,
        organization
    );
    let task_runs = "scheduled_tool_task_runs";
    assert_eq!(
        organization_of(&pool, task_runs, "run_id", &task_run).await,
        organization
    );

    // Her membership lapses before the sweep runs.
    query(
        "UPDATE cloud_organization_members SET expires_at = now() - interval '1 second' \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(&organization)
    .bind(&priya)
    .execute(&pool)
    .await
    .unwrap();
    let late = queue_run(&pool, &session, &dana).await;
    let dana_home = personal_organization(&pool, &dana).await;
    assert_eq!(
        organization_of(&pool, runs, "run_id", &late).await,
        dana_home,
        "at enqueue"
    );
    query("UPDATE cloud_agent_fallback_runs SET status = 'leased' WHERE run_id = $1")
        .bind(&early)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        organization_of(&pool, runs, "run_id", &early).await,
        dana_home,
        "at start"
    );
    query("UPDATE scheduled_tool_task_runs SET status = 'running' WHERE run_id = $1")
        .bind(&task_run)
        .execute(&pool)
        .await
        .unwrap();
    let priya_home = personal_organization(&pool, &priya).await;
    assert_eq!(
        organization_of(&pool, task_runs, "run_id", &task_run).await,
        priya_home
    );

    // The sweep ends the membership and moves her content home.
    super::super::selection::expire_memberships(&pool)
        .await
        .unwrap();
    assert_eq!(conversation_org(&pool, conversation).await, priya_home);
    let stored = organization_of(&pool, "scheduled_tool_tasks", "task_id", &task_id).await;
    assert_eq!(stored, priya_home);
}

#[tokio::test]
async fn a_channel_joins_its_groups_organization() {
    let Some(pool) = pool().await else { return };
    let alex = account(&pool, "elig_chan_owner").await;
    let sam = account(&pool, "elig_chan_outsider").await;
    let organization = team(&pool, &alex).await;
    let (_, session) = group(&pool, &organization, &alex, &[&sam]).await;
    let request = crate::chat_sync::models::CreateConversationRequest {
        client_operation_id: Uuid::now_v7(),
        kind: crate::chat_sync::models::ConversationKind::Group,
        shared_title: Some("Planning".to_string()),
        client_session_id: format!("session:group:{}", Uuid::now_v7()),
        member_account_ids: Vec::new(),
        organization_id: None,
    };
    let channel = crate::chat_sync::store::create_group_channel(&pool, &sam, &session, request)
        .await
        .unwrap()
        .value;
    assert_eq!(conversation_org(&pool, channel.id).await, organization);
    assert_eq!(channel.organization.unwrap().organization_id, organization);
}
