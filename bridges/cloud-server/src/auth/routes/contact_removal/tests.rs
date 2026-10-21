//! Database tests for removing a contact, through the public routes. They
//! use the Common ground fixture and its skip rule.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;

use crate::common_ground::tests::db_fixture::{app, pool, send, signed_in};

fn contact_ids(body: &Value) -> Vec<String> {
    body["contacts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|contact| contact["accountId"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn removing_a_contact_clears_both_sides_and_needs_a_new_request() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (alex, alex_token) = signed_in(&pool, "rm_alex").await;
    let (priya, priya_token) = signed_in(&pool, "rm_priya").await;
    let requests = "/v1/cloud/contacts/requests";

    let (status, body) = send(
        &app,
        "POST",
        requests,
        &alex_token,
        Some(json!({"peerAccountId": priya})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let request_id = body["request"]["requestId"].as_str().unwrap().to_string();
    let (status, body) = send(
        &app,
        "POST",
        &format!("{requests}/{request_id}/accept"),
        &priya_token,
        None,
    )
    .await;
    assert_eq!(status, 200, "{body}");
    for (token, peer) in [(&alex_token, &priya), (&priya_token, &alex)] {
        let (_, body) = send(&app, "GET", "/v1/cloud/contacts", token, None).await;
        assert!(contact_ids(&body).contains(peer), "{body}");
    }
    let (messages_before,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_messages WHERE sender_account_id IN ($1, $2)")
            .bind(&alex)
            .bind(&priya)
            .fetch_one(&pool)
            .await
            .unwrap();

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/v1/cloud/contacts/{priya}"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 204);
    for (token, peer) in [(&alex_token, &priya), (&priya_token, &alex)] {
        let (_, body) = send(&app, "GET", "/v1/cloud/contacts", token, None).await;
        assert!(!contact_ids(&body).contains(peer), "{body}");
    }
    let (status, _) = send(
        &app,
        "GET",
        &format!("/v1/cloud/contacts/{priya}/profile"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 404, "a removed contact's profile is gone");
    let (messages_after,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_chat_messages WHERE sender_account_id IN ($1, $2)")
            .bind(&alex)
            .bind(&priya)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(messages_before, messages_after, "the conversation stays");
    let (accepted,): (i64,) = query_as(
        "SELECT COUNT(*) FROM cloud_contact_requests WHERE status = 'accepted' \
         AND from_account_id IN ($1, $2) AND to_account_id IN ($1, $2)",
    )
    .bind(&alex)
    .bind(&priya)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(accepted, 0, "no accepted request outlives the contact");

    let (status, body) = send(
        &app,
        "DELETE",
        &format!("/v1/cloud/contacts/{priya}"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(status, 404);
    assert_eq!(body["errorCode"], "contact_not_found");

    let (status, body) = send(
        &app,
        "POST",
        requests,
        &priya_token,
        Some(json!({"peerAccountId": alex})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(body["request"]["status"], "pending");
    let (_, body) = send(&app, "GET", requests, &alex_token, None).await;
    let pending: Vec<&str> = body["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|request| request["fromAccountId"].as_str())
        .collect();
    assert_eq!(pending, vec![priya.as_str()], "{body}");
}

#[tokio::test]
async fn removing_yourself_is_rejected() {
    let Some(pool) = pool().await else { return };
    let app = app(&pool, None);
    let (me, token) = signed_in(&pool, "rm_self").await;
    let (status, body) = send(
        &app,
        "DELETE",
        &format!("/v1/cloud/contacts/{me}"),
        &token,
        None,
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(body["errorCode"], "self_contact");
}
