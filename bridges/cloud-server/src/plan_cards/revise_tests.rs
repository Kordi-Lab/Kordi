//! Revising a card against a real database keeps what members already said.

use super::models::{
    PlanCardOption, PlanCardProposeArgs, PlanCardRow, PlanCardRsvp, PlanCardState,
};
use super::store;
use super::tests::{participant, seed_account, seed_conversation};
use uuid::Uuid;

fn option(id: &str, label: &str, start_at: &str) -> PlanCardOption {
    PlanCardOption {
        id: id.to_string(),
        label: label.to_string(),
        start_at: Some(start_at.to_string()),
        end_at: None,
        location: None,
        votes: Vec::new(),
    }
}

fn rsvp_of(row: &PlanCardRow, account_id: &str) -> PlanCardRsvp {
    row.participants
        .iter()
        .find(|participant| participant.account_id == account_id)
        .map(|participant| participant.rsvp)
        .expect("participant on the card")
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn revising_a_card_keeps_votes_and_answers_that_still_apply() {
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
    let (jordan, maya, riya) = (
        format!("jordan-{suffix}"),
        format!("maya-{suffix}"),
        format!("riya-{suffix}"),
    );
    for account in [&jordan, &maya, &riya] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &jordan, &[&jordan, &maya, &riya]).await;
    let friday = (chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339();
    let saturday = (chrono::Utc::now() + chrono::Duration::days(4)).to_rfc3339();
    let everyone = || {
        vec![
            participant(&jordan, "Jordan", true),
            participant(&maya, "Maya", false),
            participant(&riya, "Riya", false),
        ]
    };
    let poll = |existing: Option<&PlanCardRow>, options: Vec<PlanCardOption>| PlanCardProposeArgs {
        conversation_id: chat,
        existing_event_id: existing.map(|row| row.event_id.clone()),
        existing_revision: existing.map(|row| row.revision),
        title: "Dinner".to_string(),
        start_at: None,
        end_at: None,
        location: None,
        state: PlanCardState::Polling,
        unresolved_fields: Vec::new(),
        participants: everyone(),
        source_message_ids: Vec::new(),
        options,
    };

    let card = store::propose(
        &pool,
        &jordan,
        poll(
            None,
            vec![
                option("opt_1", "Friday", &friday),
                option("opt_2", "Saturday", &saturday),
            ],
        ),
    )
    .await
    .expect("open the poll");
    store::vote(&pool, &card.event_id, &maya, "opt_1")
        .await
        .unwrap();
    store::vote(&pool, &card.event_id, &riya, "opt_2")
        .await
        .unwrap();
    let card = store::rsvp(&pool, &card.event_id, &riya, PlanCardRsvp::Yes, None)
        .await
        .unwrap();

    // PiP adds a third option at the front: every option id shifts.
    let sunday = (chrono::Utc::now() + chrono::Duration::days(5)).to_rfc3339();
    let revised = store::propose(
        &pool,
        &jordan,
        poll(
            Some(&card),
            vec![
                option("opt_1", "Sunday", &sunday),
                option("opt_2", "Friday", &friday),
                option("opt_3", "Saturday", &saturday),
            ],
        ),
    )
    .await
    .expect("revise the poll");
    let votes: Vec<Vec<String>> = revised
        .options
        .iter()
        .map(|option| option.votes.clone())
        .collect();
    assert_eq!(
        votes,
        vec![Vec::<String>::new(), vec![maya.clone()], vec![riya.clone()]]
    );
    assert_eq!(rsvp_of(&revised, &riya), PlanCardRsvp::Yes);
    assert_eq!(rsvp_of(&revised, &jordan), PlanCardRsvp::Yes);

    // Settling on a time is a different plan from the poll: answers start over.
    let settled = store::propose(
        &pool,
        &jordan,
        PlanCardProposeArgs {
            start_at: Some(friday.clone()),
            state: PlanCardState::AwaitingConfirmation,
            options: Vec::new(),
            ..poll(Some(&revised), Vec::new())
        },
    )
    .await
    .expect("settle the plan");
    assert_eq!(rsvp_of(&settled, &riya), PlanCardRsvp::Pending);
    assert_eq!(rsvp_of(&settled, &jordan), PlanCardRsvp::Yes);
}
