//! Cloud Agent Definition API tests.
//!
//! Store/API integration tests use DATABASE_URL when available and skip on
//! developer machines without Postgres, matching existing cloud-server e2e tests.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use kordi_cloud_server::auth::rate_limit::{CloudRateLimitConfig, CloudRateLimiter};
use kordi_cloud_server::events::EventBus;
use kordi_cloud_server::pg::init_pool;
use kordi_cloud_server::server::{router_with_rate_limiter, ServerState};
use serde_json::{json, Value};
use tower::util::ServiceExt;

async fn try_pool() -> Option<sqlx_postgres::PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    match init_pool(&url).await {
        Ok(pool) => Some(pool),
        Err(err) => {
            eprintln!("[cloud_agent_definitions_e2e] init_pool failed, skipping: {err}");
            None
        }
    }
}

fn test_router(pool: sqlx_postgres::PgPool) -> axum::Router {
    let limiter = CloudRateLimiter::memory(CloudRateLimitConfig {
        per_ip_limit: 10_000,
        per_ip_window: Duration::from_secs(60),
        per_email_failure_limit: 5,
        per_email_lockout: Duration::from_secs(900),
    });
    router_with_rate_limiter(Arc::new(ServerState::new(pool, EventBus::noop())), limiter)
}

fn unique_email(prefix: &str) -> String {
    format!(
        "{prefix}-{}@cloud-agent.e2e.local",
        uuid::Uuid::new_v4().simple()
    )
}

fn request(method: Method, uri: &str, token: Option<&str>, body: Body) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder
        .header("content-type", "application/json")
        .body(body)
        .unwrap()
}

async fn read_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    if bytes.is_empty() {
        return Value::Null;
    }
    serde_json::from_slice(&bytes).unwrap()
}

async fn signup(router: &axum::Router, prefix: &str) -> (String, String) {
    let email = unique_email(prefix);
    let response = router
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/cloud/auth/signup",
            None,
            Body::from(
                json!({
                    "email": email,
                    "password": "correct horse",
                    "displayName": prefix,
                    "avatarSeed": "agent_definition_avatar",
                })
                .to_string(),
            ),
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = read_json(response).await;
    assert!(status.is_success(), "signup failed: {body}");
    let token = body["session"]["token"].as_str().unwrap().to_string();
    let account_id = body["account"]["accountId"].as_str().unwrap().to_string();
    assert_ne!(
        body["account"]["avatar"]["seed"].as_str(),
        Some(account_id.as_str())
    );
    let avatar = router
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/avatars/dicebear-rust-10.6.0-styles-10.5.0/lorelei/agent_definition_avatar.png?v=1",
            None,
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(avatar.status(), StatusCode::OK);
    (account_id, token)
}

fn sample_agent_body(name: &str) -> Value {
    json!({
        "accessScope": "private",
        "name": name,
        "role": "Technical Support Agent",
        "description": "Answers questions about the docs.",
        "systemPrompt": "You are a precise documentation support agent.",
        "sourceSummary": "Description-only docs helper",
        "boundaries": ["Do not claim account access", "Use only provided sources"],
        "resources": [{ "kind": "text", "value": "Docs helper", "summary": "Seed description" }],
        "skills": [{ "name": "navigate-knowledge", "description": "Find source-backed answers" }],
        "modelRouting": { "defaultModel": "openai/gpt-5.1" }
    })
}

#[test]
fn cloud_agent_routes_are_mounted_in_source() {
    let server_source = std::fs::read_to_string("src/server.rs").expect("read server source");
    let routes_source = std::fs::read_to_string("src/cloud_agents/routes.rs")
        .expect("read cloud agent routes source");
    assert!(server_source.contains("cloud_agents::routes::routes"));
    assert!(routes_source.contains("/v1/cloud/agents"));
    let models_source = std::fs::read_to_string("src/cloud_agents/models.rs")
        .expect("read cloud agent models source");
    let store_source = std::fs::read_to_string("src/cloud_agents/store.rs")
        .expect("read cloud agent store source");
    assert!(models_source.contains("participant_conversations"));
    assert!(store_source.contains("access_scope = $4"));
}

#[test]
fn shared_cloud_agent_lookup_is_mention_safe_in_source() {
    let routes = std::fs::read_to_string("src/cloud_agents/routes.rs")
        .expect("read cloud agent routes source");
    let models = std::fs::read_to_string("src/cloud_agents/models.rs")
        .expect("read cloud agent models source");
    let store = std::fs::read_to_string("src/cloud_agents/store.rs")
        .expect("read cloud agent store source");

    assert!(routes.contains("/v1/cloud/agents/shared"));
    assert!(models.contains("SharedCloudAgentSummary"));
    assert!(store.contains("list_shared_agent_summaries"));
    assert!(models.contains("pub struct SharedCloudAgentSummary"));
    let summary_start = models
        .find("pub struct SharedCloudAgentSummary")
        .expect("summary struct");
    let summary_source = &models[summary_start
        ..models[summary_start..]
            .find("}\n")
            .map(|index| summary_start + index)
            .unwrap_or(models.len())];
    assert!(!summary_source.contains("system_prompt"));
    assert!(!summary_source.contains("model_routing"));
    assert!(!summary_source.contains("resources"));
}

