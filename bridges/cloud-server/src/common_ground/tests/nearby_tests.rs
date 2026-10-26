//! Nearby people: consent, reciprocal visibility, pausing, stale locations
//! and sign-out, through direct API calls.

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};

use super::db_fixture::{pool, send, signed_in};
use super::nearby_support::{
    listed, locate, located, locations, memory_card, north, setup, spot, NEARBY, PEOPLE,
};
use super::support::build_card_with;

#[tokio::test]
async fn turning_on_needs_consent_and_a_shared_card() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let (_, token) = signed_in(&pool, "Ada").await;
    let (status, body) = send(&app, "GET", NEARBY, &token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (
            body["enabled"].clone(),
            body["participating"].clone(),
            body["range"].clone()
        ),
        (json!(false), json!(false), json!(2000))
    );
    assert_eq!(body["minScore"], 0);
    assert_eq!(
        body["alerts"],
        json!({"requests": true, "matches": true, "matchMinScore": 85, "maxPerDay": 3})
    );
    assert_eq!(
        (body["location"].clone(), body["freshSeconds"].clone()),
        (json!(null), json!(1800))
    );

    let on = json!({"enabled": true});
    let (status, body) = send(&app, "PUT", NEARBY, &token, Some(on.clone())).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_nearby_consent_required"))
    );
    let consent = json!({"enabled": true, "consent": true});
    let (status, body) = send(&app, "PUT", NEARBY, &token, Some(consent.clone())).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_no_card"))
    );

    let (id, token) = signed_in(&pool, "Ben").await;
    build_card_with(&app, &pool, &id, &token, &memory_card()).await;
    let sharing = "/v1/cloud/common-ground/settings";
    send(
        &app,
        "PUT",
        sharing,
        &token,
        Some(json!({"sharing": false})),
    )
    .await;
    let (status, body) = send(&app, "PUT", NEARBY, &token, Some(consent.clone())).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_sharing_off"))
    );
    send(&app, "PUT", sharing, &token, Some(json!({"sharing": true}))).await;
    let (status, body) = send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"profileId": "cgp_nobody"})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (404, Some("common_ground_profile_not_found"))
    );
    for bad in [
        json!({"range": 1500}),
        json!({"minScore": 10}),
        json!({"openTo": ["a", "b", "c", "d", "e", "f"]}),
        json!({"alerts": {"maxPerDay": 5}}),
        json!({"pausedUntil": "next week"}),
    ] {
        let (status, body) = send(&app, "PUT", NEARBY, &token, Some(bad.clone())).await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (422, Some("common_ground_nearby_invalid_settings")),
            "{bad}"
        );
    }
    let (status, body) = send(&app, "PUT", NEARBY, &token, Some(consent)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (body["enabled"].clone(), body["participating"].clone()),
        (json!(true), json!(true))
    );
    assert!(body["consentedAt"].is_string());
    let (profile,): (String,) =
        query_as("SELECT profile_id FROM cloud_common_ground_profiles WHERE account_id = $1")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(body["profileId"], profile);
    // Already on: later changes need no consent.
    let (status, body) = send(
        &app,
        "PUT",
        NEARBY,
        &token,
        Some(json!({"range": 5000, "openTo": [" Hiring ", "hiring"]})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (body["range"].clone(), body["openTo"].clone()),
        (json!(5000), json!(["Hiring"]))
    );
    let (status, body) = send(&app, "GET", PEOPLE, &token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_nearby_no_location"))
    );
}

