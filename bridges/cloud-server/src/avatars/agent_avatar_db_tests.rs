//! Agent avatars in the database: new agents start with a random Kordi bird
//! that the versioned route serves, and an owner's later change reaches every
//! member who shares a group. They use the Common ground fixture and its skip
//! rule: outside CI they return early without `$DATABASE_URL`.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use super::birds::parse_structured_bird_seed;
use super::{generated_avatar_marker, AVATAR_RENDERER_VERSION, BIRD_AVATAR_STYLE};
use crate::auth::accounts::{upsert_account_identity, AccountIdentityUpsert, OAuthProviderId};
use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};
use crate::events::EventBus;
use crate::server::ServerState;

type AvatarColumns = (Option<String>, String, String, String, String, i64);

fn assert_random_bird(columns: &AvatarColumns, version: i64) {
    let (avatar_url, source, style, seed, renderer, stored_version) = columns;
    assert_eq!(source, "generated");
    assert_eq!(style, BIRD_AVATAR_STYLE);
    assert_eq!(renderer, AVATAR_RENDERER_VERSION);
    assert_eq!(*stored_version, version);
    let bird = parse_structured_bird_seed(seed)
        .unwrap_or_else(|| panic!("{seed:?} is not a structured bird seed"));
    assert_eq!(bird.tone, "color");
    assert_eq!(
        avatar_url.as_deref(),
        Some(generated_avatar_marker(BIRD_AVATAR_STYLE, seed, version).as_str())
    );
}

async fn new_account(pool: &PgPool) -> String {
    upsert_account_identity(
        pool,
        AccountIdentityUpsert {
            provider: OAuthProviderId::GitHub,
            provider_subject: format!("bird-{}", Uuid::new_v4().simple()),
            provider_username: None,
            display_name: Some("Bird owner".to_string()),
            email: None,
            email_verified: false,
            avatar_url: None,
        },
    )
    .await
    .expect("create account")
    .account_id
}

