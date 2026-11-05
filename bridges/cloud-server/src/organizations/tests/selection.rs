//! New content lands in the organization the creator chose, only members
//! may choose one, and admins move content between organizations.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{add, personal_organization, team, ORGS};
use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};

async fn new_ai_chat(app: &axum::Router, token: &str, organization: Option<&str>) -> (u16, Value) {
    let mut body = json!({
        "client_operation_id": Uuid::now_v7(),
        "kind": "ai",
        "shared_title": "Planning",
        "client_session_id": format!("session:ai:{}", Uuid::now_v7()),
        "member_account_ids": [],
    });
    if let Some(organization) = organization {
        body["organization_id"] = json!(organization);
    }
    send(app, "POST", "/v2/chat/conversations", token, Some(body)).await
}

pub(super) async fn organization_of(pool: &PgPool, table: &str, column: &str, id: &str) -> String {
    let sql = format!("SELECT organization_id FROM {table} WHERE {column}::text = $1");
    let (organization,): (String,) = query_as(&sql).bind(id).fetch_one(pool).await.unwrap();
    organization
}

#[tokio::test]
async fn new_conversations_land_in_the_chosen_member_organization() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "sel_owner").await;
    let (_sam, sam_token) = signed_in(&pool, "sel_outsider").await;
    let organization = team(&pool, &alex).await;

    let (status, body) = new_ai_chat(&app, &alex_token, Some(&organization)).await;
    assert!(status == 200 || status == 201, "{status} {body}");
    let conversation = &body["conversation"];
    assert_eq!(
        conversation["organization"]["organization_id"],
        organization.as_str()
    );
    assert_eq!(conversation["organization"]["name"], "Example team");
    let id = conversation["id"].as_str().unwrap();
    let stored = organization_of(&pool, "cloud_chat_conversations", "conversation_id", id).await;
    assert_eq!(stored, organization);

    let (status, body) = new_ai_chat(&app, &alex_token, None).await;
    assert!(status == 200 || status == 201, "{status} {body}");
    assert!(body["conversation"].get("organization").is_none(), "{body}");
    let id = body["conversation"]["id"].as_str().unwrap();
    let stored = organization_of(&pool, "cloud_chat_conversations", "conversation_id", id).await;
    assert_eq!(stored, personal_organization(&pool, &alex).await);

    for target in [organization.as_str(), "org_missing_example"] {
        let (status, _) = new_ai_chat(&app, &sam_token, Some(target)).await;
        assert_eq!(status, 403, "a non-member cannot target {target}");
    }
}

#[tokio::test]
async fn agents_and_tasks_go_only_to_member_organizations() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "sel_agent_owner").await;
    let (sam, sam_token) = signed_in(&pool, "sel_agent_outsider").await;
    let organization = team(&pool, &alex).await;
    let agent = |organization: &str| {
        json!({"name": "Helper", "role": "helper", "systemPrompt": "Help.",
               "organizationId": organization})
    };

    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agents",
        &alex_token,
        Some(agent(&organization)),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let agent_id = body["agent"]["agentId"].as_str().unwrap();
    let stored = organization_of(&pool, "cloud_agent_definitions", "agent_id", agent_id).await;
    assert_eq!(stored, organization);
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/agents",
        &sam_token,
        Some(agent(&organization)),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (403, Some("organization_forbidden"))
    );

    let task = json!({"title": "Check", "prompt": "Check.",
        "schedule": {"kind": "daily", "time": "09:00", "timezone": "UTC"},
        "targetRuntime": "localRequired", "organizationId": organization});
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/scheduled-tasks",
        &sam_token,
        Some(task.clone()),
    )
    .await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/scheduled-tasks",
        &alex_token,
        Some(task),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let task_id = body["task"]["taskId"].as_str().unwrap();
    let stored = organization_of(&pool, "scheduled_tool_tasks", "task_id", task_id).await;
    assert_eq!(stored, organization);

    // The database refuses a writer that skips the check.
    let refused = query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, \
          created_at, organization_id) VALUES ($1, $2, $1, now()::text, $3)",
    )
    .bind(format!("att_sel_{}", Uuid::new_v4().simple()))
    .bind(&sam)
    .bind(&organization)
    .execute(&pool)
    .await
    .unwrap_err();
    assert!(
        super::super::selection::is_member_owner_violation(&refused),
        "{refused}"
    );
}

#[tokio::test]
async fn admins_move_content_between_organizations_they_manage() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "move_owner").await;
    let (priya, priya_token) = signed_in(&pool, "move_member").await;
    let first = team(&pool, &alex).await;
    let second = team(&pool, &alex).await;
    add(&app, &pool, &alex_token, &first, &priya, "member").await;
    let personal = personal_organization(&pool, &alex).await;

    let (_, body) = new_ai_chat(&app, &alex_token, None).await;
    let conversation = body["conversation"]["id"].as_str().unwrap().to_string();
    let transfer = |kind: &str, id: &str, target: &str| json!({"kind": kind, "id": id, "targetOrganizationId": target});
    let path = format!("{ORGS}/{personal}/transfers");
    let (status, body) = send(
        &app,
        "POST",
        &path,
        &alex_token,
        Some(transfer("conversation", &conversation, &first)),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let stored = organization_of(
        &pool,
        "cloud_chat_conversations",
        "conversation_id",
        &conversation,
    )
    .await;
    assert_eq!(stored, first);
    let (events,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'conversation.updated' \
           AND conversation_id = $2::uuid",
    )
    .bind(&alex)
    .bind(&conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(events, 1, "members hear about the move");

    // Priya's agent in the first team cannot move to a team she is not in.
    let agent_id = format!("agent_move_{}", Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_agent_definitions (agent_id, owner_account_id, name, role, \
          system_prompt, created_at, updated_at, avatar_source, avatar_style, avatar_seed, \
          avatar_renderer_version, avatar_version, avatar_updated_at, organization_id) \
         VALUES ($1, $2, 'Helper', 'helper', 'Help.', now()::text, now()::text, 'generated', \
                 'thumbs', $1, 'fixture', 1, now()::text, $3)",
    )
    .bind(&agent_id)
    .bind(&priya)
    .bind(&first)
    .execute(&pool)
    .await
    .unwrap();
    let path = format!("{ORGS}/{first}/transfers");
    let (status, body) = send(
        &app,
        "POST",
        &path,
        &alex_token,
        Some(transfer("agent", &agent_id, &second)),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("owner_not_member"))
    );
    // A plain member manages neither side.
    let priya_personal = personal_organization(&pool, &priya).await;
    let (status, _) = send(
        &app,
        "POST",
        &path,
        &priya_token,
        Some(transfer("agent", &agent_id, &priya_personal)),
    )
    .await;
    assert_eq!(status, 403);
    let stored = organization_of(&pool, "cloud_agent_definitions", "agent_id", &agent_id).await;
    assert_eq!(stored, first, "nothing moved");
}
