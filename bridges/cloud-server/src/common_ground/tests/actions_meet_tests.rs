//! Meet: a plan card proposed in the direct chat with a contact.

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::{pool, send};
use super::support::{make_contacts, people_in_a_room};

#[tokio::test]
async fn meet_proposes_a_plan_card_in_the_direct_chat() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, _, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, priya_token)] = [people[0].clone(), people[1].clone()];
    let meet = format!("/v1/cloud/common-ground/people/{priya}/meet");
    let start = (Utc::now() + Duration::days(1)).to_rfc3339();

    for invalid in [json!({}), json!({"startAt": "tomorrow"})] {
        let (status, body) = send(&app, "POST", &meet, &alex_token, Some(invalid)).await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(body["errorCode"], "invalid_start_at");
    }
    let (status, body) = send(
        &app,
        "POST",
        &meet,
        &alex_token,
        Some(json!({"startAt": start})),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["errorCode"], "common_ground_not_contacts");

    make_contacts(&pool, &alex, &priya).await;
    let (status, body) = send(
        &app,
        "POST",
        &meet,
        &alex_token,
        Some(json!({"startAt": start, "location": " Hall B "})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let conversation_id = body["conversationId"].as_str().unwrap().to_string();
    assert_eq!(body["relationship"]["conversationId"], conversation_id);
    let (_, chat) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/people/{priya}/chat"),
        &alex_token,
        None,
    )
    .await;
    assert_eq!(chat["conversationId"], conversation_id, "the direct chat");

    let event_id = body["planCardId"].as_str().unwrap().to_string();
    let card = crate::plan_cards::store::load(&pool, &event_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(card.conversation_id, conversation_id);
    assert_eq!(card.title, "Meet Priya");
    assert_eq!(card.location.as_deref(), Some("Hall B"));
    assert_eq!(card.state.as_db_str(), "awaiting_confirmation");
    let mut participants: Vec<(String, bool)> = card
        .participants
        .iter()
        .map(|p| (p.account_id.clone(), p.organizer))
        .collect();
    participants.sort();
    let mut expected = vec![(alex.clone(), true), (priya.clone(), false)];
    expected.sort();
    assert_eq!(participants, expected);

    // The card is in the chat in Alex's message, and Priya's answer
    // refreshes it there.
    let carrier = || {
        let pool = pool.clone();
        let conversation_id: Uuid = conversation_id.parse().unwrap();
        let alex = alex.clone();
        async move {
            let (content,): (Value,) = query_as(
                "SELECT content FROM cloud_chat_messages
                 WHERE conversation_id = $1 AND sender_account_id = $2
                   AND content->'blocks' @> '[{\"type\": \"plan_card\"}]'::jsonb",
            )
            .bind(conversation_id)
            .bind(alex)
            .fetch_one(&pool)
            .await
            .unwrap();
            content["blocks"][0].clone()
        }
    };
    let block = carrier().await;
    assert_eq!(block["eventId"], event_id.as_str());
    let (kind,): (String,) = query_as(
        "SELECT message_kind FROM cloud_chat_messages
         WHERE conversation_id = $1 AND sender_account_id = $2",
    )
    .bind(conversation_id.parse::<Uuid>().unwrap())
    .bind(&alex)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(kind, "system-notice", "the card shows as a System notice");
    assert_eq!(block["revision"], 1);
    let (status, body) = send(
        &app,
        "POST",
        "/v1/cloud/plan_cards",
        &priya_token,
        Some(json!({"action": "rsvp", "eventId": event_id, "participantId": priya, "rsvp": "yes"})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let block = carrier().await;
    let answers: Vec<&str> = block["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["rsvp"].as_str().unwrap())
        .collect();
    assert_eq!(answers, ["yes", "yes"], "{block}");
}
