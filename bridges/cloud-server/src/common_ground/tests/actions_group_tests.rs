//! Start group from a room, the groups and invitations shown with the room,
//! and Join.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::{pool, send, signed_in};
use super::support::{make_contacts, people_in_a_room};

async fn start(app: &axum::Router, code: &str, token: &str, body: Value) -> (u16, Value) {
    send(
        app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/group"),
        token,
        Some(body),
    )
    .await
}

async fn results(app: &axum::Router, code: &str, token: &str) -> Value {
    let (status, body) = send(
        app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/results"),
        token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body
}

async fn join(app: &axum::Router, code: &str, token: &str, reference: &str) -> (u16, Value) {
    send(
        app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/invitations/{reference}/join"),
        token,
        None,
    )
    .await
}

async fn members(pool: &sqlx_postgres::PgPool, conversation_id: &Value) -> Vec<String> {
    let id: Uuid = conversation_id.as_str().unwrap().parse().unwrap();
    let rows: Vec<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND membership_state = 'active' AND account_id NOT LIKE 'acct_cg_service%'
         ORDER BY account_id",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter().map(|(id,)| id).collect()
}

#[tokio::test]
async fn a_group_without_contacts_invites_and_invitees_join() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, priya_token), (sam, sam_token)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let (status, body) = start(&app, &code, &alex_token, json!({"memberIds": [priya, sam]})).await;
    assert_eq!(status, 201, "{body}");
    let group = body["group"].clone();
    assert_eq!(group["name"], "Common ground group");
    assert_eq!(group["memberCount"], 1);
    assert_eq!(body["added"], json!([]));
    assert_eq!(body["invited"].as_array().unwrap().len(), 2);
    assert!(!body.to_string().contains("kordi_gi_"), "no token");
    assert_eq!(
        members(&pool, &group["conversationId"]).await,
        vec![alex.as_str()]
    );

    let mine = results(&app, &code, &alex_token).await;
    assert_eq!(mine["groups"][0]["groupSpaceId"], group["groupSpaceId"]);
    assert_eq!(mine["groups"][0]["createdBy"]["accountId"], alex.as_str());
    assert_eq!(mine["groups"][0]["joined"], true);
    assert_eq!(mine["invitations"], json!([]));

    let theirs = results(&app, &code, &priya_token).await;
    assert_eq!(theirs["groups"][0]["joined"], false);
    let invitation = theirs["invitations"][0].clone();
    assert_eq!(invitation["from"]["accountId"], alex.as_str());
    assert_eq!(invitation["name"], "Common ground group");
    let (_, room) = send(
        &app,
        "GET",
        &format!("/v1/cloud/common-ground/rooms/{code}"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(room["invitations"][0], invitation);
    let reference = invitation["invitationRef"].as_str().unwrap();

    let (status, body) = join(&app, &code, &sam_token, reference).await;
    assert_eq!(status, 404, "only the invitee joins: {body}");
    let (status, body) = join(&app, &code, &priya_token, reference).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["status"], "joined");
    assert_eq!(body["conversationId"], group["conversationId"]);
    let (_, again) = join(&app, &code, &priya_token, reference).await;
    assert_eq!(again["status"], "already_joined");
    let mut expected = vec![alex.clone(), priya.clone()];
    expected.sort();
    assert_eq!(members(&pool, &group["conversationId"]).await, expected);

    let theirs = results(&app, &code, &priya_token).await;
    assert_eq!(theirs["groups"][0]["joined"], true);
    assert_eq!(theirs["groups"][0]["memberCount"], 2);
    assert_eq!(theirs["invitations"], json!([]));
    let sams = results(&app, &code, &sam_token).await;
    assert_eq!(sams["invitations"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn contacts_are_added_and_the_rest_invited() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya", "Sam"]).await;
    let [(alex, alex_token), (priya, _), (sam, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let (status, body) = start(
        &app,
        &code,
        &alex_token,
        json!({"name": "  Agent   memory ", "memberIds": [priya, sam]}),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["group"]["name"], "Agent memory");
    assert_eq!(body["group"]["memberCount"], 2);
    assert_eq!(body["added"][0]["accountId"], priya.as_str());
    assert_eq!(body["invited"][0]["accountId"], sam.as_str());
    let mut expected = vec![alex.clone(), priya.clone()];
    expected.sort();
    assert_eq!(
        members(&pool, &body["group"]["conversationId"]).await,
        expected
    );
    let (title,): (Option<String>,) =
        query_as("SELECT shared_title FROM cloud_chat_conversations WHERE legacy_session_id = $1")
            .bind(body["group"]["groupSpaceId"].as_str().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title.as_deref(), Some("Agent memory"));
}

#[tokio::test]
async fn start_group_checks_the_room_its_people_and_the_rate() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, _)] = [people[0].clone(), people[1].clone()];
    let (carol, carol_token) = signed_in(&pool, "Carol").await;
    for ids in [
        json!([carol]),
        json!([alex]),
        json!([]),
        json!([priya, carol]),
    ] {
        let (status, body) = start(&app, &code, &alex_token, json!({"memberIds": ids})).await;
        assert_eq!(status, 400, "{ids}: {body}");
        assert_eq!(body["errorCode"], "common_ground_invalid_group");
    }
    let (status, body) = start(&app, &code, &carol_token, json!({"memberIds": [priya]})).await;
    assert_eq!(status, 404, "{body}");
    assert_eq!(body["errorCode"], "common_ground_room_not_found");

    for attempt in 0..10 {
        let (status, body) = start(&app, &code, &alex_token, json!({"memberIds": [priya]})).await;
        assert_eq!(status, 201, "group {attempt}: {body}");
    }
    let (status, body) = start(&app, &code, &alex_token, json!({"memberIds": [priya]})).await;
    assert_eq!(status, 429, "{body}");
}
