//! A group started from a room carries `origin: "grounding"` in its
//! conversation snapshot; other groups carry none.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::{pool, send};
use super::support::{make_contacts, people_in_a_room};
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest};

#[tokio::test]
async fn room_groups_carry_the_grounding_origin() {
    let Some(pool) = pool().await else {
        return;
    };
    let (app, code, people) = people_in_a_room(&pool, &["Alex", "Priya"]).await;
    let [(alex, alex_token), (priya, _)] = [people[0].clone(), people[1].clone()];
    make_contacts(&pool, &alex, &priya).await;
    let (status, body) = send(
        &app,
        "POST",
        &format!("/v1/cloud/common-ground/rooms/{code}/group"),
        &alex_token,
        Some(json!({"memberIds": [priya]})),
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let grounding: Uuid = body["group"]["conversationId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let plain = crate::chat_sync::store::create_conversation(
        &pool,
        &alex,
        CreateConversationRequest {
            client_operation_id: Uuid::new_v4(),
            kind: ConversationKind::Group,
            shared_title: Some("Plain".to_string()),
            client_session_id: format!("session:group:{}", Uuid::new_v4()),
            member_account_ids: vec![priya.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    assert_eq!(plain.origin, None);
    assert!(serde_json::to_value(&plain)
        .unwrap()
        .get("origin")
        .is_none());

    let snapshot = crate::chat_sync::store::bootstrap(&pool, &priya)
        .await
        .unwrap();
    let origin = |id: Uuid| {
        snapshot
            .conversations
            .iter()
            .find(|conversation| conversation.id == id)
            .expect("the group is in the member's snapshot")
            .origin
            .clone()
    };
    assert_eq!(origin(grounding).as_deref(), Some("grounding"));
    assert_eq!(origin(plain.id), None);

    // System joins after the group is recorded, so the update every member's
    // device receives carries the origin.
    let (payload,): (Value,) = query_as(
        "SELECT payload FROM cloud_chat_user_sync_events
         WHERE account_id = $1 AND event_type = 'membership.updated' AND conversation_id = $2
         ORDER BY stream_seq DESC LIMIT 1",
    )
    .bind(&priya)
    .bind(grounding)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(payload["conversation"]["origin"], "grounding");
}
