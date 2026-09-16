use super::models::{PlanCardParticipantInput, PlanCardProposeArgs, PlanCardRsvp, PlanCardState};
use super::store;
use sqlx_core::query::query;
use uuid::Uuid;

async fn seed_account(pool: &sqlx_postgres::PgPool, account_id: &str) {
    query("INSERT INTO cloud_accounts(account_id,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at,avatar_url) VALUES($1,$2,$2,'generated','lorelei',$1,'test',1,$2,$3)")
        .bind(account_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(crate::avatars::generated_avatar_marker("lorelei", account_id, 1))
        .execute(pool)
        .await
        .unwrap();
}

async fn seed_conversation(
    pool: &sqlx_postgres::PgPool,
    conversation_id: Uuid,
    created_by: &str,
    members: &[&str],
) {
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint) VALUES($1,'group',$2,$3,'test')")
        .bind(conversation_id)
        .bind(created_by)
        .bind(Uuid::new_v4())
        .execute(pool)
        .await
        .unwrap();
    for member in members {
        query(
            "INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,$2)",
        )
        .bind(conversation_id)
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    }
}

fn participant(account_id: &str, display_name: &str, organizer: bool) -> PlanCardParticipantInput {
    PlanCardParticipantInput {
        account_id: account_id.to_string(),
        display_name: display_name.to_string(),
        organizer,
    }
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn full_lifecycle_against_real_postgres() {
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
    let outsider = format!("outsider-{suffix}");
    for account in [&jordan, &maya, &riya, &outsider] {
        seed_account(&pool, account).await;
    }
    let conversation_id = Uuid::new_v4();
    seed_conversation(&pool, conversation_id, &jordan, &[&jordan, &maya, &riya]).await;

    // Propose: a polling card while agreement is still unclear.
    let proposed = store::propose(
        &pool,
        &jordan,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: None,
            existing_revision: None,
            title: "Lunch this weekend?".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            state: PlanCardState::Polling,
            unresolved_fields: vec!["startAt".to_string(), "location".to_string()],
            participants: vec![
                participant(&jordan, "Jordan", true),
                participant(&maya, "Maya", false),
                participant(&riya, "Riya", false),
            ],
            source_message_ids: vec!["msg_1".to_string()],
        },
    )
    .await
    .expect("propose succeeds");
    assert_eq!(proposed.revision, 1);
    assert!(matches!(proposed.state, PlanCardState::Polling));
    assert_eq!(proposed.participants.len(), 3);
    let jordan_status = proposed
        .participants
        .iter()
        .find(|p| p.account_id == jordan)
        .unwrap();
    assert!(
        matches!(jordan_status.rsvp, PlanCardRsvp::Yes),
        "the organizer starts as yes, not pending"
    );
    let maya_status = proposed
        .participants
        .iter()
        .find(|p| p.account_id == maya)
        .unwrap();
    assert!(matches!(maya_status.rsvp, PlanCardRsvp::Pending));

    // A non-member cannot propose against this conversation.
    let forbidden = store::propose(
        &pool,
        &outsider,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: None,
            existing_revision: None,
            title: "Sneaking in".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            state: PlanCardState::Polling,
            unresolved_fields: vec![],
            participants: vec![participant(&outsider, "Outsider", true)],
            source_message_ids: vec![],
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(
        forbidden,
        super::models::PlanCardStoreError::Forbidden
    ));

    // Update the same card in place (existingEventId), converging to a
    // single time with strong agreement now.
    let updated = store::propose(
        &pool,
        &jordan,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: Some(proposed.event_id.clone()),
            existing_revision: Some(proposed.revision),
            title: "Lunch — Sat 12:30".to_string(),
            start_at: Some("2026-06-14T12:30:00-07:00".to_string()),
            end_at: None,
            location: Some("Ramen Izakaya, 5th St".to_string()),
            state: PlanCardState::AwaitingConfirmation,
            unresolved_fields: vec![],
            participants: vec![
                participant(&jordan, "Jordan", true),
                participant(&maya, "Maya", false),
                participant(&riya, "Riya", false),
            ],
            source_message_ids: vec!["msg_1".to_string(), "msg_2".to_string()],
        },
    )
    .await
    .expect("update-in-place succeeds");
    assert_eq!(
        updated.event_id, proposed.event_id,
        "same card, not a new one"
    );
    assert_eq!(updated.revision, 2);
    assert!(matches!(updated.state, PlanCardState::AwaitingConfirmation));
    assert_eq!(updated.location.as_deref(), Some("Ramen Izakaya, 5th St"));

    // A stale revision is rejected, not silently applied.
    let stale = store::propose(
        &pool,
        &jordan,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: Some(proposed.event_id.clone()),
            existing_revision: Some(1), // already moved to 2
            title: "Stale write".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            state: PlanCardState::Polling,
            unresolved_fields: vec![],
            participants: vec![participant(&jordan, "Jordan", true)],
            source_message_ids: vec![],
        },
    )
    .await
    .unwrap_err();
    assert!(matches!(
        stale,
        super::models::PlanCardStoreError::RevisionConflict
    ));

    // Confirm.
    let confirmed = store::confirm(&pool, &updated.event_id, updated.revision, &jordan, None)
        .await
        .expect("confirm succeeds");
    assert_eq!(confirmed.revision, 3);
    assert!(matches!(confirmed.state, PlanCardState::Confirmed));

    // Confirming again at a now-stale revision is a harmless no-op, not an
    // error — this is the idempotency retries depend on.
    let confirmed_again = store::confirm(&pool, &confirmed.event_id, 1, &jordan, None)
        .await
        .expect("re-confirming is a no-op, not an error");
    assert_eq!(
        confirmed_again.revision, 3,
        "a no-op confirm must not bump the revision"
    );

    // Riya declines. The card must stay confirmed — one non-organizer "no"
    // is an RSVP change, never a cancellation.
    let declined = store::rsvp(
        &pool,
        &confirmed.event_id,
        confirmed_again.revision,
        &riya,
        PlanCardRsvp::No,
        Some("Riya can't make it — lunch is still on for the rest of you"),
    )
    .await
    .expect("rsvp succeeds");
    assert_eq!(declined.revision, 4);
    assert!(
        matches!(declined.state, PlanCardState::Confirmed),
        "a single non-organizer decline must never flip the card to canceled"
    );
    let riya_status = declined
        .participants
        .iter()
        .find(|p| p.account_id == riya)
        .unwrap();
    assert!(matches!(riya_status.rsvp, PlanCardRsvp::No));
    let jordan_status = declined
        .participants
        .iter()
        .find(|p| p.account_id == jordan)
        .unwrap();
    assert!(
        matches!(jordan_status.rsvp, PlanCardRsvp::Yes),
        "other participants' RSVPs are untouched by someone else's decline"
    );

    // An account that isn't a participant cannot rsvp.
    let not_participant = store::rsvp(
        &pool,
        &declined.event_id,
        declined.revision,
        &outsider,
        PlanCardRsvp::Yes,
        None,
    )
    .await;
    // outsider is not a conversation member either, so this fails at the
    // membership check before it would reach the participant check.
    assert!(matches!(
        not_participant.unwrap_err(),
        super::models::PlanCardStoreError::Forbidden
    ));

    // Reopen: new information makes it genuinely unclear.
    let reopened = store::reopen(
        &pool,
        &declined.event_id,
        declined.revision,
        &jordan,
        "3 of 5 declined within the hour",
    )
    .await
    .expect("reopen succeeds");
    assert_eq!(reopened.revision, 5);
    assert!(matches!(
        reopened.state,
        PlanCardState::AwaitingConfirmation
    ));
    assert_eq!(
        reopened.note.as_deref(),
        Some("3 of 5 declined within the hour")
    );

    // Reopening something that isn't confirmed is a real error.
    let cannot_reopen = store::reopen(
        &pool,
        &reopened.event_id,
        reopened.revision,
        &jordan,
        "already not confirmed",
    )
    .await
    .unwrap_err();
    assert!(matches!(
        cannot_reopen,
        super::models::PlanCardStoreError::InvalidTransition(_)
    ));

    // Confirm again after reopening, then cancel.
    let reconfirmed = store::confirm(&pool, &reopened.event_id, reopened.revision, &jordan, None)
        .await
        .expect("reconfirm succeeds");
    let canceled = store::cancel(
        &pool,
        &reconfirmed.event_id,
        reconfirmed.revision,
        &jordan,
        Some("Something came up, can't do Saturday anymore"),
    )
    .await
    .expect("cancel succeeds");
    assert!(matches!(canceled.state, PlanCardState::Canceled));

    // A confirmed plan can never be confirmed again after cancellation.
    let cannot_confirm_canceled =
        store::confirm(&pool, &canceled.event_id, canceled.revision, &jordan, None)
            .await
            .unwrap_err();
    assert!(matches!(
        cannot_confirm_canceled,
        super::models::PlanCardStoreError::InvalidTransition(_)
    ));

    // Retrying a cancellation is safe and idempotent, matching "duplicate
    // messages or retries do not create duplicate cards or actions."
    let canceled_again = store::cancel(
        &pool,
        &canceled.event_id,
        1, // deliberately stale — must not matter for an already-canceled card
        &jordan,
        Some("different reason text"),
    )
    .await
    .expect("re-canceling is a no-op, not an error");
    assert_eq!(
        canceled_again.revision, canceled.revision,
        "a no-op cancel must not bump the revision"
    );
    assert_eq!(
        canceled_again.note.as_deref(),
        canceled.note.as_deref(),
        "a no-op cancel must not overwrite the original reason"
    );

    // Two unrelated plans can coexist in the same conversation — there is
    // deliberately no one-open-card-per-conversation constraint.
    let second_plan = store::propose(
        &pool,
        &maya,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: None,
            existing_revision: None,
            title: "November trip".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            state: PlanCardState::Polling,
            unresolved_fields: vec![],
            participants: vec![participant(&maya, "Maya", true)],
            source_message_ids: vec![],
        },
    )
    .await
    .expect("a second, unrelated open card is allowed");
    assert_ne!(second_plan.event_id, canceled.event_id);
}
