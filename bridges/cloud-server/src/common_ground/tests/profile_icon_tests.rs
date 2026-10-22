//! The icon a profile carries, synced across the owner's devices and shown
//! next to the kind and design wherever others see the profile.

use serde_json::{json, Value};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{build_profile, PROFILES};
use super::support::closed_code;

async fn icons(app: &axum::Router, token: &str) -> Vec<Value> {
    let (status, body) = send(app, "GET", PROFILES, token, None).await;
    assert_eq!(status, 200, "{body}");
    body["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|profile| json!([profile["name"], profile["icon"]]))
        .collect()
}

#[tokio::test]
async fn profiles_keep_an_icon() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex_id, alex) = signed_in(&pool, "Alex").await;
    let (priya_id, priya) = signed_in(&pool, "Priya").await;

    for bad in [json!("unicorn"), json!("Rocket"), json!(3)] {
        let (status, body) = send(
            &app,
            "POST",
            PROFILES,
            &alex,
            Some(json!({"kind": "custom", "name": "KAUST", "icon": bad})),
        )
        .await;
        assert_eq!(
            status,
            if bad.is_string() { 400 } else { 422 },
            "{bad}: {body}"
        );
        if bad.is_string() {
            assert_eq!(body["errorCode"], "common_ground_invalid_profile");
            assert_eq!(body["message"], "Pick an icon from the list.", "{body}");
        }
    }
    let (status, work) = send(&app, "POST", PROFILES, &alex, Some(json!({"kind": "work"}))).await;
    assert_eq!((status, &work["icon"]), (201, &Value::Null), "{work}");
    let (status, kaust) = send(
        &app,
        "POST",
        PROFILES,
        &alex,
        Some(json!({"kind": "custom", "name": "KAUST", "design": "research", "icon": "flask"})),
    )
    .await;
    assert_eq!(
        (status, &kaust["icon"], &kaust["design"]),
        (201, &json!("flask"), &json!("research")),
        "{kaust}"
    );
    let kaust_id = kaust["profileId"].as_str().unwrap().to_string();
    assert_eq!(
        icons(&app, &alex).await,
        vec![json!(["Work", null]), json!(["KAUST", "flask"])]
    );

    // Absent keeps it, a value changes it, null removes it.
    let path = format!("{PROFILES}/{kaust_id}");
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"design": null}))).await;
    assert_eq!((status, &body["icon"]), (200, &json!("flask")), "{body}");
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"icon": "rocket"}))).await;
    assert_eq!((status, &body["icon"]), (200, &json!("rocket")), "{body}");
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"icon": "unicorn"}))).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_invalid_profile"))
    );
    assert_eq!(
        icons(&app, &alex).await,
        vec![json!(["Work", null]), json!(["KAUST", "rocket"])]
    );
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"icon": null}))).await;
    assert_eq!((status, &body["icon"]), (200, &Value::Null), "{body}");
    let (_, body) = send(&app, "PUT", &path, &alex, Some(json!({"icon": "globe"}))).await;
    assert_eq!(body["icon"], "globe");

    // The card route returns it for the owner.
    build_profile(&app, &pool, (&alex_id, &alex), &kaust_id, "Agent memory").await;
    let (status, body) = send(
        &app,
        "GET",
        &format!("/v1/cloud/common-ground/card?profile={kaust_id}"),
        &alex,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["profile"]["icon"], "globe", "{body}");

    // Others see it next to the design in the room they share.
    let code = closed_code(&pool).await;
    let join = format!("/v1/cloud/common-ground/rooms/{code}/join");
    let (status, body) = send(
        &app,
        "POST",
        &join,
        &alex,
        Some(json!({"profileId": kaust_id})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let (_, priya_work) = send(
        &app,
        "POST",
        PROFILES,
        &priya,
        Some(json!({"kind": "work", "icon": "briefcase"})),
    )
    .await;
    let priya_work = priya_work["profileId"].as_str().unwrap().to_string();
    build_profile(
        &app,
        &pool,
        (&priya_id, &priya),
        &priya_work,
        "Agent memory",
    )
    .await;
    let (status, body) = send(&app, "POST", &join, &priya, Some(json!({}))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["members"][0]["profile"],
        json!({
            "profileId": kaust_id, "kind": "custom", "name": "KAUST", "design": null,
            "icon": "globe"
        })
    );
    let (status, body) = send(
        &app,
        "GET",
        &format!("/v1/cloud/common-ground/rooms/{code}"),
        &alex,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let priya_tag = body["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|member| member["profile"]["profileId"] == priya_work.as_str())
        .map(|member| member["profile"].clone());
    assert_eq!(
        priya_tag,
        Some(json!({
            "profileId": priya_work, "kind": "work", "name": "Work", "design": null,
            "icon": "briefcase"
        }))
    );
}
