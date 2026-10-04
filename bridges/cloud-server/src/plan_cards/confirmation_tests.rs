use super::models::{PlanCardProposeArgs, PlanCardState};
use super::tests::{participant, seed_account, seed_conversation};
use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn calendar_requires_a_time_and_the_viewers_own_rsvp() {
    let pool = sqlx_postgres::PgPoolOptions::new()
        .connect(
            &std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated database required"),
        )
        .await
        .unwrap();
    crate::pg::pool::apply_migrations(&pool).await.unwrap();
    let owner = format!("owner-{}", Uuid::new_v4().simple());
    let peer = format!("peer-{}", Uuid::new_v4().simple());
    for account in [&owner, &peer] {
        seed_account(&pool, account).await;
    }
    let conversation = Uuid::new_v4();
    seed_conversation(&pool, conversation, &owner, &[&owner, &peer]).await;
    query("UPDATE cloud_chat_conversation_members SET role='admin' WHERE conversation_id=$1 AND account_id=$2")
        .bind(conversation).bind(&peer).execute(&pool).await.unwrap();
    let args = |existing: Option<&super::models::PlanCardRow>, start_at| PlanCardProposeArgs {
        conversation_id: conversation,
        existing_event_id: existing.map(|r| r.event_id.clone()),
        existing_revision: existing.map(|r| r.revision),
        title: "Dinner".into(),
        start_at,
        end_at: None,
        location: None,
        state: PlanCardState::AwaitingConfirmation,
        unresolved_fields: vec![],
        source_message_ids: vec![],
        options: vec![],
        participants: vec![
            participant(&owner, "Owner", true),
            participant(&peer, "Peer", false),
        ],
    };
    let initial = super::store::propose(&pool, &owner, args(None, None))
        .await
        .unwrap();
    let actor = super::routes::Actor {
        account_id: peer.clone(),
        on_behalf_of_conversation: None,
        represented_accounts: std::collections::BTreeSet::new(),
    };
    let confirm = |row: &super::models::PlanCardRow| {
        serde_json::from_value(json!({
            "action":"confirm","eventId":row.event_id,"revision":row.revision,"confirmedBy":peer
        }))
        .unwrap()
    };
    let error = super::routes::dispatch_row(&pool, &actor, confirm(&initial))
        .await
        .unwrap_err();
    assert_eq!(error.status(), 409);
    let unchanged = super::store::load(&pool, &initial.event_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.revision, initial.revision);
    assert!(matches!(
        unchanged.state,
        PlanCardState::AwaitingConfirmation
    ));
    let time = (chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    let scheduled = super::store::propose(&pool, &owner, args(Some(&initial), Some(time)))
        .await
        .unwrap();
    // The organizer answers for themselves; nobody is marked attending for them.
    let scheduled = super::store::rsvp(
        &pool,
        &scheduled.event_id,
        &owner,
        super::models::PlanCardRsvp::Yes,
        None,
    )
    .await
    .unwrap();
    let confirmed = super::routes::dispatch_row(&pool, &actor, confirm(&scheduled))
        .await
        .unwrap();
    let projected = super::projection::drain(&pool, 10).await.unwrap();
    assert!(projected.is_complete());
    let event = format!("plan:{}", confirmed.event_id);
    let (owner_count,): (i64,) =
        query_as("SELECT count(*) FROM cloud_calendar_events WHERE event_id=$1 AND account_id=$2")
            .bind(&event)
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    let (peer_count,): (i64,) =
        query_as("SELECT count(*) FROM cloud_calendar_events WHERE event_id=$1 AND account_id=$2")
            .bind(&event)
            .bind(&peer)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner_count, 1);
    assert_eq!(
        peer_count, 0,
        "confirm does not silently mark another member as attending"
    );
    let peer_actor = super::routes::Actor {
        account_id: peer.clone(),
        on_behalf_of_conversation: None,
        represented_accounts: std::collections::BTreeSet::new(),
    };
    let request = serde_json::from_value(
        json!({"action":"rsvp","eventId":confirmed.event_id,"participantId":peer,"rsvp":"yes"}),
    )
    .unwrap();
    super::routes::dispatch_row(&pool, &peer_actor, request)
        .await
        .unwrap();
    let projected = super::projection::drain(&pool, 10).await.unwrap();
    assert!(projected.is_complete());
    let (peer_count,): (i64,) =
        query_as("SELECT count(*) FROM cloud_calendar_events WHERE event_id=$1 AND account_id=$2")
            .bind(&event)
            .bind(&peer)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(peer_count, 1);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn pip_confirm_and_cancel_are_only_suggestions_for_plan_managers() {
    let pool = sqlx_postgres::PgPoolOptions::new()
        .connect(
            &std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated database required"),
        )
        .await
        .unwrap();
    crate::pg::pool::apply_migrations(&pool).await.unwrap();
    let owner = format!("represented-owner-{}", Uuid::new_v4().simple());
    let peer = format!("represented-peer-{}", Uuid::new_v4().simple());
    let pip = format!("represented-pip-{}", Uuid::new_v4().simple());
    for account in [&owner, &peer, &pip] {
        seed_account(&pool, account).await;
    }
    let conversation = Uuid::new_v4();
    seed_conversation(&pool, conversation, &owner, &[&owner, &peer, &pip]).await;
    let scheduled = super::store::propose(
        &pool,
        &owner,
        PlanCardProposeArgs {
            conversation_id: conversation,
            existing_event_id: None,
            existing_revision: None,
            title: "Represented dinner".into(),
            start_at: Some((chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339()),
            end_at: None,
            location: None,
            state: PlanCardState::AwaitingConfirmation,
            unresolved_fields: vec![],
            source_message_ids: vec![],
            options: vec![],
            participants: vec![
                participant(&owner, "Owner", true),
                participant(&peer, "Peer", false),
            ],
        },
    )
    .await
    .unwrap();
    let actor = super::routes::Actor {
        account_id: pip.clone(),
        on_behalf_of_conversation: Some(conversation),
        represented_accounts: std::collections::BTreeSet::from([owner.clone()]),
    };
    let decision = |action: &str, by_key: &str| {
        let mut request = json!({
            "action": action,
            "eventId": scheduled.event_id,
            "revision": scheduled.revision,
        });
        request[by_key] = json!(owner);
        serde_json::from_value(request).unwrap()
    };
    for (action, by_key) in [("confirm", "confirmedBy"), ("cancel", "canceledBy")] {
        let outcome = super::routes::dispatch(&pool, &actor, decision(action, by_key))
            .await
            .unwrap_or_else(|_| panic!("{action} suggestion"));
        let super::suggestions::Dispatched::Suggested { row, awaiting, .. } = outcome else {
            panic!("PiP's {action} must not change the card");
        };
        assert_eq!(awaiting, "organizer_or_admin");
        assert_eq!(row.revision, scheduled.revision);
        assert_eq!(row.state, PlanCardState::AwaitingConfirmation);
    }
    // The newer decision replaces the older one: one pending decision per card.
    let pending: Vec<(String, Option<String>, i64)> = query_as(
        "SELECT kind, approver_account_id, (subject->>'revision')::bigint
         FROM cloud_agent_pending_actions WHERE event_id = $1 AND status = 'pending'",
    )
    .bind(&scheduled.event_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        pending,
        vec![("plan_cancel".to_string(), None, scheduled.revision)]
    );
    let unchanged = super::store::load(&pool, &scheduled.event_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.revision, scheduled.revision);
    assert_eq!(unchanged.state, PlanCardState::AwaitingConfirmation);
}
