//! Grounding never sends the card or name of someone who declined AI
//! (`crate::ai_consent`) to the model: room matches, room themes, Nearby
//! request checks, and group intros.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::{pool, send};
use super::nearby_support::{claim_check, located, need, north, setup, spot, PEOPLE};
use super::support::{make_contacts, people_in_a_room};

async fn decline(pool: &PgPool, account: &str) {
    query("UPDATE cloud_accounts SET ai_consent_status = 'declined' WHERE account_id = $1")
        .bind(account)
        .execute(pool)
        .await
        .unwrap();
}

fn ids(cards: &Value) -> Vec<String> {
    cards
        .as_array()
        .unwrap()
        .iter()
        .map(|card| card["accountId"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn room_matches_and_themes_leave_out_people_who_declined() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Declinia"]).await;
    let [(alex, alex_token), (priya, _), (declined, declined_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    decline(&pool, &declined).await;
    let results = format!("/v1/cloud/common-ground/rooms/{code}/results");
    let (status, body) = send(&app, "POST", &results, &alex_token, None).await;
    assert_eq!(status, 200, "{body}");
    let (room_id,): (Uuid,) = query_as(
        "SELECT room_id FROM cloud_common_ground_rooms WHERE code = $1 AND closed_at IS NULL",
    )
    .bind(&code)
    .fetch_one(&pool)
    .await
    .unwrap();
    let runs: Vec<(String, Option<String>, Value)> = query_as(
        "SELECT kind, viewer_account_id, cards_json FROM cloud_common_ground_match_runs \
         WHERE room_id = $1",
    )
    .bind(room_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let matched = runs
        .iter()
        .find(|(kind, viewer, _)| kind == "match" && viewer.as_deref() == Some(alex.as_str()))
        .expect("a match run for Alex");
    assert_eq!(ids(&matched.2), [alex.clone(), priya.clone()]);
    let themes = runs
        .iter()
        .find(|(kind, _, _)| kind == "room")
        .expect("a theme run");
    assert!(!ids(&themes.2).contains(&declined), "{}", themes.2);

    // The person who declined gets no match run of their own.
    let (status, body) = send(&app, "POST", &results, &declined_token, None).await;
    assert_eq!(status, 200, "{body}");
    let (own,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs WHERE viewer_account_id = $1",
    )
    .bind(&declined)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(own, 0);
}

#[tokio::test]
async fn nearby_checks_leave_out_people_who_declined() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (me, token) = located(&app, &pool, "Viewer", here).await;
    let (maya, _) = located(&app, &pool, "Maya", north(here, 200.0)).await;
    let (declined, _) = located(&app, &pool, "Declinia", north(here, 250.0)).await;
    decline(&pool, &declined).await;
    need(
        &app,
        &token,
        json!({"text": "Retrieval people up for coffee", "range": 500}),
    )
    .await;
    let (status, body) = send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(status, 200, "{body}");
    let (_, refs) = claim_check(&pool, &me).await;
    let checked: Vec<String> = refs.into_iter().map(|(_, account)| account).collect();
    assert_eq!(checked, [maya]);
}

#[tokio::test]
async fn group_intros_leave_out_people_who_declined() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Declinia"]).await;
    let [(alex, alex_token), (priya, _), (declined, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    make_contacts(&pool, &alex, &priya).await;
    make_contacts(&pool, &alex, &declined).await;
    decline(&pool, &declined).await;
    let (status, group) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/group"),
        &alex_token,
        Some(json!({"name": "Memory group", "memberIds": [priya, declined]})),
    )
    .await;
    assert_eq!(status, 201, "{group}");
    let space = group["group"]["groupSpaceId"].as_str().unwrap();
    let (prompt,): (String,) = query_as(
        "SELECT run.prompt FROM cloud_common_ground_group_intros intro \
         JOIN cloud_agent_fallback_runs run ON run.run_id = intro.run_id \
         WHERE intro.group_space_id = $1",
    )
    .bind(space)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(prompt.contains("Priya"), "{prompt}");
    assert!(!prompt.contains("Declinia"), "{prompt}");
}
