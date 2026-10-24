//! Profiles: create, rename and delete with their limits, a card per profile
//! built through its lens, and defaults for clients that send no profile.

use serde_json::{json, Value};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{build_profile, create_profile, PROFILES};
use super::support::{claim, RUNNER};
use crate::common_ground::complete;

const CARD: &str = "/v1/cloud/common-ground/card";

async fn get(app: &axum::Router, path: String, token: &str) -> (u16, Value) {
    send(app, "GET", &path, token, None).await
}

async fn list(app: &axum::Router, token: &str) -> Vec<Value> {
    let (status, body) = send(app, "GET", PROFILES, token, None).await;
    assert_eq!(status, 200, "{body}");
    body["profiles"].as_array().unwrap().clone()
}

#[tokio::test]
async fn profiles_are_created_renamed_and_limited() {
    let Some(pool) = pool().await else {
        return;
    };
    let app = app(&pool, None);
    let (_, token) = signed_in(&pool, "Alex").await;
    let (_, priya_token) = signed_in(&pool, "Priya").await;
    assert_eq!(list(&app, &token).await, Vec::<Value>::new());

    let post = |body: Value| send(&app, "POST", PROFILES, &token, Some(body));
    for invalid in [
        json!({"kind": "custom"}),
        json!({"kind": "custom", "name": "   "}),
        json!({"kind": "school"}),
        json!({"kind": "custom", "name": "x".repeat(41)}),
        json!({"kind": "custom", "name": "KAUST", "focus": "x".repeat(201)}),
    ] {
        let (status, body) = post(invalid.clone()).await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (400, Some("common_ground_invalid_profile")),
            "{invalid}"
        );
    }
    let (status, work) = post(json!({"kind": "work"})).await;
    assert_eq!(status, 201, "{work}");
    assert_eq!(
        (
            &work["kind"],
            &work["name"],
            &work["position"],
            &work["hasCard"]
        ),
        (&json!("work"), &json!("Work"), &json!(0), &json!(false))
    );
    assert_eq!(
        (&work["sharing"], &work["topicCount"]),
        (&json!(true), &json!(0))
    );
    let (status, body) = post(json!({"kind": "work", "name": "Job"})).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_profile_exists"))
    );
    let health = create_profile(&app, &token, "health", None).await;
    create_profile(&app, &token, "daily", None).await;
    let (status, kaust) =
        post(json!({"kind": "custom", "name": " KAUST ", "focus": "My  research group at KAUST"}))
            .await;
    assert_eq!(status, 201, "{kaust}");
    assert_eq!(
        (&kaust["name"], &kaust["focus"]),
        (&json!("KAUST"), &json!("My research group at KAUST"))
    );
    let mit = create_profile(&app, &token, "custom", Some("MIT")).await;
    let (status, body) = post(json!({"kind": "custom", "name": "Sixth"})).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_too_many_profiles"))
    );
    let all = list(&app, &token).await;
    let names: Vec<&str> = all.iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Work", "Health", "Daily", "KAUST", "MIT"]);
    let positions: Vec<i64> = all
        .iter()
        .map(|p| p["position"].as_i64().unwrap())
        .collect();
    assert_eq!(positions, [0, 1, 2, 3, 4]);

    // Renames: an empty name gives a fixed kind its name back; an empty
    // focus clears it; a custom profile needs a name.
    let one = |id: &str| format!("{PROFILES}/{id}");
    let kaust_id = kaust["profileId"].as_str().unwrap();
    let (status, body) = send(
        &app,
        "PUT",
        &one(kaust_id),
        &token,
        Some(json!({"name": "KAUST lab", "focus": ""})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (&body["name"], &body["focus"]),
        (&json!("KAUST lab"), &Value::Null)
    );
    let (status, _) = send(
        &app,
        "PUT",
        &one(kaust_id),
        &token,
        Some(json!({"name": ""})),
    )
    .await;
    assert_eq!(status, 400);
    send(
        &app,
        "PUT",
        &one(&health),
        &token,
        Some(json!({"name": "Running"})),
    )
    .await;
    let (_, body) = send(
        &app,
        "PUT",
        &one(&health),
        &token,
        Some(json!({"name": ""})),
    )
    .await;
    assert_eq!(body["name"], "Health");
    for (method, path) in [
        ("PUT", one(&health)),
        ("DELETE", one(&health)),
        ("PUT", one("cgp_missing")),
    ] {
        let (status, body) = send(
            &app,
            method,
            &path,
            &priya_token,
            Some(json!({"name": "Mine"})),
        )
        .await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (404, Some("common_ground_profile_not_found")),
            "{method} {path}"
        );
    }

    // Deleting frees a slot; the next profile goes after the last one.
    let (status, _) = send(&app, "DELETE", &one(&mit), &token, None).await;
    assert_eq!(status, 204);
    let (status, _) = send(&app, "DELETE", &one(&mit), &token, None).await;
    assert_eq!(status, 404);
    let (status, body) = post(json!({"kind": "custom", "name": "Side project"})).await;
    assert_eq!((status, &body["position"]), (201, &json!(4)), "{body}");
    let (status, _) = send(&app, "GET", &format!("{CARD}?profile={mit}"), &token, None).await;
    assert_eq!(status, 404, "a deleted profile has no card");
}

