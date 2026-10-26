//! `commonGround.match` on a contact profile: the best stored match between
//! profiles the two accounts share with each other, or null.

use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::fixtures::befriend;
use super::profile_path;
use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};

/// A profile of `kind` at `position`, with a built card at `revision`.
async fn profile(pool: &PgPool, account: &str, kind: &str, position: i32, revision: i64) -> String {
    let profile_id = format!("cgp_{}", Uuid::new_v4().simple());
    let name = match kind {
        "work" => "Work",
        "health" => "Health",
        _ => "Daily",
    };
    query(
        "INSERT INTO cloud_common_ground_profiles (profile_id, account_id, kind, name, position) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&profile_id)
    .bind(account)
    .bind(kind)
    .bind(name)
    .bind(position)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_common_ground_cards (account_id, profile_id, topics_json, \
         sharing_enabled, revision, built_at) VALUES ($1, $2, $3, true, $4, now())",
    )
    .bind(account)
    .bind(&profile_id)
    .bind(json!({"workingOn": ["Agent memory"], "canHelp": [], "lookingFor": []}))
    .bind(revision)
    .execute(pool)
    .await
    .unwrap();
    profile_id
}

async fn pair(
    pool: &PgPool,
    (left, left_profile): (&str, &str),
    (right, right_profile): (&str, &str),
) {
    let ((a, pa), (b, pb)) = if left < right {
        ((left, left_profile), (right, right_profile))
    } else {
        ((right, right_profile), (left, left_profile))
    };
    query(
        "INSERT INTO cloud_common_ground_pairings (account_a, account_b, profile_a, profile_b) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(a)
    .bind(b)
    .bind(pa)
    .bind(pb)
    .execute(pool)
    .await
    .unwrap();
}

/// A closed room with these members; returns its id.
async fn closed_room(pool: &PgPool, members: &[(&str, &str)]) -> Uuid {
    let room_id = Uuid::new_v4();
    query(
        "INSERT INTO cloud_common_ground_rooms (room_id, code, closed_at) VALUES ($1, '1234', now())",
    )
    .bind(room_id)
    .execute(pool)
    .await
    .unwrap();
    for (account, profile_id) in members {
        query(
            "INSERT INTO cloud_common_ground_room_members (room_id, account_id, profile_id) \
             VALUES ($1, $2, $3)",
        )
        .bind(room_id)
        .bind(account)
        .bind(profile_id)
        .execute(pool)
        .await
        .unwrap();
    }
    room_id
}

fn reason(i: usize) -> Value {
    json!({"topic": format!("Topic {i}"), "theirTopic": format!("Their topic {i}"), "why": "Both."})
}

fn trade(i: usize) -> Value {
    json!({"topic": format!("Skill {i}"), "for": format!("Need {i}"), "why": "Helps."})
}

fn result(score: i64, headline: &str) -> Value {
    json!({
        "score": score,
        "headline": headline,
        "shared": (0..7).map(reason).collect::<Vec<_>>(),
        "youBring": (0..4).map(trade).collect::<Vec<_>>(),
        "theyBring": (0..4).map(trade).collect::<Vec<_>>(),
        "nextStep": "Compare notes.",
    })
}

/// Stores `viewer`'s match with `other` computed from these revisions.
async fn store(
    pool: &PgPool,
    (viewer, viewer_profile, viewer_revision): (&str, &str, i64),
    (other, other_profile, other_revision): (&str, &str, i64),
    result: Value,
) {
    query(
        "INSERT INTO cloud_common_ground_matches (viewer_account_id, other_account_id, \
         viewer_profile_id, other_profile_id, viewer_revision, other_revision, result_json) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(viewer)
    .bind(other)
    .bind(viewer_profile)
    .bind(other_profile)
    .bind(viewer_revision)
    .bind(other_revision)
    .bind(result)
    .execute(pool)
    .await
    .unwrap();
}

async fn contact_match(app: &axum::Router, token: &str, target: &str) -> Value {
    let (status, body) = send(app, "GET", &profile_path(target), token, None).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["commonGround"].is_object(), "{body}");
    body["commonGround"]["match"].clone()
}

#[tokio::test]
async fn no_stored_match_is_null() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cm_none_me").await;
    let (them, _) = signed_in(&pool, "cm_none_them").await;
    befriend(&pool, &me, &them).await;
    let mine = profile(&pool, &me, "work", 0, 1).await;
    let theirs = profile(&pool, &them, "work", 0, 1).await;
    pair(&pool, (&me, &mine), (&them, &theirs)).await;
    // Their match with me is not mine to show.
    store(
        &pool,
        (&them, &theirs, 1),
        (&me, &mine, 1),
        result(90, "Theirs"),
    )
    .await;

    let (_, body) = send(&app, "GET", &profile_path(&them), &token, None).await;
    assert_eq!(
        body["commonGround"],
        json!({
            "workingOn": ["Agent memory"],
            "canHelp": [],
            "lookingFor": [],
            "match": null,
        })
    );
}

