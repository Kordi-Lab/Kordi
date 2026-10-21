//! The organizer of a card changes its time over the real HTTP surface, the
//! way the Mac's "Change time" does for a plan made from Common ground's Meet.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use std::sync::Arc;
use uuid::Uuid;

use super::http_tests::{bearer_token_for, seed_account, seed_conversation};
use super::models::{PlanCardParticipantInput, PlanCardProposeArgs, PlanCardState};
use crate::chat_sync::models::SendMessageRequest;
use crate::events::EventBus;
use crate::server::{router, ServerState};

fn at(days: i64, hour_offset: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::days(days) + chrono::Duration::hours(hour_offset))
        .to_rfc3339()
}

fn rsvp_of(card: &Value, account_id: &str) -> String {
    card["participants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|participant| participant["participantId"] == account_id)
        .map(|participant| participant["rsvp"].as_str().unwrap().to_string())
        .unwrap()
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn organizer_changes_the_time_over_http() {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");

    let suffix = Uuid::new_v4().simple().to_string();
    let jordan = format!("jordan-{suffix}");
    let maya = format!("maya-{suffix}");
    let riya = format!("riya-{suffix}");
    for account in [&jordan, &maya, &riya] {
        seed_account(&pool, account).await;
    }
    let conversation_id = Uuid::new_v4();
    seed_conversation(&pool, conversation_id, &jordan, &[&jordan, &maya, &riya]).await;
    let jordan_token = bearer_token_for(&pool, &jordan).await;
    let maya_token = bearer_token_for(&pool, &maya).await;
    let riya_token = bearer_token_for(&pool, &riya).await;

    // Jordan meets Maya the way Common ground's Meet does: Jordan organizes
    // the card and carries it in Jordan's own chat message.
    let participant = |account_id: &str, name: &str, organizer: bool| PlanCardParticipantInput {
        account_id: account_id.to_string(),
        display_name: name.to_string(),
        organizer,
    };
    let row = super::store::propose(
        &pool,
        &jordan,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: None,
            existing_revision: None,
            title: "Coffee".to_string(),
            start_at: Some(at(2, 0)),
            end_at: Some(at(2, 1)),
            location: Some("Library cafe".to_string()),
            state: PlanCardState::AwaitingConfirmation,
            unresolved_fields: Vec::new(),
            participants: vec![
                participant(&jordan, "Jordan", true),
                participant(&maya, "Maya", false),
            ],
            source_message_ids: Vec::new(),
            options: Vec::new(),
        },
    )
    .await
    .expect("organizer card");
    let event_id = row.event_id.clone();
    let message = SendMessageRequest {
        client_message_id: Uuid::new_v4(),
        kind: "text".to_string(),
        content: json!({
            "schema": 1,
            "blocks": [crate::pip::cards::card_block_from_row(&row, "event")],
            "legacy_attachments": [],
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    crate::chat_sync::store::send_message(&pool, &jordan, conversation_id, message)
        .await
        .expect("carrier message");

    let state = Arc::new(ServerState::new(pool.clone(), EventBus::noop()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    let server = tokio::spawn(async move {
        axum::serve(listener, router(state)).await.unwrap();
    });
    let endpoint = format!("http://{addr}/v1/cloud/plan_cards");
    let client = reqwest::Client::new();
    let post = |token: &str, body: Value| {
        client
            .post(&endpoint)
            .bearer_auth(token.to_string())
            .json(&body)
            .send()
    };

    // Maya says yes to the first time.
    let response = post(
        &maya_token,
        json!({"action": "rsvp", "eventId": event_id, "participantId": maya, "rsvp": "yes"}),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let card: Value = response.json().await.unwrap();
    assert_eq!(rsvp_of(&card, &maya), "yes");
    let revision = card["revision"].as_i64().unwrap();

    let revise = |existing_event_id: Option<&str>, revision: i64| {
        json!({
            "action": "propose",
            "conversationId": conversation_id.to_string(),
            "existingEventId": existing_event_id,
            "existingRevision": revision,
            "title": "Coffee",
            "startAt": at(3, 0),
            "endAt": at(3, 1),
            "location": "Library cafe",
            "state": "awaitingConfirmation",
            "participants": [
                {"participantId": jordan, "displayName": "Jordan", "organizer": true},
                {"participantId": maya, "displayName": "Maya", "organizer": false},
            ],
        })
    };

    // Maya is on the card but not its organizer.
    let response = post(&maya_token, revise(Some(&event_id), revision))
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["message"], "Only the organizer can change this plan.");
    // Riya is in the chat but not on the card at all.
    let response = post(&riya_token, revise(Some(&event_id), revision))
        .await
        .unwrap();
    assert_eq!(response.status(), 403);

    // A member still cannot open a new card.
    let response = post(&jordan_token, revise(None, revision)).await.unwrap();
    assert_eq!(response.status(), 403);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["message"], "Plan cards are proposed by PiP.");

    // A change of time keeps the same people.
    let mut with_riya = revise(Some(&event_id), revision);
    with_riya["participants"]
        .as_array_mut()
        .unwrap()
        .push(json!({"participantId": riya, "displayName": "Riya"}));
    let response = post(&jordan_token, with_riya).await.unwrap();
    assert_eq!(response.status(), 400);

    // Jordan moves it a day later: Maya is asked again, Jordan stays yes.
    let response = post(&jordan_token, revise(Some(&event_id), revision))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let card: Value = response.json().await.unwrap();
    assert_eq!(card["revision"].as_i64().unwrap(), revision + 1);
    assert_eq!(card["state"], "awaiting_confirmation");
    assert_eq!(rsvp_of(&card, &maya), "pending");
    assert_eq!(rsvp_of(&card, &jordan), "yes");
    let organizers: Vec<&Value> = card["participants"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|participant| participant["organizer"] == true)
        .collect();
    assert_eq!(organizers.len(), 1);
    assert_eq!(organizers[0]["participantId"], jordan.as_str());

    // Jordan's own chat message now shows the new revision.
    let (content,): (Value,) = query_as(
        "SELECT content FROM cloud_chat_messages
         WHERE conversation_id = $1 AND sender_account_id = $2",
    )
    .bind(conversation_id)
    .bind(&jordan)
    .fetch_one(&pool)
    .await
    .unwrap();
    let block = &content["blocks"][0];
    assert_eq!(block["eventId"], event_id.as_str());
    assert_eq!(block["revision"], card["revision"]);

    // A stale revision is a conflict.
    let response = post(&jordan_token, revise(Some(&event_id), revision))
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["errorCode"], "plan_card_revision_conflict");

    // Once confirmed, the plan can no longer be revised this way.
    let current = card["revision"].as_i64().unwrap();
    let response = post(
        &jordan_token,
        json!({"action": "confirm", "eventId": event_id, "revision": current, "confirmedBy": jordan}),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 200);
    let card: Value = response.json().await.unwrap();
    assert_eq!(card["state"], "confirmed");
    let response = post(
        &jordan_token,
        revise(Some(&event_id), card["revision"].as_i64().unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 409);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["errorCode"], "plan_card_invalid_transition");

    server.abort();
}
