//! New owned records get their owner's personal organization.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::{personal_organization, team};
use crate::common_ground::tests::db_fixture::{account, app, pool, send, signed_in};

#[tokio::test]
async fn a_conversation_opened_by_the_server_belongs_to_its_creator() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "own_alex").await;
    let (priya, priya_token) = signed_in(&pool, "own_priya").await;
    let requests = "/v1/cloud/contacts/requests";
    let (status, body) = send(
        &app,
        "POST",
        requests,
        &alex_token,
        Some(json!({"peerAccountId": priya})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let request_id = body["request"]["requestId"].as_str().unwrap().to_string();
    let path = format!("{requests}/{request_id}/accept");
    let (status, body) = send(&app, "POST", &path, &priya_token, None).await;
    assert_eq!(status, 200, "{body}");

    let rows: Vec<(String, Option<String>)> = query_as(
        "SELECT c.created_by_account_id, c.organization_id FROM cloud_chat_conversations c \
         JOIN cloud_chat_conversation_members a \
           ON a.conversation_id = c.conversation_id AND a.account_id = $1 \
         JOIN cloud_chat_conversation_members b \
           ON b.conversation_id = c.conversation_id AND b.account_id = $2",
    )
    .bind(&alex)
    .bind(&priya)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(!rows.is_empty(), "accepting opens a direct conversation");
    for (creator, organization) in rows {
        assert_eq!(
            organization,
            Some(personal_organization(&pool, &creator).await)
        );
    }
}

#[tokio::test]
async fn every_owned_table_fills_an_empty_organization_and_keeps_a_named_one() {
    let Some(pool) = pool().await else { return };
    let owner = account(&pool, "own_tables").await;
    let personal = personal_organization(&pool, &owner).await;
    let named = team(&pool, &owner).await;
    let id = Uuid::new_v4().simple().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    for (suffix, organization) in [("empty", None), ("named", Some(named.as_str()))] {
        let key = format!("{id}_{suffix}");
        query(
            "INSERT INTO cloud_chat_conversations (conversation_id, kind, created_by_account_id, \
              client_operation_id, creation_fingerprint, organization_id) \
             VALUES ($1, 'group', $2, $3, 'fixture', $4)",
        )
        .bind(Uuid::new_v4())
        .bind(&owner)
        .bind(Uuid::new_v4())
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_agent_definitions (agent_id, owner_account_id, name, role, \
              system_prompt, created_at, updated_at, avatar_source, avatar_style, avatar_seed, \
              avatar_renderer_version, avatar_version, avatar_updated_at, organization_id) \
             VALUES ($1, $2, 'Helper', 'helper', 'Help.', $3, $3, 'generated', 'thumbs', $1, \
                     'fixture', 1, $3, $4)",
        )
        .bind(format!("agent_{key}"))
        .bind(&owner)
        .bind(&now)
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id, \
              session_id, owner_account_id, requester_account_id, status, prompt, created_at, \
              updated_at, organization_id) \
             VALUES ($1, $1, $1, 'session-fixture', $2, $2, 'completed', '{}', $3, $3, $4)",
        )
        .bind(format!("run_{key}"))
        .bind(&owner)
        .bind(&now)
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
        query(
            "INSERT INTO scheduled_tool_tasks (task_id, owner_account_id, created_by_account_id, \
              title, prompt, schedule_json, target_runtime, status, created_at, updated_at, \
              organization_id) \
             VALUES ($1, $2, $2, 'Check', 'Check.', '{}', 'cloud', 'active', $3, $3, $4)",
        )
        .bind(format!("task_{key}"))
        .bind(&owner)
        .bind(&now)
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
        query(
            "INSERT INTO scheduled_tool_task_runs (run_id, task_id, owner_account_id, status, \
              target_runtime, due_at, created_at, updated_at, organization_id) \
             VALUES ($1, $2, $3, 'queued', 'cloud', $4, $4, $4, $5)",
        )
        .bind(format!("taskrun_{key}"))
        .bind(format!("task_{key}"))
        .bind(&owner)
        .bind(&now)
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
        query(
            "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, \
              created_at, organization_id) VALUES ($1, $2, $1, $3, $4)",
        )
        .bind(format!("att_{key}"))
        .bind(&owner)
        .bind(&now)
        .bind(organization)
        .execute(&pool)
        .await
        .unwrap();
    }

    let rows: Vec<(String, i64, i64, i64)> = query_as(
        "SELECT t, count(*) FILTER (WHERE organization_id = $2), \
                count(*) FILTER (WHERE organization_id = $3), \
                count(*) FILTER (WHERE organization_id IS NULL) \
         FROM ( \
           SELECT 'conversations' t, organization_id FROM cloud_chat_conversations \
             WHERE created_by_account_id = $1 \
           UNION ALL SELECT 'definitions', organization_id FROM cloud_agent_definitions \
             WHERE owner_account_id = $1 \
           UNION ALL SELECT 'runs', organization_id FROM cloud_agent_fallback_runs \
             WHERE owner_account_id = $1 \
           UNION ALL SELECT 'tasks', organization_id FROM scheduled_tool_tasks \
             WHERE owner_account_id = $1 \
           UNION ALL SELECT 'task runs', organization_id FROM scheduled_tool_task_runs \
             WHERE owner_account_id = $1 \
           UNION ALL SELECT 'attachments', organization_id FROM cloud_attachments \
             WHERE owner_account_id = $1 \
         ) owned GROUP BY t ORDER BY t",
    )
    .bind(&owner)
    .bind(&personal)
    .bind(&named)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 6);
    for (table, in_personal, in_named, empty) in rows {
        assert_eq!((in_personal, in_named, empty), (1, 1, 0), "{table}");
    }
}

#[tokio::test]
async fn deleting_an_account_deletes_its_personal_organization() {
    let Some(pool) = pool().await else { return };
    let owner = account(&pool, "own_deleted").await;
    let personal = personal_organization(&pool, &owner).await;
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, created_at) \
         VALUES ($1, $2, $1, now()::text)",
    )
    .bind(format!("att_deleted_{}", Uuid::new_v4().simple()))
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    query("DELETE FROM cloud_accounts WHERE account_id = $1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let (organizations, members): (i64, i64) = query_as(
        "SELECT (SELECT count(*) FROM cloud_organizations WHERE organization_id = $1), \
                (SELECT count(*) FROM cloud_organization_members WHERE organization_id = $1)",
    )
    .bind(&personal)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((organizations, members), (0, 0));
}
