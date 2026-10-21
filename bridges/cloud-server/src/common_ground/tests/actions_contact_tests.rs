//! Add and Chat from Common ground, and the relationship shown with people.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::{pool, send, signed_in};
use super::support::{make_contacts, people_in_a_room};

fn path(other: &str, action: &str) -> String {
    format!("/v1/cloud/common-ground/people/{other}/{action}")
}

async fn relationship_of(app: &axum::Router, token: &str, other: &str) -> Value {
    let (status, body) = send(
        app,
        "GET",
        &format!("/v1/cloud/common-ground/people/{other}"),
        token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body["relationship"].clone()
}

#[tokio::test]
async fn relationship_follows_add_and_mutual_accept() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, priya_token)] = [people[0].clone(), people[1].clone()];
    let none =
        json!({"contact": false, "request": null, "requestId": null, "conversationId": null});
    assert_eq!(relationship_of(&app, &alex_token, &priya).await, none);
    let room = format!("/v1/cloud/common-ground/rooms/{code}");
    let (_, body) = send(&app, "GET", &room, &alex_token, None).await;
    assert_eq!(body["members"][0]["relationship"], none, "{body}");
    assert_eq!(body["groups"], json!([]));
    assert_eq!(body["invitations"], json!([]));

    let (status, body) = send(&app, "POST", &path(&priya, "contact"), &alex_token, None).await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["relationship"]["request"], "outgoing");
    let request_id = body["relationship"]["requestId"].clone();
    assert!(request_id.is_string());
    let theirs = relationship_of(&app, &priya_token, &alex).await;
    assert_eq!(
        (theirs["request"].clone(), theirs["requestId"].clone()),
        (json!("incoming"), request_id)
    );
    let (message,): (Option<String>,) =
        query_as("SELECT message FROM cloud_contact_requests WHERE from_account_id = $1")
            .bind(&alex)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(message.as_deref(), Some("Found you on Grounding"));

    // Adding back accepts their request and opens the chat.
    let (status, body) = send(&app, "POST", &path(&alex, "contact"), &priya_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["helloMessage"].is_object(), "{body}");
    assert_eq!(body["relationship"]["contact"], true);
    assert_eq!(body["relationship"]["request"], Value::Null);
    let conversation_id = body["relationship"]["conversationId"].clone();
    assert!(conversation_id.is_string(), "{body}");
    let mine = relationship_of(&app, &alex_token, &priya).await;
    assert_eq!(mine["contact"], true);
    assert_eq!(mine["conversationId"], conversation_id);

    // The chat server knows this conversation by the same direct session.
    let mut pair = [alex.as_str(), priya.as_str()];
    pair.sort_unstable();
    let (status, body) = send(
        &app,
        "POST",
        "/v2/chat/conversations",
        &alex_token,
        Some(json!({
            "client_operation_id": Uuid::new_v4(),
            "kind": "direct",
            "client_session_id": format!("session:direct-person:{}:{}", pair[0], pair[1]),
            "member_account_ids": [priya],
        })),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["conversation"]["id"], conversation_id);

    // Match detail and results carry it too.
    let (status, body) = send(&app, "GET", &path(&priya, "match"), &alex_token, None).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["relationship"]["conversationId"], conversation_id);
}

#[tokio::test]
async fn add_needs_a_visible_person_who_is_not_a_contact() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _, people) = people_in_a_room(&pool, &["Alex", "Priya", "Dan"]).await;
    let [(alex, alex_token), (priya, _), (dan, _)] =
        [people[0].clone(), people[1].clone(), people[2].clone()];
    let (outsider, _) = signed_in(&pool, "Carol").await;
    for other in [outsider.as_str(), alex.as_str()] {
        let (status, body) = send(&app, "POST", &path(other, "contact"), &alex_token, None).await;
        assert_eq!(status, 404, "{body}");
        assert_eq!(body["errorCode"], "common_ground_person_not_found");
    }

    let long = format!("  {}  ", "a".repeat(300));
    let (status, _) = send(
        &app,
        "POST",
        &path(&priya, "contact"),
        &alex_token,
        Some(json!({"message": long})),
    )
    .await;
    assert_eq!(status, 201);
    let (message,): (String,) =
        query_as("SELECT message FROM cloud_contact_requests WHERE from_account_id = $1")
            .bind(&alex)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(message, "a".repeat(280));
    // A second Add returns the pending request.
    let (status, body) = send(&app, "POST", &path(&priya, "contact"), &alex_token, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["relationship"]["request"], "outgoing");

    make_contacts(&pool, &alex, &dan).await;
    let (status, body) = send(&app, "POST", &path(&dan, "contact"), &alex_token, None).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "already_contact");
}

#[tokio::test]
async fn chat_opens_one_direct_conversation_with_a_contact() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, priya_token)] = [people[0].clone(), people[1].clone()];
    let (status, body) = send(&app, "POST", &path(&priya, "chat"), &alex_token, None).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_not_contacts");
    assert_eq!(body["relationship"]["contact"], false);

    make_contacts(&pool, &alex, &priya).await;
    let (status, first) = send(&app, "POST", &path(&priya, "chat"), &alex_token, None).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["relationship"]["contact"], true);
    assert_eq!(
        first["relationship"]["conversationId"],
        first["conversationId"]
    );
    let (_, again) = send(&app, "POST", &path(&priya, "chat"), &alex_token, None).await;
    let (_, theirs) = send(&app, "POST", &path(&alex, "chat"), &priya_token, None).await;
    assert_eq!(again["conversationId"], first["conversationId"]);
    assert_eq!(theirs["conversationId"], first["conversationId"]);
    assert_eq!(theirs["sessionId"], first["sessionId"]);
    let (count,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_conversations WHERE legacy_session_id = $1")
            .bind(first["sessionId"].as_str().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "no duplicate conversation");
}