#[tokio::test]
async fn both_see_each_other_until_one_turns_off() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (alex, alex_token) = located(&app, &pool, "Alex", here).await;
    let (priya, priya_token) = located(&app, &pool, "Priya", north(here, 300.0)).await;
    let (_, far_token) = located(&app, &pool, "Far", north(here, 26_000.0)).await;

    let (status, body) = send(&app, "GET", PEOPLE, &alex_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(listed(&body), vec![priya.clone()]);
    let entry = &body["people"][0];
    assert_eq!(entry["distance"], json!({"minMeters": 0, "maxMeters": 500}));
    assert_eq!(entry["status"], "matching");
    assert_eq!(entry["openTo"], json!(["Coffee chat"]));
    assert_eq!(entry["person"]["profile"]["kind"], "work");
    assert_eq!(entry["relationship"]["contact"], false);
    assert!(entry.get("latitude").is_none() && body["location"]["fresh"] == true);
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert_eq!(listed(&body), vec![alex.clone()]);
    let (_, body) = send(&app, "GET", PEOPLE, &far_token, None).await;
    assert!(
        listed(&body).is_empty(),
        "25 km is the farthest anyone is seen"
    );
    let person = |id: &str| format!("{PEOPLE}/{id}");
    let (status, body) = send(&app, "GET", &person(&priya), &alex_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["card"]["workingOn"], json!(["Agent memory"]));
    assert_eq!(body["status"], "matching");

    // Alex turns off: Alex cannot search, and nobody sees Alex.
    let (status, _) = send(
        &app,
        "PUT",
        NEARBY,
        &alex_token,
        Some(json!({"enabled": false})),
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        locations(&pool, &alex).await,
        0,
        "turning off forgets the location"
    );
    for path in [PEOPLE.to_string(), person(&priya)] {
        let (status, body) = send(&app, "GET", &path, &alex_token, None).await;
        assert_eq!(
            (status, body["errorCode"].as_str()),
            (409, Some("common_ground_nearby_off")),
            "{path}"
        );
    }
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert!(listed(&body).is_empty());
    let (status, body) = send(&app, "GET", &person(&alex), &priya_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (404, Some("common_ground_person_not_found"))
    );
    let (status, body) = locate(&app, &alex_token, here).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_nearby_off"))
    );

    // Back on, with consent again: visible after the next location.
    let back = json!({"enabled": true, "consent": true});
    assert_eq!(
        send(&app, "PUT", NEARBY, &alex_token, Some(back)).await.0,
        200
    );
    let (status, _) = send(&app, "GET", PEOPLE, &alex_token, None).await;
    assert_eq!(status, 409);
    assert_eq!(locate(&app, &alex_token, here).await.0, 200);
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert_eq!(listed(&body), vec![alex]);
}

#[tokio::test]
async fn pausing_hides_until_the_pause_ends() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (alex, alex_token) = located(&app, &pool, "Alex", here).await;
    let (_, priya_token) = located(&app, &pool, "Priya", north(here, 200.0)).await;
    let until = (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
    let (status, body) = send(
        &app,
        "PUT",
        NEARBY,
        &alex_token,
        Some(json!({"pausedUntil": until})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        (body["enabled"].clone(), body["participating"].clone()),
        (json!(true), json!(false))
    );
    assert_eq!(locations(&pool, &alex).await, 0);
    let (status, body) = send(&app, "GET", PEOPLE, &alex_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_nearby_off"))
    );
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert!(listed(&body).is_empty());
    assert_eq!(locate(&app, &alex_token, here).await.0, 409);

    // The pause ends on its own; Alex is seen again after the next location.
    query("UPDATE cloud_common_ground_nearby SET paused_until = now() - interval '1 second' WHERE account_id = $1")
        .bind(&alex)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(&app, "GET", PEOPLE, &alex_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_nearby_no_location"))
    );
    assert_eq!(locate(&app, &alex_token, here).await.0, 200);
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert_eq!(listed(&body), vec![alex.clone()]);
    // Resuming early with null.
    send(
        &app,
        "PUT",
        NEARBY,
        &alex_token,
        Some(json!({"pausedUntil": until})),
    )
    .await;
    let (_, body) = send(
        &app,
        "PUT",
        NEARBY,
        &alex_token,
        Some(json!({"pausedUntil": null})),
    )
    .await;
    assert_eq!(body["participating"], true);
}

#[tokio::test]
async fn sharing_off_and_stale_locations_stop_participation() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (alex, alex_token) = located(&app, &pool, "Alex", here).await;
    let (sam, sam_token) = located(&app, &pool, "Sam", north(here, 400.0)).await;
    let (_, priya_token) = located(&app, &pool, "Priya", north(here, 200.0)).await;
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert_eq!(listed(&body).len(), 2);

    let sharing = "/v1/cloud/common-ground/settings";
    send(
        &app,
        "PUT",
        sharing,
        &alex_token,
        Some(json!({"sharing": false})),
    )
    .await;
    let (status, body) = send(&app, "GET", PEOPLE, &alex_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_nearby_off"))
    );
    let (_, body) = send(&app, "GET", NEARBY, &alex_token, None).await;
    assert_eq!(
        (body["enabled"].clone(), body["participating"].clone()),
        (json!(true), json!(false))
    );
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert_eq!(listed(&body), vec![sam.clone()]);

    // Sam's location goes stale: Sam is not current and nobody sees Sam.
    query("UPDATE cloud_common_ground_nearby_locations SET captured_at = now() - interval '31 minutes', fresh_until = now() - interval '1 minute' WHERE account_id = $1")
        .bind(&sam)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(&app, "GET", PEOPLE, &sam_token, None).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (409, Some("common_ground_nearby_no_location"))
    );
    let (_, body) = send(&app, "GET", NEARBY, &sam_token, None).await;
    assert_eq!(body["location"]["fresh"], false);
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert!(listed(&body).is_empty(), "{body}");
    let _ = alex;
}
