//! The card design a profile carries, synced across the owner's devices
//! and shown next to the kind wherever others see the profile.

use serde_json::{json, Value};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{build_profile, PROFILES};
use super::support::free_code;

async fn designs(app: &axum::Router, token: &str) -> Vec<Value> {
    let (status, body) = send(app, "GET", PROFILES, token, None).await;
    assert_eq!(status, 200, "{body}");
    body["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|profile| json!([profile["name"], profile["design"]]))
        .collect()
}

#[tokio::test]
async fn profiles_keep_a_card_design() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex_id, alex) = signed_in(&pool, "Alex").await;
    let (priya_id, priya) = signed_in(&pool, "Priya").await;

    for bad in [json!("neon"), json!("Workshop"), json!(3)] {
        let (status, body) = send(
            &app,
            "POST",
            PROFILES,
            &alex,
            Some(json!({"kind": "custom", "name": "KAUST", "design": bad})),
        )
        .await;
        assert_eq!(
            status,
            if bad.is_string() { 400 } else { 422 },
            "{bad}: {body}"
        );
        if bad.is_string() {
            assert_eq!(body["errorCode"], "common_ground_invalid_profile");
        }
    }
    let (status, work) = send(&app, "POST", PROFILES, &alex, Some(json!({"kind": "work"}))).await;
    assert_eq!((status, &work["design"]), (201, &Value::Null), "{work}");
    let (status, kaust) = send(
        &app,
        "POST",
        PROFILES,
        &alex,
        Some(json!({"kind": "custom", "name": "KAUST", "design": "research"})),
    )
    .await;
    assert_eq!(
        (status, &kaust["design"]),
        (201, &json!("research")),
        "{kaust}"
    );
    let kaust_id = kaust["profileId"].as_str().unwrap().to_string();
    assert_eq!(
        designs(&app, &alex).await,
        vec![json!(["Work", null]), json!(["KAUST", "research"])]
    );

    // Absent keeps it, a value changes it, null gives back the kind's.
    let path = format!("{PROFILES}/{kaust_id}");
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"focus": "Agents"}))).await;
    assert_eq!(
        (status, &body["design"]),
        (200, &json!("research")),
        "{body}"
    );
    let (status, body) = send(
        &app,
        "PUT",
        &path,
        &alex,
        Some(json!({"design": "workshop"})),
    )
    .await;
    assert_eq!(
        (status, &body["design"]),
        (200, &json!("workshop")),
        "{body}"
    );
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"design": "neon"}))).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_invalid_profile"))
    );
    assert_eq!(
        designs(&app, &alex).await,
        vec![json!(["Work", null]), json!(["KAUST", "workshop"])]
    );
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"design": null}))).await;
    assert_eq!((status, &body["design"]), (200, &Value::Null), "{body}");
    let (_, body) = send(
        &app,
        "PUT",
        &path,
        &alex,
        Some(json!({"design": "workshop"})),
    )
    .await;
    assert_eq!(body["design"], "workshop");

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
    assert_eq!(body["profile"]["design"], "workshop", "{body}");

    // Others see it next to the kind in the room they share.
    let code = free_code();
    sqlx_core::query::query("UPDATE cloud_common_ground_rooms SET closed_at = now() WHERE code = $1 AND closed_at IS NULL")
        .bind(&code)
        .execute(&pool)
        .await
        .unwrap();
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
        Some(json!({"kind": "work"})),
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
            "profileId": kaust_id, "kind": "custom", "name": "KAUST", "design": "workshop",
            "icon": null
        })
    );
}
