//! Profiles in rooms and pairings: the profile each person shares, the kind
//! a room suggests, switching, what others see, and deleting a profile.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{answer_empty, build_profile, create_profile, matches_between};
use super::support::free_code;

const CG: &str = "/v1/cloud/common-ground";

/// A signed-in person with built work and health cards.
struct Person {
    id: String,
    token: String,
    work: String,
    health: String,
}

async fn person(app: &axum::Router, pool: &PgPool, label: &str, health: bool) -> Person {
    let (id, token) = signed_in(pool, label).await;
    let work = create_profile(app, &token, "work", None).await;
    build_profile(
        app,
        pool,
        (&id, &token),
        &work,
        &format!("{label} work topic"),
    )
    .await;
    let health = if health {
        let health = create_profile(app, &token, "health", None).await;
        build_profile(
            app,
            pool,
            (&id, &token),
            &health,
            &format!("{label} health topic"),
        )
        .await;
        health
    } else {
        String::new()
    };
    Person {
        id,
        token,
        work,
        health,
    }
}

async fn join(app: &axum::Router, code: &str, token: &str, body: Value) -> (u16, Value) {
    send(
        app,
        "POST",
        &format!("{CG}/rooms/{code}/join"),
        token,
        Some(body),
    )
    .await
}

async fn open_match_runs(pool: &PgPool, viewer_profile: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_common_ground_match_runs WHERE viewer_profile_id = $1 AND finished_at IS NULL",
    )
    .bind(viewer_profile)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
