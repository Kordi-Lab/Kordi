use super::*;

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_98_backfills_projection_and_pip_context_boundaries() {
    let pool = fixture(98).await;
    let conversation = Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id,next_message_sequence,latest_message_sequence) VALUES($1,'group','fixture-owner',$2,'pip-context-fixture',$3,8,7)")
        .bind(conversation)
        .bind(Uuid::new_v4())
        .bind(format!("group:{conversation}"))
        .execute(&pool)
        .await
        .unwrap();
    query(
        "INSERT INTO cloud_pip_conversation_state (conversation_id, seen_sequence) VALUES ($1, 7)",
    )
    .bind(conversation)
    .execute(&pool)
    .await
    .unwrap();
    query("INSERT INTO cloud_plan_cards(event_id,conversation_id,state,title,revision,created_by_account_id) VALUES('fixture-plan',$1,'polling','Fixture plan',1,'fixture-owner')")
        .bind(conversation)
        .execute(&pool)
        .await
        .unwrap();

    let (first, second) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    first.unwrap();
    second.unwrap();
    latest_version(&pool).await;
    let (seen, context_start): (i64, i64) = query_as(
        "SELECT seen_sequence, context_start_sequence FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((seen, context_start), (7, 7));

    query("DELETE FROM cloud_pip_conversation_state WHERE conversation_id = $1")
        .bind(conversation)
        .execute(&pool)
        .await
        .unwrap();
    query(
        "INSERT INTO cloud_pip_conversation_state (conversation_id, seen_sequence) VALUES ($1, 9)",
    )
    .bind(conversation)
    .execute(&pool)
    .await
    .unwrap();
    let (rolling_context_start,): (i64,) = query_as(
        "SELECT context_start_sequence FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        rolling_context_start, 9,
        "older binaries inherit the join cursor"
    );

    let (backfilled_revision,): (i64,) = query_as(
        "SELECT target_revision FROM cloud_plan_card_projection_queue WHERE event_id = 'fixture-plan'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(backfilled_revision, 1);
    query("UPDATE cloud_plan_cards SET revision = 2 WHERE event_id = 'fixture-plan'")
        .execute(&pool)
        .await
        .unwrap();
    let (rolling_revision,): (i64,) = query_as(
        "SELECT target_revision FROM cloud_plan_card_projection_queue WHERE event_id = 'fixture-plan'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        rolling_revision, 2,
        "older binaries enqueue through the trigger"
    );
}