async fn get_status(pool: &PgPool, style: &str, seed: &str) -> StatusCode {
    let app = super::routes(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    let response = app
        .oneshot(
            Request::get(format!(
                "/v1/avatars/{AVATAR_RENDERER_VERSION}/{style}/{seed}.png"
            ))
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    if response.status() == StatusCode::OK {
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    }
    response.status()
}

#[tokio::test]
async fn a_new_account_gets_a_random_bird_default_agent() {
    let Some(pool) = pool().await else {
        return;
    };
    let mut seeds = std::collections::BTreeSet::new();
    for _ in 0..12 {
        let account_id = new_account(&pool).await;
        let columns: AvatarColumns = query_as(
            "SELECT avatar_url, avatar_source, avatar_style, avatar_seed, \
                avatar_renderer_version, avatar_version \
             FROM cloud_default_agent_profiles WHERE owner_account_id = $1",
        )
        .bind(&account_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_random_bird(&columns, 1);
        seeds.insert(columns.3);
    }
    // 12 draws from 128 birds all landing on one bird would mean no randomness.
    assert!(seeds.len() > 1, "{seeds:?}");
    let seed = seeds.first().unwrap();
    assert_eq!(
        get_status(&pool, BIRD_AVATAR_STYLE, seed).await,
        StatusCode::OK
    );
}

#[tokio::test]
async fn a_new_factory_agent_without_a_pick_gets_a_random_bird() {
    let Some(pool) = pool().await else {
        return;
    };
    let owner = new_account(&pool).await;
    let agent_id = format!("cloud_agent_{}", Uuid::new_v4().simple());
    let request = serde_json::from_value(serde_json::json!({
        "name": "Wren",
        "role": "Helper",
        "systemPrompt": "Be precise and kind.",
    }))
    .expect("agent request");
    let agent = crate::cloud_agents::store::create_agent_definition(
        &pool,
        &owner,
        agent_id.clone(),
        request,
        Utc::now(),
    )
    .await
    .expect("create agent");
    assert_eq!(agent.avatar.style, BIRD_AVATAR_STYLE);
    assert!(parse_structured_bird_seed(&agent.avatar.seed).is_some());

    let columns: AvatarColumns = query_as(
        "SELECT avatar_url, avatar_source, avatar_style, avatar_seed, \
            avatar_renderer_version, avatar_version \
         FROM cloud_agent_definitions WHERE agent_id = $1",
    )
    .bind(&agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_random_bird(&columns, 1);
    assert_eq!(columns.3, agent.avatar.seed);
    assert_eq!(
        get_status(&pool, BIRD_AVATAR_STYLE, &columns.3).await,
        StatusCode::OK
    );
    assert_eq!(
        get_status(&pool, BIRD_AVATAR_STYLE, "never_stored_bird_seed").await,
        StatusCode::NOT_FOUND
    );
}

/// A group whose members are all active.
async fn group_with(pool: &PgPool, members: &[&str]) {
    let conversation = Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, shared_title, \
         created_by_account_id, client_operation_id, creation_fingerprint, legacy_session_id) \
         VALUES ($1, 'group', 'Birds', $2, $3, 'fixture', $4)",
    )
    .bind(conversation)
    .bind(members[0])
    .bind(Uuid::new_v4())
    .bind(format!("session:group:{}", Uuid::new_v4().simple()))
    .execute(pool)
    .await
    .unwrap();
    for member in members {
        query(
            "INSERT INTO cloud_chat_conversation_members (conversation_id, account_id, role) \
             VALUES ($1, $2, 'member')",
        )
        .bind(conversation)
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn sync_payloads(pool: &PgPool, account_id: &str, event_type: &str) -> Vec<Value> {
    query_as::<_, (Value,)>(
        "SELECT payload FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = $2 ORDER BY stream_seq",
    )
    .bind(account_id)
    .bind(event_type)
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|(payload,)| payload)
    .collect()
}

#[tokio::test]
async fn a_default_agent_avatar_change_reaches_group_members_who_are_not_contacts() {
    let Some(pool) = pool().await else {
        return;
    };
    let app = app(&pool, None);
    let (priya, priya_token) = signed_in(&pool, "bird_priya").await;
    let (alex, _) = signed_in(&pool, "bird_alex").await;
    let (zoe, _) = signed_in(&pool, "bird_zoe").await;
    group_with(&pool, &[&priya, &alex]).await;

    let (status, body) = send(
        &app,
        "PATCH",
        "/v1/cloud/auth/me",
        &priya_token,
        Some(json!({"agentAvatarMutation": {
            "action": "regenerate", "seed": "bird-robin-color-coral", "expectedVersion": 1,
        }})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["defaultAgent"]["avatar"]["seed"],
        "bird-robin-color-coral"
    );
    assert_eq!(body["defaultAgent"]["avatar"]["version"], 2);

    let changed = sync_payloads(&pool, &alex, "account.directory.changed").await;
    assert!(
        changed
            .iter()
            .any(|payload| payload["accountId"] == priya && payload["agentAvatarVersion"] == 2),
        "{changed:?}"
    );
    assert!(sync_payloads(&pool, &zoe, "account.directory.changed")
        .await
        .is_empty());
}

#[tokio::test]
async fn a_shared_factory_agent_avatar_change_reaches_group_members() {
    let Some(pool) = pool().await else {
        return;
    };
    let (priya, _) = signed_in(&pool, "bird_owner").await;
    let (alex, _) = signed_in(&pool, "bird_member").await;
    let (zoe, _) = signed_in(&pool, "bird_outsider").await;
    group_with(&pool, &[&priya, &alex]).await;
    let agent_id = format!("cloud_agent_{}", Uuid::new_v4().simple());
    let request = serde_json::from_value(json!({
        "accessScope": "participant_conversations",
        "name": "Wren",
        "role": "Helper",
        "systemPrompt": "Be precise and kind.",
    }))
    .unwrap();
    crate::cloud_agents::store::create_agent_definition(
        &pool,
        &priya,
        agent_id.clone(),
        request,
        Utc::now(),
    )
    .await
    .unwrap();
    let update = serde_json::from_value(json!({"avatarMutation": {
        "action": "regenerate", "seed": "bird-heron-ink-mint", "expectedVersion": 1,
    }}))
    .unwrap();
    let agent = crate::cloud_agents::store::update_agent_definition(
        &pool,
        &priya,
        &agent_id,
        update,
        Utc::now(),
    )
    .await
    .unwrap()
    .expect("agent exists");
    assert_eq!(
        (agent.avatar.seed.as_str(), agent.avatar.version),
        ("bird-heron-ink-mint", 2)
    );

    let expected = json!({"ownerAccountId": priya, "agentId": agent_id});
    assert!(sync_payloads(&pool, &alex, "agent.directory.changed")
        .await
        .contains(&expected));
    assert!(!sync_payloads(&pool, &zoe, "agent.directory.changed")
        .await
        .contains(&expected));
}