#[tokio::test]
async fn private_cloud_agents_are_owner_scoped_and_emit_sync_events() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(pool.clone());
    let (owner_id, owner_token) = signup(&router, "agent-owner").await;
    let (other_id, other_token) = signup(&router, "agent-other").await;

    let create_response = router
        .clone()
        .oneshot(request(
            Method::POST,
            "/v1/cloud/agents",
            Some(&owner_token),
            Body::from(sample_agent_body("Docs Helper").to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::CREATED);
    let created = read_json(create_response).await;
    let agent_id = created["agent"]["agentId"].as_str().unwrap().to_string();
    assert!(agent_id.starts_with("cloud_agent_"));
    assert_eq!(created["agent"]["ownerAccountId"], owner_id);
    assert_eq!(created["agent"]["accessScope"], "private");
    assert_eq!(created["agent"]["name"], "Docs Helper");
    assert_ne!(
        created["agent"]["avatar"]["seed"].as_str(),
        Some(agent_id.as_str())
    );

    let owner_list = router
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/cloud/agents",
            Some(&owner_token),
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(owner_list.status(), StatusCode::OK);
    let owner_body = read_json(owner_list).await;
    assert_eq!(owner_body["agents"].as_array().unwrap().len(), 1);
    assert_eq!(owner_body["agents"][0]["agentId"], agent_id);

    let other_list = router
        .clone()
        .oneshot(request(
            Method::GET,
            "/v1/cloud/agents",
            Some(&other_token),
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(other_list.status(), StatusCode::OK);
    assert!(read_json(other_list).await["agents"]
        .as_array()
        .unwrap()
        .is_empty());

    let other_update = router
        .clone()
        .oneshot(request(
            Method::PUT,
            &format!("/v1/cloud/agents/{agent_id}"),
            Some(&other_token),
            Body::from(json!({ "name": "Stolen" }).to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(other_update.status(), StatusCode::NOT_FOUND);

    let unversioned_avatar_update = router
        .clone()
        .oneshot(request(
            Method::PUT,
            &format!("/v1/cloud/agents/{agent_id}"),
            Some(&owner_token),
            Body::from(
                json!({
                    "avatarMutation": {
                        "action": "regenerate",
                        "seed": "next_agent_avatar"
                    }
                })
                .to_string(),
            ),
        ))
        .await
        .unwrap();
    assert_eq!(unversioned_avatar_update.status(), StatusCode::BAD_REQUEST);

    let now = chrono::Utc::now().to_rfc3339();
    sqlx_core::query::query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at)
         VALUES ($1, $2, $3), ($2, $1, $3) ON CONFLICT DO NOTHING",
    )
    .bind(&owner_id)
    .bind(&other_id)
    .bind(&now)
    .execute(&pool)
    .await
    .unwrap();

    let owner_update = router
        .clone()
        .oneshot(request(
            Method::PUT,
            &format!("/v1/cloud/agents/{agent_id}"),
            Some(&owner_token),
            Body::from(
                json!({ "name": "Docs Helper updated", "accessScope": "participant_conversations" })
                    .to_string(),
            ),
        ))
        .await
        .unwrap();
    assert_eq!(owner_update.status(), StatusCode::OK);
    let updated = read_json(owner_update).await;
    assert_eq!(updated["agent"]["name"], "Docs Helper updated");
    assert_eq!(updated["agent"]["accessScope"], "participant_conversations");

    let owner_archive = router
        .clone()
        .oneshot(request(
            Method::DELETE,
            &format!("/v1/cloud/agents/{agent_id}"),
            Some(&owner_token),
            Body::empty(),
        ))
        .await
        .unwrap();
    assert_eq!(owner_archive.status(), StatusCode::OK);
    assert_eq!(
        read_json(owner_archive).await["agent"]["status"],
        "archived"
    );

    let events: Vec<(String, serde_json::Value)> = sqlx_core::query_as::query_as(
        "SELECT event_type, payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type LIKE 'agent.definition.%' \
         ORDER BY stream_seq ASC",
    )
    .bind(&owner_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].0, "agent.definition.upserted");
    assert_eq!(events[1].0, "agent.definition.upserted");
    assert_eq!(events[2].0, "agent.definition.archived");
    assert_eq!(events[0].1["agent"]["agentId"], agent_id);

    let viewer_events: Vec<(String, serde_json::Value)> = sqlx_core::query_as::query_as(
        "SELECT event_type, payload FROM cloud_chat_user_sync_events
         WHERE account_id = $1 AND event_type = 'agent.directory.changed'
         ORDER BY stream_seq ASC",
    )
    .bind(&other_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(viewer_events.len(), 2);
    assert_eq!(viewer_events[0].1["agentId"], agent_id);
    assert!(viewer_events[0].1.get("agent").is_none());
    assert!(!viewer_events[0].1.to_string().contains("systemPrompt"));
}

#[tokio::test]
async fn cloud_agent_create_rejects_unsupported_access() {
    let Some(pool) = try_pool().await else { return };
    let router = test_router(pool);
    let (_owner_id, owner_token) = signup(&router, "agent-private-only").await;
    let mut body = sample_agent_body("Public Attempt");
    body["accessScope"] = json!("public");

    let response = router
        .oneshot(request(
            Method::POST,
            "/v1/cloud/agents",
            Some(&owner_token),
            Body::from(body.to_string()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        read_json(response).await["errorCode"],
        "invalid_cloud_agent"
    );
}
