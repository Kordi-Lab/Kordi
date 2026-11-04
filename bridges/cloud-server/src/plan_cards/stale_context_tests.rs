//! Historical chat instructions must not undo a newer organizer decision.
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::http_tests::{seed_account, seed_conversation};
use super::models::{PlanCardProposeArgs, PlanCardRsvp, PlanCardState};
use super::routes::{dispatch_row, Actor};
use super::tests::participant;

async fn message(pool: &PgPool, conversation: Uuid, sender: &str) -> String {
    // Server-assigned time and canonical ID, as in a real incoming chat message.
    let (id,): (String,) = query_as(
        "INSERT INTO cloud_chat_messages
         (message_id, conversation_id, conversation_sequence, sender_account_id,
          client_message_id, request_fingerprint, message_kind, content)
         VALUES ($1, $2, (SELECT COALESCE(MAX(conversation_sequence), 0) + 1
                          FROM cloud_chat_messages WHERE conversation_id = $2),
                 $3, $4, 'stale-plan-test', 'text', '{}') RETURNING message_id::text",
    )
    .bind(Uuid::new_v4())
    .bind(conversation)
    .bind(sender)
    .bind(Uuid::new_v4())
    .fetch_one(pool)
    .await
    .unwrap();
    id
}

async fn calendars(pool: &PgPool, event_id: &str) -> Vec<(String, Value)> {
    super::projection::drain(pool, 100).await.unwrap();
    query_as("SELECT account_id, payload FROM cloud_calendar_events WHERE event_id = $1 ORDER BY account_id")
        .bind(format!("plan:{event_id}")).fetch_all(pool).await.unwrap()
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn stale_chat_cannot_reopen_newer_confirmation_or_remove_calendars() {
    let pool = PgPool::connect(&std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    crate::pg::pool::apply_migrations(&pool).await.unwrap();
    let suffix = Uuid::new_v4();
    let owner = format!("owner-{suffix}");
    let guest = format!("guest-{suffix}");
    let system = format!("system-{suffix}");
    for id in [&owner, &guest, &system] {
        seed_account(&pool, id).await;
    }
    let conversation = Uuid::new_v4();
    seed_conversation(&pool, conversation, &owner, &[&owner, &guest, &system]).await;
    let args = |event_id, revision, days| PlanCardProposeArgs {
        conversation_id: conversation,
        existing_event_id: event_id,
        existing_revision: revision,
        title: "Dinner".into(),
        start_at: Some((chrono::Utc::now() + chrono::Duration::days(days)).to_rfc3339()),
        end_at: None,
        location: None,
        state: PlanCardState::AwaitingConfirmation,
        unresolved_fields: vec![],
        source_message_ids: vec![],
        options: vec![],
        participants: vec![
            participant(&owner, "Owner", true),
            participant(&guest, "Guest", false),
        ],
    };
    let initial = super::store::propose(&pool, &system, args(None, None, 2))
        .await
        .unwrap();
    let old_message = message(&pool, conversation, &owner).await;
    // The organizer supersedes that chat request using the authorized controls.
    let revised = super::store::propose(
        &pool,
        &owner,
        args(Some(initial.event_id.clone()), Some(initial.revision), 3),
    )
    .await
    .unwrap();
    let attending = super::store::rsvp(&pool, &revised.event_id, &guest, PlanCardRsvp::Yes, None)
        .await
        .unwrap();
    let confirmed = super::store::confirm(
        &pool,
        &revised.event_id,
        attending.revision,
        &owner,
        None,
        None,
    )
    .await
    .unwrap();
    let saved = calendars(&pool, &confirmed.event_id).await;
    assert_eq!(saved.len(), 2);
    let actor = |ids| Actor {
        account_id: system.clone(),
        on_behalf_of_conversation: Some(conversation),
        represented_accounts: [owner.clone()].into_iter().collect(),
        source_message_ids: ids,
    };
    let replace = |revision| {
        serde_json::from_value(json!({
            "action": "propose", "conversationId": conversation,
            "existingEventId": confirmed.event_id, "existingRevision": revision,
            "title": "Dinner", "state": "awaitingConfirmation",
            "startAt": (chrono::Utc::now() + chrono::Duration::days(4)).to_rfc3339(),
            "participants": [
                {"participantId": owner, "displayName": "Owner", "organizer": true},
                {"participantId": guest, "displayName": "Guest"}
            ]
        }))
        .unwrap()
    };
    // A delayed run with an old revision is rejected by optimistic concurrency.
    let stale = dispatch_row(
        &pool,
        &actor(vec![old_message.clone()]),
        replace(initial.revision),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.status(), 409);
    // Even learning the latest revision cannot revive the superseded request.
    // No new message (a card_changed/reminder sweep) is not authorization either.
    for ids in [vec![old_message], vec![], vec![Uuid::new_v4().to_string()]] {
        let rejected = dispatch_row(&pool, &actor(ids), replace(confirmed.revision)).await;
        assert!(
            rejected.is_err(),
            "old context must not reopen a newer confirmed plan"
        );
        assert_eq!(rejected.unwrap_err().status(), 409);
        let current = super::store::load(&pool, &confirmed.event_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(&current).unwrap(),
            serde_json::to_value(&confirmed).unwrap()
        );
        assert_eq!(calendars(&pool, &confirmed.event_id).await, saved);
    }
    // New IDs still need valid human provenance in this conversation.
    let system_message = message(&pool, conversation, &system).await;
    let deleted = message(&pool, conversation, &owner).await;
    sqlx_core::query::query(
        "UPDATE cloud_chat_messages SET deleted_at = now() WHERE message_id::text = $1",
    )
    .bind(&deleted)
    .execute(&pool)
    .await
    .unwrap();
    let other_conversation = Uuid::new_v4();
    seed_conversation(&pool, other_conversation, &owner, &[&owner]).await;
    let other_message = message(&pool, other_conversation, &owner).await;
    for id in [system_message, deleted, other_message] {
        let rejected = dispatch_row(&pool, &actor(vec![id]), replace(confirmed.revision))
            .await
            .unwrap_err();
        assert_eq!(rejected.status(), 409);
        assert_eq!(calendars(&pool, &confirmed.event_id).await, saved);
    }
    // A genuinely later request atomically replaces the confirmed plan.
    let fresh = message(&pool, conversation, &owner).await;
    let changed = dispatch_row(&pool, &actor(vec![fresh]), replace(confirmed.revision))
        .await
        .unwrap();
    assert_eq!(changed.revision, confirmed.revision + 1);
    assert_eq!(changed.state, PlanCardState::AwaitingConfirmation);
    assert_eq!(
        changed
            .participants
            .iter()
            .find(|p| p.account_id == guest)
            .unwrap()
            .rsvp,
        PlanCardRsvp::Pending
    );
    assert_ne!(changed.start_at, confirmed.start_at);
    let attending = super::store::rsvp(&pool, &changed.event_id, &guest, PlanCardRsvp::Yes, None)
        .await
        .unwrap();
    let later = super::store::confirm(
        &pool,
        &changed.event_id,
        attending.revision,
        &owner,
        None,
        None,
    )
    .await
    .unwrap();
    let updated = calendars(&pool, &later.event_id).await;
    assert_eq!(updated.len(), 2);
    assert!(updated
        .iter()
        .all(|(_, payload)| payload["startAt"] == json!(later.start_at)));
}