async fn rooms_share_one_profile_per_person() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let alex = person(&app, &pool, "Alex", true).await;
    let priya = person(&app, &pool, "Priya", true).await;
    let sam = person(&app, &pool, "Sam", false).await;
    let code = free_code();
    sqlx_core::query::query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();

    let (status, body) = join(&app, &code, &alex.token, json!({"kind": "school"})).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_invalid_room"))
    );
    // A profile without a card cannot be shared.
    let daily = create_profile(&app, &alex.token, "daily", None).await;
    let (status, body) = join(&app, &code, &alex.token, json!({"profileId": daily})).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_no_card"))
    );
    let (status, body) = join(&app, &code, &alex.token, json!({"profileId": priya.work})).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (404, Some("common_ground_profile_not_found"))
    );

    // The first joiner sets the kind; others get their profile of that kind
    // preselected, or their default when they have none.
    let (status, body) = join(&app, &code, &alex.token, json!({"kind": "health"})).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (&body["kind"], &body["profileId"]),
        (&json!("health"), &json!(alex.health))
    );
    let (_, body) = join(&app, &code, &priya.token, json!({"kind": "work"})).await;
    assert_eq!(
        (&body["kind"], &body["profileId"]),
        (&json!("health"), &json!(priya.health))
    );
    assert_eq!(
        body["members"][0]["profile"],
        json!({
            "profileId": alex.health, "kind": "health", "name": "Health", "design": null,
            "icon": null
        })
    );
    let (_, body) = join(&app, &code, &sam.token, json!({})).await;
    assert_eq!(body["profileId"], sam.work.as_str());
    let (_, rooms) = send(&app, "GET", &format!("{CG}/rooms"), &priya.token, None).await;
    assert_eq!(
        (&rooms["rooms"][0]["kind"], &rooms["rooms"][0]["profileId"]),
        (&json!("health"), &json!(priya.health))
    );

    // Others see the shared profile's card, never another profile's.
    let (status, body) = send(
        &app,
        "GET",
        &format!("{CG}/people/{}", alex.id),
        &priya.token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["card"]["workingOn"], json!(["Alex health topic"]));
    assert_eq!(
        (&body["person"]["profile"]["kind"], &body["profileId"]),
        (&json!("health"), &json!(priya.health))
    );
    assert!(!body.to_string().contains("Alex work topic"));
    let (status, _) = send(
        &app,
        "GET",
        &format!("{CG}/people/{}?profile={}", alex.id, priya.work),
        &priya.token,
        None,
    )
    .await;
    assert_eq!(status, 404, "priya's work profile does not see alex");

    // Matching reads the shared profiles only, and results name them.
    let results = format!("{CG}/rooms/{code}/results");
    let (status, body) = send(&app, "POST", &results, &alex.token, None).await;
    assert_eq!(
        (status, body["status"].as_str()),
        (200, Some("matching")),
        "{body}"
    );
    let prompt = answer_empty(&pool, &alex.id).await;
    assert!(
        prompt.contains("Alex health topic")
            && prompt.contains("Priya health topic")
            && prompt.contains("Sam work topic"),
        "{prompt}"
    );
    assert!(
        !prompt.contains("Alex work topic") && !prompt.contains("Priya work topic"),
        "{prompt}"
    );
    let (_, body) = send(&app, "POST", &results, &alex.token, None).await;
    assert_eq!(body["profileId"], alex.health.as_str());
    let shared: Vec<(&str, &str)> = body["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["person"]["name"].as_str().unwrap(),
                p["person"]["profile"]["kind"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(shared, [("Priya", "health"), ("Sam", "work")], "{body}");
    assert_eq!(matches_between(&pool, &alex.health, &priya.health).await, 1);

    // Switching the shared profile clears the matches and matches again.
    let switch = format!("{CG}/rooms/{code}/profile");
    let (status, body) = send(
        &app,
        "POST",
        &switch,
        &priya.token,
        Some(json!({"profileId": alex.work})),
    )
    .await;
    assert_eq!(status, 404, "{body}");
    let (status, body) = send(
        &app,
        "POST",
        &switch,
        &priya.token,
        Some(json!({"profileId": priya.work})),
    )
    .await;
    assert_eq!(
        (status, &body["profileId"]),
        (200, &json!(priya.work)),
        "{body}"
    );
    assert_eq!(matches_between(&pool, &alex.health, &priya.health).await, 0);
    let (_, body) = send(&app, "POST", &results, &alex.token, None).await;
    assert_eq!(body["status"], "matching", "{body}");
    assert_eq!(open_match_runs(&pool, &alex.health).await, 1, "re-queued");
    let prompt = answer_empty(&pool, &alex.id).await;
    assert!(
        prompt.contains("Priya work topic") && !prompt.contains("Priya health topic"),
        "{prompt}"
    );
    let (_, body) = send(
        &app,
        "GET",
        &format!("{CG}/people/{}", priya.id),
        &alex.token,
        None,
    )
    .await;
    assert_eq!(body["card"]["workingOn"], json!(["Priya work topic"]));
    // Joining again without a profile keeps the one you share.
    let (_, body) = join(&app, &code, &priya.token, json!({})).await;
    assert_eq!(body["profileId"], priya.work.as_str());

    // A closed room cannot switch.
    sqlx_core::query::query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &switch,
        &priya.token,
        Some(json!({"profileId": priya.health})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_room_closed"))
    );
}

#[tokio::test]
async fn pairings_tie_two_profiles() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let alex = person(&app, &pool, "Alex", true).await;
    let priya = person(&app, &pool, "Priya", true).await;
    let code_path = format!("{CG}/pairings/code");
    let redeem_path = format!("{CG}/pairings/redeem");
    let code = |profile: &str| {
        send(
            &app,
            "POST",
            &code_path,
            &alex.token,
            Some(json!({"profileId": profile})),
        )
    };
    let redeem = |code: Value, profile: Option<&str>| {
        send(
            &app,
            "POST",
            &redeem_path,
            &priya.token,
            Some(json!({"code": code, "profileId": profile})),
        )
    };

    // Priya's health profile is preselected for Alex's health code.
    let (status, body) = code(&alex.health).await;
    assert_eq!(
        (status, &body["profileId"]),
        (201, &json!(alex.health)),
        "{body}"
    );
    let (status, body) = redeem(body["code"].clone(), None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (&body["profileId"], &body["person"]["profile"]["profileId"]),
        (&json!(priya.health), &json!(alex.health))
    );
    assert_eq!(body["card"]["workingOn"], json!(["Alex health topic"]));
    // A second pairing through the work profiles, chosen explicitly.
    let (_, body) = code(&alex.work).await;
    let (status, body) = redeem(body["code"].clone(), Some(&priya.work)).await;
    assert_eq!(
        (status, &body["card"]["workingOn"]),
        (200, &json!(["Alex work topic"])),
        "{body}"
    );

    let (_, body) = send(&app, "GET", &format!("{CG}/pairings"), &alex.token, None).await;
    let mut pairs: Vec<(String, String)> = body["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["profileId"].as_str().unwrap().to_string(),
                p["profile"]["profileId"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    pairs.sort();
    let mut expected = vec![
        (alex.health.clone(), priya.health.clone()),
        (alex.work.clone(), priya.work.clone()),
    ];
    expected.sort();
    assert_eq!(pairs, expected);

    // Each of Alex's profiles sees the matching profile of Priya, and
    // Recent keeps one entry per profile she shared.
    let person = |profile: &str| format!("{CG}/people/{}?profile={profile}", priya.id);
    let (_, body) = send(&app, "GET", &person(&alex.work), &alex.token, None).await;
    assert_eq!(body["card"]["workingOn"], json!(["Priya work topic"]));
    let (_, body) = send(&app, "GET", &person(&alex.health), &alex.token, None).await;
    assert_eq!(body["card"]["workingOn"], json!(["Priya health topic"]));
    for profile in [&alex.work, &alex.health] {
        let detail = format!("{CG}/people/{}/match?profile={profile}", priya.id);
        let (status, body) = send(&app, "GET", &detail, &alex.token, None).await;
        assert_eq!(
            (status, &body["profileId"]),
            (202, &json!(profile)),
            "{body}"
        );
        answer_empty(&pool, &alex.id).await;
        let (status, body) = send(&app, "GET", &detail, &alex.token, None).await;
        assert_eq!((status, &body["status"]), (200, &json!("ready")), "{body}");
    }
    let (_, body) = send(&app, "GET", &format!("{CG}/recent"), &alex.token, None).await;
    let mut kinds: Vec<&str> = body["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["person"]["profile"]["kind"].as_str().unwrap())
        .collect();
    kinds.sort();
    assert_eq!(kinds, ["health", "work"], "{body}");
    assert!(body["people"][0]["score"].is_i64(), "{body}");
}

#[tokio::test]
async fn deleting_a_profile_leaves_rooms_and_drops_its_matches() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let alex = person(&app, &pool, "Alex", true).await;
    let priya = person(&app, &pool, "Priya", false).await;
    let code = free_code();
    sqlx_core::query::query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
    join(&app, &code, &alex.token, json!({"profileId": alex.work})).await;
    join(&app, &code, &priya.token, json!({})).await;
    send(
        &app,
        "POST",
        &format!("{CG}/rooms/{code}/results"),
        &alex.token,
        None,
    )
    .await;
    answer_empty(&pool, &alex.id).await;
    let detail = format!("{CG}/people/{}/match", priya.id);
    let (status, _) = send(&app, "GET", &detail, &alex.token, None).await;
    assert_eq!(status, 200);
    let (_, pair) = send(
        &app,
        "POST",
        &format!("{CG}/pairings/code"),
        &alex.token,
        Some(json!({"profileId": alex.work})),
    )
    .await;
    send(
        &app,
        "POST",
        &format!("{CG}/pairings/redeem"),
        &priya.token,
        Some(json!({"code": pair["code"]})),
    )
    .await;
    assert_eq!(matches_between(&pool, &alex.work, &priya.work).await, 1);

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("{CG}/profiles/{}", alex.work),
        &alex.token,
        None,
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(matches_between(&pool, &alex.work, &priya.work).await, 0);
    let (_, view) = send(
        &app,
        "GET",
        &format!("{CG}/rooms/{code}"),
        &priya.token,
        None,
    )
    .await;
    assert_eq!(view["members"], json!([]), "{view}");
    let (_, rooms) = send(&app, "GET", &format!("{CG}/rooms"), &alex.token, None).await;
    assert_eq!(rooms["rooms"], json!([]));
    let (_, pairings) = send(&app, "GET", &format!("{CG}/pairings"), &priya.token, None).await;
    assert_eq!(pairings["people"], json!([]));
    let (status, _) = send(
        &app,
        "GET",
        &format!("{CG}/people/{}", alex.id),
        &priya.token,
        None,
    )
    .await;
    assert_eq!(status, 404);
    // The other profile and its card stay, and become the default.
    let (_, body) = send(&app, "GET", &format!("{CG}/card"), &alex.token, None).await;
    assert_eq!(
        (&body["profile"]["profileId"], &body["card"]["workingOn"]),
        (&json!(alex.health), &json!(["Alex health topic"]))
    );
}

#[path = "pairing_status_tests.rs"]
mod pairing_status_tests;