#[tokio::test]
async fn each_profile_builds_its_own_card_through_its_lens() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, token) = signed_in(&pool, "Alex").await;
    let work = create_profile(&app, &token, "work", None).await;
    let health = create_profile(&app, &token, "health", None).await;
    let kaust = create_profile(&app, &token, "custom", Some("KAUST")).await;
    send(
        &app,
        "PUT",
        &format!("{PROFILES}/{kaust}"),
        &token,
        Some(json!({"focus": "My research group at KAUST"})),
    )
    .await;

    // The same notes, read through three lenses.
    let me = (alex.as_str(), token.as_str());
    let work_prompt = build_profile(&app, &pool, me, &work, "Agent memory").await;
    let health_prompt = build_profile(&app, &pool, me, &health, "Marathon training").await;
    let kaust_prompt = build_profile(&app, &pool, me, &kaust, "KAUST memory lab").await;
    assert!(
        work_prompt.contains("Profile: Work (work profile)."),
        "{work_prompt}"
    );
    assert!(work_prompt.contains("Keep only research and professional topics"));
    assert!(
        health_prompt.contains("Profile: Health (health profile)."),
        "{health_prompt}"
    );
    assert!(
        health_prompt.contains("ignores papers") && !health_prompt.contains("Keep only research")
    );
    assert!(kaust_prompt
        .contains("Profile: KAUST (custom profile). Focus: My research group at KAUST."));
    assert!(
        kaust_prompt.contains("ignores work done at MIT"),
        "{kaust_prompt}"
    );

    let card = |profile: &str| get(&app, format!("{CARD}?profile={profile}"), &token);
    let (status, body) = card(&work).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["card"]["workingOn"], json!(["Agent memory"]));
    assert_eq!(
        body["profile"],
        json!({
            "profileId": work, "kind": "work", "name": "Work", "focus": null, "design": null,
            "icon": null, "sources": null
        })
    );
    let (_, body) = card(&health).await;
    assert_eq!(body["card"]["workingOn"], json!(["Marathon training"]));
    assert_eq!(body["profile"]["kind"], "health");
    let (_, body) = card(&kaust).await;
    assert_eq!(body["card"]["workingOn"], json!(["KAUST memory lab"]));

    // Edits and sharing touch one profile only.
    let (status, body) = send(
        &app,
        "PUT",
        "/v1/cloud/common-ground/card/hidden",
        &token,
        Some(json!({"profileId": health, "hidden": ["Marathon training"]})),
    )
    .await;
    assert_eq!(
        (status, &body["card"]["hidden"]),
        (200, &json!(["Marathon training"])),
        "{body}"
    );
    let (_, body) = send(
        &app,
        "PUT",
        "/v1/cloud/common-ground/settings",
        &token,
        Some(json!({"profileId": kaust, "sharing": false})),
    )
    .await;
    assert_eq!(
        (&body["sharing"], &body["profile"]["profileId"]),
        (&json!(false), &json!(kaust))
    );
    let (_, body) = card(&work).await;
    assert_eq!(
        (&body["card"]["hidden"], &body["sharing"]),
        (&json!([]), &json!(true))
    );
    let all = list(&app, &token).await;
    let summary: Vec<(bool, bool, i64)> = all
        .iter()
        .map(|p| {
            (
                p["hasCard"].as_bool().unwrap(),
                p["sharing"].as_bool().unwrap(),
                p["topicCount"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [(true, true, 1), (true, true, 1), (true, false, 1)]
    );

    // Deleting one card keeps the profile and the other cards.
    let (status, body) = send(
        &app,
        "DELETE",
        &format!("{CARD}?profile={health}"),
        &token,
        None,
    )
    .await;
    assert_eq!((status, &body["card"]), (200, &Value::Null));
    assert_eq!(body["profile"]["profileId"], health.as_str());
    let (_, body) = card(&work).await;
    assert_eq!(body["card"]["workingOn"], json!(["Agent memory"]));
}

#[tokio::test]
async fn clients_without_profile_ids_use_the_default_profile() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));

    // No profile yet: an empty card, and a build creates the work profile.
    let (alex, token) = signed_in(&pool, "Alex").await;
    let (status, body) = send(&app, "GET", CARD, &token, None).await;
    assert_eq!(
        (status, &body["card"], &body["profile"]),
        (200, &Value::Null, &Value::Null)
    );
    let (status, body) = send(
        &app,
        "PUT",
        "/v1/cloud/common-ground/card/hidden",
        &token,
        Some(json!({"hidden": []})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_no_card"))
    );
    let (status, body) = send(
        &app,
        "POST",
        &format!("{CARD}/build"),
        &token,
        Some(json!({"notes": "My work."})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(
        (&body["profile"]["kind"], &body["profile"]["name"]),
        (&json!("work"), &json!("Work"))
    );
    let run_id = claim(&pool, &alex).await;
    let reply = super::support::card_reply(&["Agent memory"], &[], &[], &[]);
    complete(&pool, &run_id, RUNNER, &reply).await.unwrap();
    let profiles = list(&app, &token).await;
    assert_eq!(profiles.len(), 1);
    let work = profiles[0]["profileId"].as_str().unwrap().to_string();
    let (_, body) = send(&app, "GET", CARD, &token, None).await;
    assert_eq!(
        (&body["card"]["workingOn"], &body["profile"]["profileId"]),
        (&json!(["Agent memory"]), &json!(work))
    );

    // The work profile stays the default when it is not the first one.
    let (status, _) = send(&app, "DELETE", &format!("{PROFILES}/{work}"), &token, None).await;
    assert_eq!(status, 204);
    let daily = create_profile(&app, &token, "daily", None).await;
    let work = create_profile(&app, &token, "work", None).await;
    let (_, body) = send(&app, "GET", CARD, &token, None).await;
    assert_eq!(body["profile"]["profileId"], work.as_str());

    // Without a work profile the first one is the default; nothing new is made.
    let (status, _) = send(&app, "DELETE", &format!("{PROFILES}/{work}"), &token, None).await;
    assert_eq!(status, 204);
    let (_, body) = send(
        &app,
        "POST",
        &format!("{CARD}/build"),
        &token,
        Some(json!({"notes": "Errands."})),
    )
    .await;
    assert_eq!(body["profile"]["profileId"], daily.as_str(), "{body}");
    assert_eq!(list(&app, &token).await.len(), 1);

    // Sharing settings before any build also start the work profile.
    let (_, priya_token) = signed_in(&pool, "Priya").await;
    let (status, body) = send(
        &app,
        "PUT",
        "/v1/cloud/common-ground/settings",
        &priya_token,
        Some(json!({"sharing": false})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (&body["sharing"], &body["profile"]["kind"], &body["card"]),
        (&json!(false), &json!("work"), &Value::Null)
    );
    let (status, body) = send(
        &app,
        "GET",
        &format!("{CARD}?profile=cgp_missing"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (404, Some("common_ground_profile_not_found"))
    );
}
