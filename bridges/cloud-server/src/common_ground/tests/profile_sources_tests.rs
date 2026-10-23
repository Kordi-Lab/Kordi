//! The sources each profile's card is built from: saved with a build or a
//! profile update, synced across the owner's devices, never shown to others.

use serde_json::{json, Value};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::profile_support::{create_profile, PROFILES};
use super::support::{card_reply, claim, join_fresh_room, RUNNER};
use crate::common_ground::complete;

const BUILD: &str = "/v1/cloud/common-ground/card/build";

async fn profile(app: &axum::Router, token: &str, profile_id: &str) -> Value {
    let (status, body) = send(app, "GET", PROFILES, token, None).await;
    assert_eq!(status, 200, "{body}");
    body["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|profile| profile["profileId"] == profile_id)
        .cloned()
        .unwrap()
}

#[tokio::test]
async fn each_profile_remembers_its_own_sources() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex_id, alex) = signed_in(&pool, "Alex").await;
    let work = create_profile(&app, &alex, "work", None).await;
    let health = create_profile(&app, &alex, "health", None).await;
    assert_eq!(profile(&app, &alex, &work).await["sources"], Value::Null);

    // A build saves the cleaned picks on its profile only.
    let picks = json!({
        "memory": false,
        "connectors": ["gmail", "outlook", "github"],
        "device": ["calendar", "photos"],
        "agents": true,
        "documents": ["att_missing"],
        "links": "",
        "notes": "I study agent memory.",
    });
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &alex,
        Some(json!({"profileId": work, "notes": "I study agent memory.", "picks": picks})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    let saved = json!({
        "memory": false,
        "connectors": ["gmail", "github"],
        "device": ["calendar"],
        "agents": true,
        "documents": ["att_missing"],
        "links": "",
        "notes": "I study agent memory.",
    });
    assert_eq!(body["profile"]["sources"], saved, "{body}");
    // A document that is not the account's is not read.
    assert_eq!(body["used"], json!(["Notes"]), "{body}");
    assert_eq!(profile(&app, &alex, &work).await["sources"], saved);
    assert_eq!(profile(&app, &alex, &health).await["sources"], Value::Null);
    let run_id = claim(&pool, &alex_id).await;
    complete(
        &pool,
        &run_id,
        RUNNER,
        &card_reply(&["Agent memory"], &[], &[], &[]),
    )
    .await
    .unwrap();

    // A build already running does not save new picks.
    let (status, _) = send(
        &app,
        "POST",
        BUILD,
        &alex,
        Some(json!({"profileId": health, "notes": "Marathon."})),
    )
    .await;
    assert_eq!(status, 202);
    let (status, _) = send(
        &app,
        "POST",
        BUILD,
        &alex,
        Some(json!({"profileId": health, "notes": "Marathon.", "picks": {"memory": true}})),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(profile(&app, &alex, &health).await["sources"], Value::Null);
    let run_id = claim(&pool, &alex_id).await;
    complete(
        &pool,
        &run_id,
        RUNNER,
        &card_reply(&["Running"], &[], &[], &[]),
    )
    .await
    .unwrap();

    // The card route returns them to the owner.
    let (status, body) = send(
        &app,
        "GET",
        &format!("/v1/cloud/common-ground/card?profile={work}"),
        &alex,
        None,
    )
    .await;
    assert_eq!(
        (status, &body["profile"]["sources"]),
        (200, &saved),
        "{body}"
    );
}

#[tokio::test]
async fn updates_change_sources_without_touching_the_design() {
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
        Some(json!({"kind": "custom", "name": "KAUST", "design": "ocean", "icon": "flask"})),
    )
    .await;
    assert_eq!(status, 201, "{kaust}");
    assert_eq!(kaust["sources"], Value::Null);
    let id = kaust["profileId"].as_str().unwrap().to_string();
    let path = format!("{PROFILES}/{id}");

    let (status, body) = send(
        &app,
        "PUT",
        &path,
        &alex,
        Some(
            json!({"sources": {"memory": true, "device": ["reminders", "reminders"],
                                "notes": "n".repeat(4100)}}),
        ),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let saved = json!({
        "memory": true, "connectors": [], "device": ["reminders"], "agents": false,
        "documents": [], "links": "", "notes": "n".repeat(4000),
    });
    assert_eq!(
        json!([body["design"], body["icon"], body["sources"]]),
        json!(["ocean", "flask", saved]),
        "{body}"
    );

    // Design and icon edits keep the sources; a malformed body changes nothing.
    let (status, body) = send(
        &app,
        "PUT",
        &path,
        &alex,
        Some(json!({"design": "rose", "icon": null})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        json!([body["design"], body["icon"], body["sources"]]),
        json!(["rose", null, saved])
    );
    let (status, _) = send(
        &app,
        "PUT",
        &path,
        &alex,
        Some(json!({"sources": {"memory": "yes"}})),
    )
    .await;
    assert_eq!(status, 422);
    let (status, _) = send(&app, "PUT", &path, &alex, Some(json!({"sources": 3}))).await;
    assert_eq!(status, 422);
    assert_eq!(profile(&app, &alex, &id).await["sources"], saved);

    // Concurrent edits to different fields both persist.
    let picks = json!({"memory": false, "connectors": ["slack"]});
    let ((a, _), (b, _)) = tokio::join!(
        send(&app, "PUT", &path, &alex, Some(json!({"sources": picks}))),
        send(&app, "PUT", &path, &alex, Some(json!({"design": "mint"}))),
    );
    assert_eq!((a, b), (200, 200));
    let after = profile(&app, &alex, &id).await;
    assert_eq!(after["design"], "mint");
    assert_eq!(after["sources"]["connectors"], json!(["slack"]));

    // `null` forgets them.
    let (status, body) = send(&app, "PUT", &path, &alex, Some(json!({"sources": null}))).await;
    assert_eq!(
        (status, &body["sources"], &body["design"]),
        (200, &Value::Null, &json!("mint"))
    );
}

#[tokio::test]
async fn others_never_see_the_sources() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex_id, alex) = signed_in(&pool, "Alex").await;
    let (priya_id, priya) = signed_in(&pool, "Priya").await;
    let marker = "att_private_pick_marker";
    for (id, token, picks) in [
        (
            &alex_id,
            &alex,
            json!({"memory": true, "documents": [marker]}),
        ),
        (&priya_id, &priya, json!({"memory": true})),
    ] {
        let (status, body) = send(
            &app,
            "POST",
            BUILD,
            token,
            Some(json!({"notes": "I study agent memory.", "picks": picks})),
        )
        .await;
        assert_eq!(status, 202, "{body}");
        let run_id = claim(&pool, id).await;
        complete(
            &pool,
            &run_id,
            RUNNER,
            &card_reply(&["Agent memory"], &["Retrieval"], &[], &[]),
        )
        .await
        .unwrap();
    }
    let code = join_fresh_room(&app, &pool, &[&alex, &priya]).await;

    let seen = [
        send(
            &app,
            "GET",
            &format!("/v1/cloud/common-ground/rooms/{code}"),
            &priya,
            None,
        )
        .await,
        send(
            &app,
            "GET",
            &format!("/v1/cloud/common-ground/rooms/{code}/preview"),
            &priya,
            None,
        )
        .await,
        send(
            &app,
            "GET",
            &format!("/v1/cloud/common-ground/people/{alex_id}"),
            &priya,
            None,
        )
        .await,
        send(&app, "GET", "/v1/cloud/common-ground/recent", &priya, None).await,
    ];
    let mut checked = 0;
    for (status, body) in seen {
        if status != 200 {
            continue;
        }
        let text = body.to_string();
        assert!(!text.contains(marker), "{text}");
        assert!(!text.contains("\"sources\""), "{text}");
        checked += 1;
    }
    assert!(checked >= 2, "the room and the person views were read");
    // The owner sees them.
    let (_, body) = send(&app, "GET", PROFILES, &alex, None).await;
    assert!(body.to_string().contains(marker));
}