#[tokio::test]
async fn stored_match_shows_capped_lists_and_both_profiles() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cm_one_me").await;
    let (them, _) = signed_in(&pool, "cm_one_them").await;
    befriend(&pool, &me, &them).await;
    let mine = profile(&pool, &me, "work", 0, 3).await;
    let theirs = profile(&pool, &them, "work", 0, 5).await;
    pair(&pool, (&me, &mine), (&them, &theirs)).await;
    store(
        &pool,
        (&me, &mine, 3),
        (&them, &theirs, 5),
        result(82, "Agent memory"),
    )
    .await;

    let mut found = contact_match(&app, &token, &them).await;
    assert!(found["updatedAt"].is_string(), "{found}");
    found.as_object_mut().unwrap().remove("updatedAt");
    let tag = |id: &str| json!({"profileId": id, "kind": "work", "name": "Work", "design": null, "icon": null});
    assert_eq!(
        found,
        json!({
            "score": 82,
            "headline": "Agent memory",
            "shared": (0..5).map(reason).collect::<Vec<_>>(),
            "youBring": (0..3).map(trade).collect::<Vec<_>>(),
            "theyBring": (0..3).map(trade).collect::<Vec<_>>(),
            "nextStep": "Compare notes.",
            "yourProfile": tag(&mine),
            "theirProfile": tag(&theirs),
        })
    );
}

#[tokio::test]
async fn best_visible_pair_wins() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cm_best_me").await;
    let (them, _) = signed_in(&pool, "cm_best_them").await;
    befriend(&pool, &me, &them).await;
    let my_work = profile(&pool, &me, "work", 0, 1).await;
    let my_health = profile(&pool, &me, "health", 1, 1).await;
    let their_work = profile(&pool, &them, "work", 0, 1).await;
    let their_health = profile(&pool, &them, "health", 1, 1).await;
    pair(&pool, (&me, &my_work), (&them, &their_work)).await;
    pair(&pool, (&me, &my_health), (&them, &their_health)).await;
    closed_room(&pool, &[(&me, &my_work), (&them, &their_health)]).await;

    // Through a pairing only a current result counts.
    store(
        &pool,
        (&me, &my_work, 0),
        (&them, &their_work, 1),
        result(99, "Old work"),
    )
    .await;
    store(
        &pool,
        (&me, &my_health, 1),
        (&them, &their_health, 1),
        result(60, "Running"),
    )
    .await;
    // Through a closed room the last stored result counts, behind a current one.
    store(
        &pool,
        (&me, &my_work, 1),
        (&them, &their_health, 0),
        result(95, "Old room"),
    )
    .await;

    let found = contact_match(&app, &token, &them).await;
    assert_eq!(found["score"], 60, "{found}");
    assert_eq!(found["headline"], "Running");
    assert_eq!(found["yourProfile"]["profileId"], my_health);
    assert_eq!(found["theirProfile"]["profileId"], their_health);
    assert_eq!(found["theirProfile"]["kind"], "health");

    query("DELETE FROM cloud_common_ground_matches WHERE viewer_profile_id = $1")
        .bind(&my_health)
        .execute(&pool)
        .await
        .unwrap();
    let found = contact_match(&app, &token, &them).await;
    assert_eq!(found["headline"], "Old room", "{found}");
    assert_eq!(found["yourProfile"]["profileId"], my_work);
    assert_eq!(found["theirProfile"]["profileId"], their_health);

    // Among current results the higher score wins.
    store(
        &pool,
        (&me, &my_health, 1),
        (&them, &their_health, 1),
        result(70, "Health"),
    )
    .await;
    query("UPDATE cloud_common_ground_matches SET viewer_revision = 1 WHERE viewer_profile_id = $1 AND other_profile_id = $2")
        .bind(&my_work)
        .bind(&their_work)
        .execute(&pool)
        .await
        .unwrap();
    let found = contact_match(&app, &token, &them).await;
    assert_eq!(found["headline"], "Old work", "{found}");
    assert_eq!(found["score"], 99);
}

#[tokio::test]
async fn pairs_the_viewer_cannot_see_are_null() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "cm_hidden_me").await;
    let (them, _) = signed_in(&pool, "cm_hidden_them").await;
    befriend(&pool, &me, &them).await;
    let mine = profile(&pool, &me, "work", 0, 1).await;
    let theirs = profile(&pool, &them, "work", 0, 1).await;
    let their_daily = profile(&pool, &them, "daily", 1, 1).await;
    pair(&pool, (&me, &mine), (&them, &theirs)).await;
    // They never shared their daily profile with me.
    store(
        &pool,
        (&me, &mine, 1),
        (&them, &their_daily, 1),
        result(99, "Daily"),
    )
    .await;
    assert_eq!(contact_match(&app, &token, &them).await, Value::Null);

    // A room they left no longer shows it.
    let room = closed_room(&pool, &[(&me, &mine), (&them, &their_daily)]).await;
    assert_eq!(
        contact_match(&app, &token, &them).await["headline"],
        "Daily"
    );
    query("UPDATE cloud_common_ground_room_members SET left_at = now() WHERE room_id = $1 AND account_id = $2")
        .bind(room)
        .bind(&them)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(contact_match(&app, &token, &them).await, Value::Null);

    // Nor, with their card lists, while my own card is not shared.
    store(
        &pool,
        (&me, &mine, 1),
        (&them, &theirs, 1),
        result(50, "Work"),
    )
    .await;
    assert_eq!(contact_match(&app, &token, &them).await["headline"], "Work");
    query("UPDATE cloud_common_ground_cards SET sharing_enabled = false WHERE profile_id = $1")
        .bind(&mine)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(&app, "GET", &profile_path(&them), &token, None).await;
    assert_eq!(
        (status, &body["commonGround"]),
        (200, &Value::Null),
        "{body}"
    );
}
