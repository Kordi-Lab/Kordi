//! Exercises the real HTTP surface — the running router, auth middleware,
//! and JSON wire shapes — not just the store functions directly. This is
//! what actually proves `/v1/cloud/plan_cards` works end to end.

use serde_json::{json, Value};
use sqlx_core::query::query;
use std::sync::Arc;
use uuid::Uuid;

use crate::auth::session::issue_session;
use crate::events::EventBus;
use crate::server::{router, ServerState};

async fn seed_account(pool: &sqlx_postgres::PgPool, account_id: &str) {
    query("INSERT INTO cloud_accounts(account_id,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at,avatar_url) VALUES($1,$2,$2,'generated','lorelei',$1,'test',1,$2,$3)")
        .bind(account_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(crate::avatars::generated_avatar_marker("lorelei", account_id, 1))
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_conversation(
    pool: &sqlx_postgres::PgPool,
    conversation_id: Uuid,
    created_by: &str,
    members: &[&str],
) {
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint) VALUES($1,'group',$2,$3,'test')")
        .bind(conversation_id)
        .bind(created_by)
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .unwrap();
    for member in members {
        query(
            "INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,$2)",
        )
        .bind(conversation_id)
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Mints a real bearer token the same way login does: a device row, then a
/// genuine session issued through `auth::session::issue_session`.
async fn bearer_token_for(pool: &sqlx_postgres::PgPool, account_id: &str) -> String {
    let device_id = format!("device_{}", Uuid::new_v4().simple());
    query("INSERT INTO cloud_devices(device_id,account_id,device_public_key,created_at,last_seen_at) VALUES($1,$2,'test-key',$3,$3)")
        .bind(&device_id)
        .bind(account_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .unwrap();
    issue_session(pool, account_id, &device_id, 1)
        .await
        .unwrap()
        .plaintext_token
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn full_lifecycle_over_real_http() {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");

    let suffix = Uuid::new_v4().simple().to_string();
    let jordan = format!("jordan-{suffix}");
    let maya = format!("maya-{suffix}");
    let riya = format!("riya-{suffix}");
    for account in [&jordan, &maya, &riya] {
        seed_account(&pool, account).await;
    }
    let conversation_id = Uuid::new_v4();
    seed_conversation(&pool, conversation_id, &jordan, &[&jordan, &maya, &riya]).await;

    let jordan_token = bearer_token_for(&pool, &jordan).await;
    let riya_token = bearer_token_for(&pool, &riya).await;

    // Bind an ephemeral local port and run the REAL router — the same one
    // `main.rs` serves in production, auth middleware and all.
    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    let server = tokio::spawn(async move {
        axum::serve(listener, router(state)).await.unwrap();
    });
    let base = format!("http://{addr}");
    let client = reqwest::Client::new();

    // Missing auth is rejected before it ever reaches the store.
    let unauthenticated = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .json(&json!({"action": "propose"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), 401);

    // Members never propose over HTTP: only PiP opens and revises cards.
    let propose_body = json!({
        "action": "propose",
        "conversationId": conversation_id.to_string(),
        "title": "Lunch this weekend?",
        "state": "polling",
        "unresolvedFields": ["startAt", "location"],
        "participants": [
            {"participantId": jordan, "displayName": "Jordan", "organizer": true},
            {"participantId": maya, "displayName": "Maya", "organizer": false},
            {"participantId": riya, "displayName": "Riya", "organizer": false},
        ],
        "sourceMessageIds": ["msg_1"],
    });
    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&jordan_token)
        .json(&propose_body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403, "members cannot propose cards");

    // PiP proposes through the same request shape inside its own chat.
    let request: super::wire::Request = serde_json::from_value(propose_body).unwrap();
    let pip = super::routes::Actor {
        account_id: jordan.clone(),
        on_behalf_of_conversation: Some(conversation_id),
    };
    let card = super::routes::dispatch_row(&pool, &pip, request)
        .await
        .unwrap_or_else(|_| panic!("PiP's propose should succeed"));
    let card = serde_json::to_value(card).unwrap();
    assert_eq!(card["state"], "polling");
    assert_eq!(card["revision"], 1);
    let event_id = card["eventId"].as_str().unwrap().to_string();
    assert_eq!(card["participants"].as_array().unwrap().len(), 3);

    // Conflict recovery is read-only and requires current membership.
    let snapshot_url = format!("{base}/v1/cloud/plan_cards/{event_id}");
    let response = client.get(&snapshot_url).send().await.unwrap();
    assert_eq!(response.status(), 401);
    let outsider = format!("outsider-{suffix}");
    seed_account(&pool, &outsider).await;
    let outsider_token = bearer_token_for(&pool, &outsider).await;
    let response = client
        .get(&snapshot_url)
        .bearer_auth(&outsider_token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let response = client
        .get(&snapshot_url)
        .bearer_auth(&jordan_token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let snapshot: Value = response.json().await.unwrap();
    assert_eq!(snapshot, card);

    // An ordinary chat member who is not on the plan cannot confirm it.
    query("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,$2)")
        .bind(conversation_id)
        .bind(&outsider)
        .execute(&pool)
        .await
        .unwrap();
    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&outsider_token)
        .json(&json!({"action":"confirm","eventId":event_id,"revision":1,"confirmedBy":outsider}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);

    // A non-organizer participant still cannot cancel the plan for everyone.
    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&riya_token)
        .json(&json!({
            "action": "cancel",
            "eventId": event_id,
            "revision": 1,
            "canceledBy": riya,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        403,
        "only the organizer or an admin cancels"
    );

    // An ordinary participant cannot confirm; a chat admin can, even with
    // only the organizer answered and everyone else still pending.
    let denied = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&riya_token)
        .json(&json!({"action":"confirm","eventId":event_id,"revision":1,"confirmedBy":riya}))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    query("UPDATE cloud_chat_conversation_members SET role='admin' WHERE conversation_id=$1 AND account_id=$2")
        .bind(conversation_id).bind(&riya).execute(&pool).await.unwrap();
    assert_eq!(
        card["participants"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["rsvp"] != "pending")
            .count(),
        1
    );
    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&riya_token)
        .json(&json!({
            "action": "confirm",
            "eventId": event_id,
            "revision": 1,
            "confirmedBy": riya,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let card: Value = response.json().await.unwrap();
    assert_eq!(card["state"], "confirmed");
    assert_eq!(card["revision"], 2);
    assert!(card["managerIds"]
        .as_array()
        .unwrap()
        .contains(&json!(riya)));

    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&jordan_token)
        .json(
            &json!({"action": "cancel", "eventId": event_id, "revision": 1, "canceledBy": jordan}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["errorCode"], "plan_card_revision_conflict");
    let response = client
        .get(&snapshot_url)
        .bearer_auth(&jordan_token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let snapshot: Value = response.json().await.unwrap();
    assert_eq!(
        snapshot, card,
        "reading recovery state must not mutate the plan"
    );

    // Riya declines — over HTTP, as Riya, with Riya's own token. The route
    // must reject a participantId that doesn't match the caller's own
    // account, so this only works because it's Riya's own bearer token.
    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&riya_token)
        .json(&json!({
            "action": "rsvp",
            "eventId": event_id,
            "revision": 2,
            "participantId": riya,
            "rsvp": "no",
            "note": "Riya can't make it — lunch is still on for the rest of you",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let card: Value = response.json().await.unwrap();
    assert_eq!(
        card["state"], "confirmed",
        "one non-organizer decline over real HTTP must not cancel the plan"
    );
    let riya_status = card["participants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["participantId"] == riya)
        .unwrap();
    assert_eq!(riya_status["rsvp"], "no");

    // Riya cannot RSVP on Jordan's behalf using her own token.
    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&riya_token)
        .json(&json!({
            "action": "rsvp",
            "eventId": event_id,
            "revision": 3,
            "participantId": jordan,
            "rsvp": "no",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        403,
        "cannot rsvp on someone else's behalf"
    );

    // Cancel, then confirm cannot revive a canceled plan.
    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&jordan_token)
        .json(&json!({
            "action": "cancel",
            "eventId": event_id,
            "revision": 3,
            "canceledBy": jordan,
            "reason": "Something came up",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let card: Value = response.json().await.unwrap();
    assert_eq!(card["state"], "canceled");

    let response = client
        .post(format!("{base}/v1/cloud/plan_cards"))
        .bearer_auth(&jordan_token)
        .json(&json!({
            "action": "confirm",
            "eventId": event_id,
            "revision": card["revision"],
            "confirmedBy": jordan,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409, "cannot confirm a canceled plan");

    server.abort();
}
