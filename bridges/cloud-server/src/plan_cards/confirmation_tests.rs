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
async fn represented_confirm_and_cancel_require_provenance_and_manager_authority() {
    let pool = sqlx_postgres::PgPoolOptions::new()
        .connect(
            &std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated database required"),
        )
        .await
        .unwrap();
    crate::pg::pool::apply_migrations(&pool).await.unwrap();
    let owner = format!("represented-owner-{}", Uuid::new_v4().simple());
    let peer = format!("represented-peer-{}", Uuid::new_v4().simple());
    for account in [&owner, &peer] {
        seed_account(&pool, account).await;
    }
    let conversation = Uuid::new_v4();
    seed_conversation(&pool, conversation, &owner, &[&owner, &peer]).await;
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
    let request = |confirmed_by: &str| {
        serde_json::from_value(json!({
            "action":"confirm",
            "eventId":scheduled.event_id,
            "revision":scheduled.revision,
            "confirmedBy":confirmed_by
        }))
        .unwrap()
    };
    let actor = |represented_accounts| super::routes::Actor {
        account_id: "pip-service".to_string(),
        on_behalf_of_conversation: Some(conversation),
        represented_accounts,
    };

    let missing_provenance = super::routes::dispatch_row(
        &pool,
        &actor(std::collections::BTreeSet::new()),
        request(&owner),
    )
    .await
    .unwrap_err();
    assert_eq!(missing_provenance.status(), 403);

    let non_manager = super::routes::dispatch_row(
        &pool,
        &actor(std::collections::BTreeSet::from([peer.clone()])),
        request(&peer),
    )
    .await
    .unwrap_err();
    assert_eq!(non_manager.status(), 403);

    let confirmed = super::routes::dispatch_row(
        &pool,
        &actor(std::collections::BTreeSet::from([owner.clone()])),
        request(&owner),
    )
    .await
    .unwrap();
    let cancel = |canceled_by: &str| {
        serde_json::from_value(json!({
            "action":"cancel",
            "eventId":confirmed.event_id,
            "revision":confirmed.revision,
            "canceledBy":canceled_by
        }))
        .unwrap()
    };
    let non_manager = super::routes::dispatch_row(
        &pool,
        &actor(std::collections::BTreeSet::from([peer.clone()])),
        cancel(&peer),
    )
    .await
    .unwrap_err();
    assert_eq!(non_manager.status(), 403);
    let canceled = super::routes::dispatch_row(
        &pool,
        &actor(std::collections::BTreeSet::from([owner.clone()])),
        cancel(&owner),
    )
    .await
    .unwrap();
    assert_eq!(canceled.state, PlanCardState::Canceled);
}
