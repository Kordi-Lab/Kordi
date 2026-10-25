//! Memories routed to Grounding profiles (#1977): the profile memories
//! route, card builds and `memoriesSinceBuild`.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{create_profile, PROFILES};
use super::support::{card_reply, claim, RUNNER};
use crate::common_ground::complete;

const BUILD: &str = "/v1/cloud/common-ground/card/build";
const WORK: &str = "Leads the Atlas data pipeline";
const HEALTH: &str = "Trains for a marathon on weekends";
const LOCATION: &str = "Usually works from the Thuwal campus";
const COORDINATION: &str = "Free on Tuesday mornings";
const PREFERENCE: &str = "Prefers short replies";
const GROUP: &str = "The crew ships the Atlas demo on Friday";
const PINNED: &str = "Reviews papers for the KAUST lab";

pub(super) async fn save(app: &axum::Router, token: &str, body: Value) -> String {
    let (status, saved) = send(app, "POST", "/v1/cloud/memory", token, Some(body)).await;
    assert_eq!(status, 201, "{saved}");
    saved["memory"]["memoryId"].as_str().unwrap().to_string()
}

pub(super) fn own(text: &str, category: &str) -> Value {
    json!({ "scope": "global", "scopeId": "account", "source": "manual",
            "text": text, "category": category })
}

/// A new group conversation with `account` as an active member.
pub(super) async fn group_of(pool: &PgPool, account: &str) -> String {
    let group_id = uuid::Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations(conversation_id, kind, created_by_account_id, \
         client_operation_id, creation_fingerprint, legacy_session_id) \
         VALUES ($1, 'group', $2, $3, 'profile-memories', $4)",
    )
    .bind(group_id)
    .bind(account)
    .bind(uuid::Uuid::new_v4())
    .bind(format!("session:group:{group_id}"))
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_conversation_members(conversation_id, account_id) VALUES ($1, $2)",
    )
    .bind(group_id)
    .bind(account)
    .execute(pool)
    .await
    .unwrap();
    group_id.to_string()
}

/// `(text, everyProfile)` of the memories listed under the profile.
pub(super) async fn listed(app: &axum::Router, token: &str, profile: &str) -> Vec<(String, bool)> {
    let path = format!("{PROFILES}/{profile}/memories");
    let (status, body) = send(app, "GET", &path, token, None).await;
    assert_eq!(status, 200, "{body}");
    let mut out: Vec<(String, bool)> = body["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["text"].as_str().unwrap().to_string(),
                m["everyProfile"].as_bool().unwrap(),
            )
        })
        .collect();
    out.sort();
    out
}

pub(super) fn pairs(items: &[(&str, bool)]) -> Vec<(String, bool)> {
    let mut out: Vec<_> = items.iter().map(|(t, e)| (t.to_string(), *e)).collect();
    out.sort();
    out
}

/// Starts a memory-only build of the profile and returns the evidence it
/// stored, then finishes the run.
pub(super) async fn build(
    app: &axum::Router,
    pool: &PgPool,
    (account, token): (&str, &str),
    profile: &str,
) -> String {
    let (status, body) = send(
        app,
        "POST",
        BUILD,
        token,
        Some(json!({ "profileId": profile, "memory": true })),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["used"], json!(["Memory"]), "{body}");
    let (evidence,): (Value,) =
        query_as("SELECT build_evidence_json FROM cloud_common_ground_cards WHERE profile_id = $1")
            .bind(profile)
            .fetch_one(pool)
            .await
            .unwrap();
    let run_id = claim(pool, account).await;
    let reply = card_reply(&["Agent memory"], &[], &[], &[]);
    complete(pool, &run_id, RUNNER, &reply).await.unwrap();
    evidence.to_string()
}

pub(super) fn assert_texts(evidence: &str, present: &[&str], absent: &[&str]) {
    for text in present {
        assert!(evidence.contains(text), "{text} missing: {evidence}");
    }
    for text in absent {
        assert!(!evidence.contains(text), "{text} leaked: {evidence}");
    }
}

