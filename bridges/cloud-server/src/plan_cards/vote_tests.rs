//! Votes, confirmation by option, and who may be on or act on a card.

use super::models::{PlanCardOption, PlanCardProposeArgs, PlanCardRsvp, PlanCardState};
use super::store;
use super::tests::{participant, seed_account, seed_conversation};
use uuid::Uuid;

async fn test_pool() -> sqlx_postgres::PgPool {
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
    pool
}

fn lunch(
    conversation_id: Uuid,
    participants: Vec<super::models::PlanCardParticipantInput>,
) -> PlanCardProposeArgs {
    PlanCardProposeArgs {
        conversation_id,
        existing_event_id: None,
        existing_revision: None,
        title: "Lunch".to_string(),
        start_at: None,
        end_at: None,
        location: None,
        state: PlanCardState::AwaitingConfirmation,
        unresolved_fields: Vec::new(),
        participants,
        source_message_ids: Vec::new(),
        options: Vec::new(),
    }
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn only_members_can_be_on_a_card_and_runs_stay_in_their_chat() {
    let pool = test_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (jordan, maya, outsider) = (
        format!("jordan-{suffix}"),
        format!("maya-{suffix}"),
        format!("outsider-{suffix}"),
    );
    for account in [&jordan, &maya, &outsider] {
        seed_account(&pool, account).await;
    }
    let (home, other) = (Uuid::new_v4(), Uuid::new_v4());
    seed_conversation(&pool, home, &jordan, &[&jordan, &maya]).await;
    seed_conversation(&pool, other, &jordan, &[&jordan, &maya]).await;

    let with_outsider = lunch(
        home,
        vec![
            participant(&jordan, "Jordan", true),
            participant(&outsider, "Outsider", false),
        ],
    );
    assert!(matches!(
        store::propose(&pool, &jordan, with_outsider).await,
        Err(super::models::PlanCardStoreError::ParticipantNotMember)
    ));

    let elsewhere = store::propose(
        &pool,
        &jordan,
        lunch(
            other,
            vec![
                participant(&jordan, "Jordan", true),
                participant(&maya, "Maya", false),
            ],
        ),
    )
    .await
    .expect("propose in the other chat");
    let run = super::routes::Actor {
        account_id: jordan.clone(),
        on_behalf_of_conversation: Some(home),
        represented_accounts: std::collections::BTreeSet::from([maya.clone()]),
    };
    let cancel: super::wire::Request = serde_json::from_value(serde_json::json!({
        "action": "cancel", "eventId": elsewhere.event_id,
        "revision": elsewhere.revision, "canceledBy": maya,
    }))
    .unwrap();
    let rejected = super::routes::dispatch_row(&pool, &run, cancel)
        .await
        .err()
        .unwrap();
    assert_eq!(rejected.status(), axum::http::StatusCode::FORBIDDEN);
    let unchanged = store::load(&pool, &elsewhere.event_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.state, PlanCardState::AwaitingConfirmation);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn confirm_with_option_marks_voters_attending() {
    let pool = test_pool().await;

    let suffix = Uuid::new_v4().simple().to_string();
    let jordan = format!("jordan-{suffix}");
    let maya = format!("maya-{suffix}");
    let riya = format!("riya-{suffix}");
    let sam = format!("sam-{suffix}");
    for account in [&jordan, &maya, &riya, &sam] {
        seed_account(&pool, account).await;
    }
    let conversation_id = Uuid::new_v4();
    seed_conversation(
        &pool,
        conversation_id,
        &jordan,
        &[&jordan, &maya, &riya, &sam],
    )
    .await;

    let proposed = store::propose(
        &pool,
        &jordan,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: None,
            existing_revision: None,
            title: "Saturday or Sunday?".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            state: PlanCardState::Polling,
            unresolved_fields: vec!["startAt".to_string()],
            participants: vec![
                participant(&jordan, "Jordan", true),
                participant(&maya, "Maya", false),
                participant(&riya, "Riya", false),
                participant(&sam, "Sam", false),
            ],
            source_message_ids: vec!["msg_1".to_string()],
            options: vec![
                PlanCardOption {
                    id: "opt_a".to_string(),
                    label: "Saturday".to_string(),
                    start_at: Some("2026-07-04T18:00:00-07:00".to_string()),
                    end_at: None,
                    location: Some("Riya's place".to_string()),
                    votes: Vec::new(),
                },
                PlanCardOption {
                    id: "opt_b".to_string(),
                    label: "Sunday".to_string(),
                    start_at: Some("2026-07-05T18:00:00-07:00".to_string()),
                    end_at: None,
                    location: Some("Riya's place".to_string()),
                    votes: Vec::new(),
                },
            ],
        },
    )
    .await
    .expect("propose succeeds");

    // Riya declines outright before the vote settles...
    let declined = store::rsvp(
        &pool,
        &proposed.event_id,
        &riya,
        PlanCardRsvp::No,
        Some("can't make either day"),
    )
    .await
    .expect("rsvp succeeds");

    // ...but still votes, since a vote and an RSVP are independent answers.
    store::vote(&pool, &declined.event_id, &maya, "opt_a")
        .await
        .expect("maya votes");
    let voted = store::vote(&pool, &declined.event_id, &riya, "opt_a")
        .await
        .expect("riya votes");

    let confirmed = store::confirm(
        &pool,
        &voted.event_id,
        voted.revision,
        &jordan,
        Some("opt_a"),
        None,
    )
    .await
    .expect("confirm with an option succeeds");
    assert!(matches!(confirmed.state, PlanCardState::Confirmed));
    assert_eq!(
        confirmed.location.as_deref(),
        Some("Riya's place"),
        "the chosen option's location becomes the card's own"
    );

    let rsvp_of = |account_id: &str| {
        confirmed
            .participants
            .iter()
            .find(|p| p.account_id == account_id)
            .unwrap()
            .rsvp
    };
    assert!(
        matches!(rsvp_of(&maya), PlanCardRsvp::Yes),
        "a pending voter for the winning option is marked attending"
    );
    assert!(
        matches!(rsvp_of(&riya), PlanCardRsvp::No),
        "an explicit no is never upgraded by a vote for the winning option"
    );
    assert!(
        matches!(rsvp_of(&sam), PlanCardRsvp::Pending),
        "a member who never voted is left pending"
    );
    assert!(
        matches!(rsvp_of(&jordan), PlanCardRsvp::Yes),
        "the organizer was already yes and stays yes"
    );
}
