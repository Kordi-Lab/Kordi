//! The card design a profile carries, synced across the owner's devices
//! and shown next to the kind wherever others see the profile.

use serde_json::{json, Value};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{build_profile, PROFILES};
use super::support::closed_code;

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
            assert_eq!(
                body["message"], "Pick a card design from the list.",
                "{body}"
            );
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
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"design": "ocean"}))).await;
    assert_eq!((status, &body["design"]), (200, &json!("ocean")), "{body}");
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

/// Two devices that edit different fields of the same profile at once keep
/// both edits: an update writes only the fields in its body.
#[tokio::test]
async fn concurrent_edits_to_different_fields_both_persist() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (_, alex) = signed_in(&pool, "Alex").await;
    let (status, kaust) = send(
        &app,
        "POST",
        PROFILES,
        &alex,
        Some(json!({"kind": "custom", "name": "KAUST", "icon": "globe"})),
    )
    .await;
    assert_eq!(status, 201, "{kaust}");
    let path = format!("{PROFILES}/{}", kaust["profileId"].as_str().unwrap());

    for (design, focus) in [
        ("research", "Agents"),
        ("ocean", "Retrieval"),
        ("workshop", "Evals"),
    ] {
        // Both start from the same state; neither carries the other's field.
        let ((design_status, _), (focus_status, _)) = tokio::join!(
            send(&app, "PUT", &path, &alex, Some(json!({"design": design}))),
            send(&app, "PUT", &path, &alex, Some(json!({"focus": focus}))),
        );
        assert_eq!((design_status, focus_status), (200, 200));
        let (_, body) = send(&app, "GET", PROFILES, &alex, None).await;
        let profile = body["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|profile| profile["profileId"] == kaust["profileId"])
            .unwrap()
            .clone();
        assert_eq!(
            json!([
                profile["name"],
                profile["design"],
                profile["focus"],
                profile["icon"]
            ]),
            json!(["KAUST", design, focus, "globe"]),
            "{profile}"
        );
    }
}