pub(super) async fn since_build(app: &axum::Router, token: &str, profile: &str) -> (i64, i64) {
    let path = format!("/v1/cloud/common-ground/card?profile={profile}");
    let (status, card) = send(app, "GET", &path, token, None).await;
    assert_eq!(status, 200, "{card}");
    let (_, list) = send(app, "GET", PROFILES, token, None).await;
    let listed = list["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["profileId"] == profile)
        .unwrap()["memoriesSinceBuild"]
        .as_i64()
        .unwrap();
    (card["memoriesSinceBuild"].as_i64().unwrap(), listed)
}

#[tokio::test]
async fn memories_route_to_profiles_and_builds() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, token) = signed_in(&pool, "Alex").await;
    let work = create_profile(&app, &token, "work", None).await;
    let health = create_profile(&app, &token, "health", None).await;
    let daily = create_profile(&app, &token, "daily", None).await;
    let custom = create_profile(&app, &token, "custom", Some("KAUST")).await;

    save(&app, &token, own(WORK, "work_context")).await;
    save(&app, &token, own(HEALTH, "health_context")).await;
    save(&app, &token, own(LOCATION, "location_context")).await;
    let coordination = save(&app, &token, own(COORDINATION, "coordination_context")).await;
    save(&app, &token, own(PREFERENCE, "general_preferences")).await;
    let group_id = group_of(&pool, &alex).await;
    save(
        &app,
        &token,
        json!({ "scope": "group", "scopeId": group_id, "source": "manual",
                "text": GROUP, "category": "work_context" }),
    )
    .await;
    // A work memory moved to the custom profile goes there only.
    let pinned = save(&app, &token, own(PINNED, "work_context")).await;
    let (status, body) = send(
        &app,
        "PATCH",
        &format!("/v1/cloud/memory/{pinned}"),
        &token,
        Some(json!({ "profileId": custom })),
    )
    .await;
    assert_eq!(status, 200, "{body}");

    assert_eq!(
        listed(&app, &token, &work).await,
        pairs(&[(WORK, false), (COORDINATION, true)])
    );
    assert_eq!(
        listed(&app, &token, &health).await,
        pairs(&[(HEALTH, false), (COORDINATION, true)])
    );
    assert_eq!(
        listed(&app, &token, &daily).await,
        pairs(&[(LOCATION, false), (COORDINATION, true)])
    );
    assert_eq!(
        listed(&app, &token, &custom).await,
        pairs(&[(PINNED, false)])
    );

    // Another account's profile is not found.
    let (_, other) = signed_in(&pool, "Sam").await;
    let path = format!("{PROFILES}/{work}/memories");
    let (status, body) = send(&app, "GET", &path, &other, None).await;
    assert_eq!(status, 404, "{body}");

    // Never built: every routed memory counts.
    assert_eq!(since_build(&app, &token, &work).await, (2, 2));

    let evidence = build(&app, &pool, (&alex, &token), &work).await;
    assert_texts(
        &evidence,
        &[WORK, COORDINATION],
        &[LOCATION, HEALTH, GROUP, PINNED, PREFERENCE],
    );
    assert_eq!(since_build(&app, &token, &work).await, (0, 0));
    save(&app, &token, own("Mentors two interns", "work_context")).await;
    assert_eq!(since_build(&app, &token, &work).await, (1, 1));

    let evidence = build(&app, &pool, (&alex, &token), &health).await;
    assert_texts(
        &evidence,
        &[HEALTH, COORDINATION],
        &[WORK, LOCATION, GROUP, PINNED, PREFERENCE],
    );

    // A custom build reads its pinned memories and the unpinned own ones.
    let evidence = build(&app, &pool, (&alex, &token), &custom).await;
    assert_texts(
        &evidence,
        &[PINNED, WORK, HEALTH, LOCATION, COORDINATION, PREFERENCE],
        &[GROUP],
    );

    // Pinning a cross-profile memory narrows it to that profile.
    let (status, body) = send(
        &app,
        "PATCH",
        &format!("/v1/cloud/memory/{coordination}"),
        &token,
        Some(json!({ "profileId": health })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        listed(&app, &token, &health).await,
        pairs(&[(HEALTH, false), (COORDINATION, false)])
    );
    let work_list = listed(&app, &token, &work).await;
    assert!(
        work_list.iter().all(|(text, _)| text != COORDINATION),
        "{work_list:?}"
    );

    query("DELETE FROM cloud_chat_conversations WHERE conversation_id = $1::uuid")
        .bind(&group_id)
        .execute(&pool)
        .await
        .unwrap();
}
