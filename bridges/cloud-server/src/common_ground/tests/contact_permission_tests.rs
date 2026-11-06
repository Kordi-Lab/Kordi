//! "See my card" off (docs/contact-permissions.md): the restricted viewer
//! gets exactly what a card that is not shared gives, through pairings,
//! rooms, Recent, contact profiles and Nearby. The owner still sees the
//! viewer, and turning it back on restores everything.

use serde_json::{json, Value};

use super::db_fixture::{account, app, pool, send, signed_in};
use super::nearby_support::{listed, located, north, setup, spot, PEOPLE};
use super::sharing_support::{
    card, card_and_match, contact_grounding, follow_through, hidden, ids, lobby, recent_ids,
    results, CG,
};
use super::support::{answer_match, build_card_with, card_reply, make_contacts, people_in_a_room};

async fn set_card_access(app: &axum::Router, token: &str, other: &str, on: bool) {
    let path = format!("/v1/cloud/contacts/{other}/permissions");
    let (status, body) = send(app, "PUT", &path, token, Some(json!({"cardAccess": on}))).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["cardAccess"], on);
}

#[tokio::test]
async fn card_off_hides_a_pairing_from_that_person_only() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, alex_token) = signed_in(&pool, "Alex").await;
    let (priya, priya_token) = signed_in(&pool, "Priya").await;
    let alex_card = card_reply(&["Agent memory"], &["Retrieval"], &["Eval design"], &[]);
    build_card_with(&app, &pool, &alex, &alex_token, &alex_card).await;
    let priya_card = card_reply(&["Memory for agents"], &["Retrieval"], &[], &[]);
    build_card_with(&app, &pool, &priya, &priya_token, &priya_card).await;
    let (status, body) = send(
        &app,
        "POST",
        &format!("{CG}/pairings/code"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let redeem = json!({"code": body["code"]});
    let path = format!("{CG}/pairings/redeem");
    assert_eq!(
        send(&app, "POST", &path, &priya_token, Some(redeem))
            .await
            .0,
        200
    );
    make_contacts(&pool, &alex, &priya).await;
    let detail = format!("{CG}/people/{priya}/match");
    assert_eq!(send(&app, "GET", &detail, &alex_token, None).await.0, 202);
    answer_match(&pool, &alex).await;
    assert_eq!(send(&app, "GET", &detail, &alex_token, None).await.0, 200);
    assert_eq!(recent_ids(&app, &alex_token).await, vec![priya.clone()]);

    // Priya stops Alex from seeing her card: he gets what "not shared" gives.
    set_card_access(&app, &priya_token, &alex, false).await;
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [hidden(), hidden()]
    );
    assert_eq!(
        follow_through(&app, &alex_token, &priya).await,
        vec![hidden(); 3]
    );
    assert!(recent_ids(&app, &alex_token).await.is_empty());
    assert_eq!(
        contact_grounding(&app, &alex_token, &priya).await,
        Value::Null
    );

    // One-directional: Priya still sees Alex.
    let (status, body) = card(&app, &priya_token, &alex, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["card"]["workingOn"], json!(["Agent memory"]));
    assert_ne!(
        contact_grounding(&app, &priya_token, &alex).await,
        Value::Null
    );

    // Removing and re-adding the contact keeps the restriction.
    let remove = format!("/v1/cloud/contacts/{alex}");
    let (status, body) = send(&app, "DELETE", &remove, &priya_token, None).await;
    assert!(status < 300, "{status} {body}");
    make_contacts(&pool, &alex, &priya).await;
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [hidden(), hidden()]
    );

    // Back on, Alex sees her card again.
    set_card_access(&app, &priya_token, &alex, true).await;
    let (status, body) = card(&app, &alex_token, &priya, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(recent_ids(&app, &alex_token).await, vec![priya.clone()]);
    assert_ne!(
        contact_grounding(&app, &alex_token, &priya).await,
        Value::Null
    );
}

#[tokio::test]
async fn card_off_hides_a_room_member_from_that_person_only() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, priya_token), (sam, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    make_contacts(&pool, &alex, &priya).await;
    set_card_access(&app, &priya_token, &alex, false).await;

    let lobby_of_alex = lobby(&app, &code, &alex_token).await;
    assert!(
        lobby_of_alex.contains(&(priya.clone(), false)),
        "{lobby_of_alex:?}"
    );
    assert!(
        lobby_of_alex.contains(&(sam.clone(), true)),
        "{lobby_of_alex:?}"
    );
    let lobby_of_priya = lobby(&app, &code, &priya_token).await;
    assert!(
        lobby_of_priya.contains(&(alex.clone(), true)),
        "{lobby_of_priya:?}"
    );

    let (status, body) = results(&app, &code, &alex_token).await;
    assert!(status == 200 || status == 202, "{status} {body}");
    assert!(!ids(&body["people"], "person").contains(&priya), "{body}");
    for topic in body["topics"].as_array().unwrap() {
        assert!(!ids(&topic["people"], "").contains(&priya), "{body}");
    }
    assert_eq!(
        card_and_match(&app, &alex_token, &priya, None).await,
        [hidden(), hidden()]
    );
    let (status, _) = card(&app, &priya_token, &alex, None).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn card_off_hides_a_nearby_person_from_that_person_only() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _) = setup(&pool).await;
    let here = spot();
    let (alex, alex_token) = located(&app, &pool, "Alex", here).await;
    let (priya, priya_token) = located(&app, &pool, "Priya", north(here, 80.0)).await;
    make_contacts(&pool, &alex, &priya).await;
    let (_, body) = send(&app, "GET", PEOPLE, &alex_token, None).await;
    assert_eq!(listed(&body), vec![priya.clone()]);

    set_card_access(&app, &priya_token, &alex, false).await;
    let (status, body) = send(&app, "GET", PEOPLE, &alex_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert!(listed(&body).is_empty(), "{body}");
    let one = format!("{PEOPLE}/{priya}");
    let (status, body) = send(&app, "GET", &one, &alex_token, None).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "common_ground_person_not_found");
    let add = format!("{CG}/people/{priya}/contact");
    assert_eq!(send(&app, "POST", &add, &alex_token, None).await.0, 404);
    // Priya still sees Alex.
    let (_, body) = send(&app, "GET", PEOPLE, &priya_token, None).await;
    assert_eq!(listed(&body), vec![alex.clone()]);
}
