//! Rescheduling must not commit an obsolete intermediate card or projection.
use super::{models::PlanCardState, routes::Actor, store, tests::*, wire::Request};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

async fn message(pool: &sqlx_postgres::PgPool, conversation: Uuid, sender: &str) -> String {
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

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn system_replaces_confirmed_plan_atomically_and_recovers_from_rejection() {
    let pool = sqlx_postgres::PgPoolOptions::new()
        .connect(&std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    crate::pg::pool::apply_migrations(&pool).await.unwrap();
    let suffix = Uuid::new_v4();
    let owner = format!("organizer-{suffix}");
    let guest = format!("guest-{suffix}");
    let other = format!("other-{suffix}");
    let agent = format!("system-{suffix}");
    for id in [&owner, &guest, &other, &agent] {
        seed_account(&pool, id).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &owner, &[&owner, &guest, &other, &agent]).await;
    let mut actor = Actor {
        account_id: agent.clone(),
        on_behalf_of_conversation: Some(chat),
        represented_accounts: std::collections::BTreeSet::from([owner.clone()]),
        source_message_ids: Vec::new(),
    };
    let now =
        chrono::DateTime::from_timestamp_micros(chrono::Utc::now().timestamp_micros()).unwrap();
    let at = |days, hours| {
        (now + chrono::Duration::days(days) + chrono::Duration::hours(hours)).to_rfc3339()
    };
    let proposal = json!({
        "action":"propose", "conversationId": chat, "title":"Synthetic lunch",
        "state":"awaitingConfirmation", "startAt":at(2,0), "endAt":at(2,1),
        "location":"Cafe A", "participants":[
            {"participantId":owner,"displayName":"Organizer","organizer":true},
            {"participantId":guest,"displayName":"Guest"},
            {"participantId":other,"displayName":"Other"}
        ]
    });
    let request = |v: Value| serde_json::from_value::<Request>(v).unwrap();
    let row = super::routes::dispatch_row(&pool, &actor, request(proposal.clone()))
        .await
        .unwrap_or_else(|_| panic!("initial proposal"));
    for id in [&guest, &other] {
        store::rsvp(
            &pool,
            &row.event_id,
            id,
            super::models::PlanCardRsvp::Yes,
            None,
        )
        .await
        .unwrap();
    }
    let current = store::load(&pool, &row.event_id).await.unwrap().unwrap();
    let confirmed = store::confirm(&pool, &row.event_id, current.revision, &owner, None, None)
        .await
        .unwrap();
    let project = |card: super::models::PlanCardRow| {
        let pool = pool.clone();
        async move {
            let mut tx = pool.begin().await.unwrap();
            super::calendar::sync_plan(&mut tx, &card).await.unwrap();
            tx.commit().await.unwrap();
        }
    };
    project(confirmed.clone()).await;
    let calendar_id = format!("plan:{}", row.event_id);
    let entries = || {
        let pool = pool.clone();
        let id = calendar_id.clone();
        async move {
            query_as::<_, (String, Value)>("SELECT account_id,payload FROM cloud_calendar_events WHERE event_id=$1 ORDER BY account_id")
            .bind(id).fetch_all(&pool).await.unwrap()
        }
    };
    let before = entries().await;
    assert_eq!(before.len(), 3);
    let mut replacement = proposal;
    replacement["existingEventId"] = json!(row.event_id);
    replacement["existingRevision"] = json!(confirmed.revision);
    replacement["startAt"] = json!(at(3, 3));
    replacement["endAt"] = json!(at(3, 4));
    replacement["location"] = json!("Garden B");

    let member_actor = Actor {
        account_id: owner.clone(),
        on_behalf_of_conversation: None,
        represented_accounts: Default::default(),
        source_message_ids: Vec::new(),
    };
    assert_eq!(
        super::routes::dispatch_row(&pool, &member_actor, request(replacement.clone()))
            .await
            .err()
            .unwrap()
            .status(),
        409,
        "ordinary member updates still require an open card"
    );
    let foreign_actor = Actor {
        account_id: agent.clone(),
        on_behalf_of_conversation: Some(Uuid::new_v4()),
        represented_accounts: Default::default(),
        source_message_ids: Vec::new(),
    };
    assert_eq!(
        super::routes::dispatch_row(&pool, &foreign_actor, request(replacement.clone()))
            .await
            .err()
            .unwrap()
            .status(),
        403,
        "a run cannot replace another conversation's plan"
    );

    let rejected = super::routes::dispatch_row(&pool, &actor, request(replacement.clone()))
        .await
        .err()
        .unwrap();
    assert_eq!(
        rejected.status(),
        409,
        "no fresh instruction must not reopen a confirmed plan"
    );
    actor.source_message_ids = vec![message(&pool, chat, &owner).await];

    // Reusing the old end after moving the start must give a recoverable error,
    // with neither a reopened card nor a changed projection committed.
    let mut invalid = replacement.clone();
    invalid["endAt"] = json!(at(2, 1));
    let rejected = super::routes::dispatch_row(&pool, &actor, request(invalid))
        .await
        .err()
        .unwrap();
    assert_eq!(rejected.status(), 400);
    let body = axum::body::to_bytes(rejected.into_body(), usize::MAX)
        .await
        .unwrap();
    let error: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(error["errorCode"], "invalid_time_range");
    let unchanged = store::load(&pool, &row.event_id).await.unwrap().unwrap();
    assert_eq!(unchanged.revision, confirmed.revision);
    assert_eq!(unchanged.state, PlanCardState::Confirmed);
    assert_eq!(unchanged.start_at, confirmed.start_at);
    assert_eq!(unchanged.location, confirmed.location);
    assert_eq!(entries().await, before);

    // A failure inside the write transaction must roll back as well, not only
    // requests rejected by wire validation.
    let Request::Propose(valid) = request(replacement.clone()) else {
        unreachable!()
    };
    let mut invalid_store_args = valid
        .into_args(Some(chat))
        .unwrap_or_else(|_| panic!("valid replacement"));
    invalid_store_args.end_at = Some(at(2, 1));
    assert!(store::propose_for_system_agent(
        &pool,
        &agent,
        invalid_store_args,
        &actor.source_message_ids
    )
    .await
    .is_err());
    let unchanged = store::load(&pool, &row.event_id).await.unwrap().unwrap();
    assert_eq!(unchanged.revision, confirmed.revision);
    assert_eq!(unchanged.state, PlanCardState::Confirmed);
    assert_eq!(entries().await, before);
    let queued: (i64,) =
        query_as("SELECT target_revision FROM cloud_plan_card_projection_queue WHERE event_id=$1")
            .bind(&row.event_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(queued.0, confirmed.revision);

    let revised = super::routes::dispatch_row(&pool, &actor, request(replacement.clone()))
        .await
        .unwrap_or_else(|_| panic!("confirmed replacement must be atomic"));
    assert_eq!(revised.event_id, confirmed.event_id);
    assert_eq!(revised.revision, confirmed.revision + 1);
    assert_eq!(revised.state, PlanCardState::AwaitingConfirmation);
    assert_eq!(revised.start_at, Some(at(3, 3)));
    assert_eq!(revised.end_at, Some(at(3, 4)));
    assert_eq!(revised.location.as_deref(), Some("Garden B"));
    assert!(revised
        .participants
        .iter()
        .filter(|p| !p.organizer)
        .all(|p| p.rsvp == super::models::PlanCardRsvp::Pending));
    project(revised.clone()).await;
    assert!(entries().await.is_empty());

    let stale = super::routes::dispatch_row(&pool, &actor, request(replacement.clone()))
        .await
        .err()
        .unwrap();
    assert_eq!(stale.status(), 409);
    for id in [&guest, &other] {
        store::rsvp(
            &pool,
            &row.event_id,
            id,
            super::models::PlanCardRsvp::Yes,
            None,
        )
        .await
        .unwrap();
    }
    let current = store::load(&pool, &row.event_id).await.unwrap().unwrap();
    let confirmed = store::confirm(&pool, &row.event_id, current.revision, &owner, None, None)
        .await
        .unwrap();
    project(confirmed.clone()).await;
    project(confirmed.clone()).await;
    let after = entries().await;
    assert_eq!(after.len(), 3);
    for (_, payload) in &after {
        assert_eq!(payload["startAt"], json!(at(3, 3)));
        assert_eq!(payload["endAt"], json!(at(3, 4)));
        assert!(payload["description"]
            .as_str()
            .unwrap()
            .contains("Garden B"));
    }
    let count: (i64,) = query_as("SELECT count(*) FROM cloud_plan_cards WHERE conversation_id=$1")
        .bind(chat)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count.0, 1);
    // The replacement message is now older than the new confirmation. Even
    // supplying the latest revision cannot authorize replaying it.
    replacement["existingRevision"] = json!(confirmed.revision);
    assert_eq!(
        super::routes::dispatch_row(&pool, &actor, request(replacement.clone()))
            .await
            .err()
            .unwrap()
            .status(),
        409
    );
    assert_eq!(
        store::load(&pool, &row.event_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        PlanCardState::Confirmed
    );
    assert_eq!(entries().await, after);

    let canceled = store::cancel(&pool, &row.event_id, confirmed.revision, &owner, None)
        .await
        .unwrap();
    replacement["existingRevision"] = json!(canceled.revision);
    assert_eq!(
        super::routes::dispatch_row(&pool, &actor, request(replacement))
            .await
            .err()
            .unwrap()
            .status(),
        409
    );
}
