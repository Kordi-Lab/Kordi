use super::models::{PlanCardProposeArgs, PlanCardState};
use super::tests::{participant, seed_account, seed_conversation};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

async fn proposed_card(
    pool: &PgPool,
    owner: &str,
    conversation_id: Uuid,
) -> super::models::PlanCardRow {
    super::store::propose(
        pool,
        owner,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: None,
            existing_revision: None,
            title: "Projection fixture".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            state: PlanCardState::Polling,
            unresolved_fields: Vec::new(),
            participants: vec![participant(owner, owner, true)],
            source_message_ids: Vec::new(),
            options: Vec::new(),
        },
    )
    .await
    .expect("propose card")
}

async fn setup() -> (PgPool, String, Uuid) {
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
    query("DELETE FROM cloud_plan_card_projection_queue")
        .execute(&pool)
        .await
        .expect("isolate projection fixtures from earlier test cards");
    let owner = format!("projection-owner-{}", Uuid::new_v4().simple());
    seed_account(&pool, &owner).await;
    let conversation_id = Uuid::new_v4();
    seed_conversation(&pool, conversation_id, &owner, &[&owner]).await;
    (pool, owner, conversation_id)
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn mutations_enqueue_one_projection_at_the_latest_revision() {
    let (pool, owner, conversation_id) = setup().await;
    let proposed = proposed_card(&pool, &owner, conversation_id).await;
    let revised = super::store::propose(
        &pool,
        &owner,
        PlanCardProposeArgs {
            conversation_id,
            existing_event_id: Some(proposed.event_id.clone()),
            existing_revision: Some(proposed.revision),
            title: "Latest".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            state: PlanCardState::AwaitingConfirmation,
            unresolved_fields: Vec::new(),
            participants: vec![participant(&owner, &owner, true)],
            source_message_ids: Vec::new(),
            options: Vec::new(),
        },
    )
    .await
    .expect("revise card");

    let queued: Vec<(String, i64)> = query_as(
        "SELECT event_id, target_revision FROM cloud_plan_card_projection_queue WHERE event_id = $1",
    )
    .bind(&proposed.event_id)
    .fetch_all(&pool)
    .await
    .expect("read projection queue");
    assert_eq!(queued, vec![(proposed.event_id, revised.revision)]);
    query("DELETE FROM cloud_plan_cards WHERE event_id = $1")
        .bind(&revised.event_id)
        .execute(&pool)
        .await
        .expect("clean projection fixture");
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn bounded_projection_drain_reports_remaining_work_and_replays_idempotently() {
    let (pool, owner, conversation_id) = setup().await;
    let first = proposed_card(&pool, &owner, conversation_id).await;
    let second = proposed_card(&pool, &owner, conversation_id).await;

    let partial = super::projection::drain(&pool, 1)
        .await
        .expect("partial drain");
    assert_eq!(partial.projected, 1);
    assert_eq!(partial.failed, 0);
    assert_eq!(partial.pending, 1);
    assert!(!partial.is_complete());

    let completed = super::projection::drain(&pool, 10)
        .await
        .expect("complete drain");
    assert_eq!(completed.projected, 1);
    assert!(completed.is_complete());

    let before: (i64,) =
        query_as("SELECT count(*) FROM cloud_calendar_events WHERE event_id = ANY($1)")
            .bind(vec![
                format!("plan:{}", first.event_id),
                format!("plan:{}", second.event_id),
            ])
            .fetch_one(&pool)
            .await
            .expect("calendar count");
    let empty = super::projection::drain(&pool, 10)
        .await
        .expect("idempotent drain");
    let after: (i64,) =
        query_as("SELECT count(*) FROM cloud_calendar_events WHERE event_id = ANY($1)")
            .bind(vec![
                format!("plan:{}", first.event_id),
                format!("plan:{}", second.event_id),
            ])
            .fetch_one(&pool)
            .await
            .expect("calendar count");
    assert_eq!(empty.projected, 0);
    assert!(empty.is_complete());
    assert_eq!(after, before);
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn failed_projection_is_retriable_and_never_deletes_a_newer_revision() {
    let (pool, owner, conversation_id) = setup().await;
    let card = proposed_card(&pool, &owner, conversation_id).await;
    super::projection::record_failure(&pool, &card.event_id, card.revision, "forced test failure")
        .await
        .expect("record failure");
    let failed: (i32, bool) = query_as(
        "SELECT attempts, retry_after > now() FROM cloud_plan_card_projection_queue WHERE event_id = $1",
    )
    .bind(&card.event_id)
    .fetch_one(&pool)
    .await
    .expect("failed projection row");
    assert_eq!(failed, (1, true));

    query(
        "UPDATE cloud_plan_card_projection_queue
         SET target_revision = target_revision + 1, attempts = 0, retry_after = now()
         WHERE event_id = $1",
    )
    .bind(&card.event_id)
    .execute(&pool)
    .await
    .expect("simulate newer queued revision");
    super::projection::record_failure(
        &pool,
        &card.event_id,
        card.revision,
        "stale projection failure",
    )
    .await
    .expect("ignore stale failure");
    let (attempts,): (i32,) =
        query_as("SELECT attempts FROM cloud_plan_card_projection_queue WHERE event_id = $1")
            .bind(&card.event_id)
            .fetch_one(&pool)
            .await
            .expect("newer projection remains immediately retryable");
    assert_eq!(attempts, 0);

    let outcome = super::projection::drain(&pool, 1)
        .await
        .expect("revision-safe drain");
    assert_eq!(outcome.projected, 0);
    assert_eq!(outcome.pending, 1);
    assert!(!outcome.is_complete());
    let (attempts,): (i32,) =
        query_as("SELECT attempts FROM cloud_plan_card_projection_queue WHERE event_id = $1")
            .bind(&card.event_id)
            .fetch_one(&pool)
            .await
            .expect("failed current projection records backoff");
    assert_eq!(attempts, 1);
    query("DELETE FROM cloud_plan_cards WHERE event_id = $1")
        .bind(&card.event_id)
        .execute(&pool)
        .await
        .expect("clean projection fixture");
}
