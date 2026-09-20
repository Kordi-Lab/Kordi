use crate::plan_cards::tests::{seed_account, seed_conversation};
use crate::{events::EventBus, server::ServerState};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use std::sync::Arc;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn tool_time_changes_refresh_the_same_message_before_run_completion() {
    let pool = sqlx_postgres::PgPoolOptions::new()
        .connect(
            &std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated database required"),
        )
        .await
        .unwrap();
    crate::pg::pool::apply_migrations(&pool).await.unwrap();
    let member = format!("member-{}", Uuid::new_v4().simple());
    seed_account(&pool, &member).await;
    let pending = super::PendingPipConfig::from_lookup(|key| match key {
        "KORDI_PIP_OPENAI_API_KEY" => Some("synthetic-test-key".to_string()),
        _ => None,
    })
    .unwrap()
    .unwrap();
    let config = super::bootstrap_pip_agent(&pool, pending).await.unwrap();
    let pip = config.account_id.clone();
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &member, &[&member, &pip]).await;
    let session = format!("group:{chat}");
    query("UPDATE cloud_chat_conversations SET legacy_session_id=$2 WHERE conversation_id=$1")
        .bind(chat)
        .bind(&session)
        .execute(&pool)
        .await
        .unwrap();
    let run = format!("pip_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    let lease_expires_at = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,claimed_by,lease_expires_at,created_at,updated_at) VALUES($1,$1,$1,$2,$3,$3,'running','{}','test-runner',$4,$5,$5)")
        .bind(&run).bind(&session).bind(&pip).bind(lease_expires_at).bind(now).execute(&pool).await.unwrap();
    let state = Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_pip(super::PipService::new(config)),
    );
    let first = (chrono::Utc::now() + chrono::Duration::days(2)).to_rfc3339();
    let next = (chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339();
    let proposal = |time: &str| json!({"action":"propose","conversationId":chat,"title":"Lunch","state":"awaitingConfirmation","startAt":time,"location":"Cafe","unresolvedFields":[],"participants":[{"participantId":member,"displayName":"Member","organizer":true}]});
    let result =
        crate::plan_cards::runner_action(&state, &run, "test-runner", proposal(&first)).await;
    assert_eq!(result.status(), 200);
    let (id, content, version): (Uuid, Value, i32) = query_as("SELECT message_id,content,version FROM cloud_chat_messages WHERE conversation_id=$1 ORDER BY conversation_sequence DESC LIMIT 1")
        .bind(chat).fetch_one(&pool).await.unwrap();
    let card = &content["blocks"][0];
    let mut revise = proposal(&next);
    revise["existingEventId"] = card["eventId"].clone();
    revise["existingRevision"] = card["revision"].clone();
    let result = crate::plan_cards::runner_action(&state, &run, "test-runner", revise).await;
    assert_eq!(result.status(), 200);
    let (updated, newer_version): (Value, i32) =
        query_as("SELECT content,version FROM cloud_chat_messages WHERE message_id=$1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(updated["blocks"][0]["eventId"], card["eventId"]);
    assert_eq!(
        updated["blocks"][0]["revision"].as_i64(),
        Some(card["revision"].as_i64().unwrap() + 1)
    );
    assert_ne!(updated["blocks"][0]["startAt"], card["startAt"]);
    assert_eq!(newer_version, version + 1);
    let (count,): (i64,) =
        query_as("SELECT count(*) FROM cloud_chat_messages WHERE conversation_id=$1")
            .bind(chat)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "the existing card is refreshed, not reposted");

    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at=(now()-interval '1 second')::text WHERE run_id=$1")
        .bind(&run)
        .execute(&pool)
        .await
        .unwrap();
    let rejected = crate::plan_cards::runner_action(
        &state,
        &run,
        "test-runner",
        json!({
            "action": "rsvp",
            "eventId": card["eventId"],
            "participantId": member,
            "rsvp": "yes"
        }),
    )
    .await;
    assert_eq!(rejected.status(), 404, "expired leases cannot mutate cards");
}
