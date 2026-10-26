//! The sweep query against a real database: members' messages wake the System
//! agent, its own messages and cards it has seen do not.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::models::SendMessageRequest;
use crate::plan_cards::models::{PlanCardProposeArgs, PlanCardState};
use crate::plan_cards::tests::{participant, seed_account, seed_conversation};

async fn say(pool: &PgPool, sender: &str, conversation_id: Uuid, text: &str) {
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v4(),
        kind: "text".to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    crate::chat_sync::store::send_message(pool, sender, conversation_id, request)
        .await
        .expect("send message");
    query("UPDATE cloud_chat_messages SET created_at = now() - interval '5 minutes' WHERE conversation_id = $1")
        .bind(conversation_id)
        .execute(pool)
        .await
        .unwrap();
}

async fn selected(pool: &PgPool, system_agent: &str, conversation_id: Uuid) -> bool {
    query("UPDATE cloud_pip_conversation_state SET checked_at = now() - interval '1 hour'")
        .execute(pool)
        .await
        .unwrap();
    let rows: Vec<(Uuid, Option<String>, i64, i64, i64, Value)> = query_as(super::store::SWEEP_SQL)
        .bind(system_agent)
        .bind(1000_i64)
        .fetch_all(pool)
        .await
        .expect("sweep query");
    rows.iter().any(|row| row.0 == conversation_id)
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn sweep_wakes_for_members_and_unseen_cards_only() {
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
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &jordan, &[&jordan, &system_agent]).await;
    query("INSERT INTO cloud_pip_conversation_state (conversation_id) VALUES ($1)")
        .bind(chat)
        .execute(&pool)
        .await
        .unwrap();

    say(&pool, &system_agent, chat, "Vote card is up.").await;
    assert!(
        !selected(&pool, &system_agent, chat).await,
        "the System agent's own message"
    );
    say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    assert!(
        selected(&pool, &system_agent, chat).await,
        "a member's message"
    );

    query("UPDATE cloud_pip_conversation_state SET seen_sequence = 100 WHERE conversation_id = $1")
        .bind(chat)
        .execute(&pool)
        .await
        .unwrap();
    let card = crate::plan_cards::store::propose(
        &pool,
        &jordan,
        PlanCardProposeArgs {
            conversation_id: chat,
            existing_event_id: None,
            existing_revision: None,
            title: "Dinner".to_string(),
            start_at: None,
            end_at: None,
            location: None,
            state: PlanCardState::AwaitingConfirmation,
            unresolved_fields: Vec::new(),
            participants: vec![participant(&jordan, "Jordan", true)],
            source_message_ids: Vec::new(),
            options: Vec::new(),
        },
    )
    .await
    .expect("propose");
    query("UPDATE cloud_plan_cards SET updated_at = now() - interval '5 minutes'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        selected(&pool, &system_agent, chat).await,
        "an unseen card change"
    );
    super::cards::mark_card_seen(&pool, chat, &card.event_id, card.revision)
        .await
        .unwrap();
    super::cards::mark_card_seen(&pool, chat, &card.event_id, 0)
        .await
        .unwrap();
    assert!(
        !selected(&pool, &system_agent, chat).await,
        "a card the System agent has seen"
    );
    super::store::release_stale_runs(&pool)
        .await
        .expect("release query");
}

async fn system_agent_runs(pool: &PgPool, system_agent: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_agent_fallback_runs WHERE owner_account_id = $1 AND run_id LIKE 'pip\\_%'",
    )
    .bind(system_agent)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn messages_for_an_agent_or_already_answered_do_not_queue_a_run() {
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
    let (system_agent, jordan) = (format!("system-agent-{suffix}"), format!("jordan-{suffix}"));
    for account in [&system_agent, &jordan] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &jordan, &[&jordan, &system_agent]).await;
    query("UPDATE cloud_chat_conversations SET legacy_session_id = $2 WHERE conversation_id = $1")
        .bind(chat)
        .bind(format!("session-{suffix}"))
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_pip_conversation_state (conversation_id) VALUES ($1)")
        .bind(chat)
        .execute(&pool)
        .await
        .unwrap();
    let config = super::test_config(&system_agent);
    let sweep = || async {
        query("UPDATE cloud_pip_conversation_state SET checked_at = now() - interval '1 hour'")
            .execute(&pool)
            .await
            .unwrap();
        super::store::sweep(&pool, &config).await.expect("sweep")
    };

    // (a) A member asks their own agent, with meeting words in the text.
    let to_agent = json!({"schemaVersion": 1, "kind": "message",
        "text": "@KordiJordan check my memory for the Friday meeting at 7pm",
        "targetCloudAgentId": format!("cloud-agent:{jordan}")});
    let encoded = format!(
        "kordi-cloud-message:{}",
        URL_SAFE_NO_PAD.encode(to_agent.to_string())
    );
    say(&pool, &jordan, chat, &encoded).await;
    assert_eq!(sweep().await, 0, "a message for an agent");
    let (seen, latest): (i64, i64) = query_as(
        "SELECT state.seen_sequence, c.latest_message_sequence
         FROM cloud_pip_conversation_state state
         JOIN cloud_chat_conversations c ON c.conversation_id = state.conversation_id
         WHERE state.conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(seen, latest, "the System agent still marks it seen");

    // (b) A plain plan message an agent already answered.
    say(&pool, &jordan, chat, "Lunch tomorrow at noon?").await;
    let (message_id,): (String,) = query_as(
        "SELECT message_id::text FROM cloud_chat_messages WHERE conversation_id = $1
         ORDER BY conversation_sequence DESC LIMIT 1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES($1,$1,$2,$3,$4,$4,'completed','answer',$5,$5)")
        .bind(format!("run-{suffix}"))
        .bind(&message_id)
        .bind(format!("session-{suffix}"))
        .bind(&jordan)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(sweep().await, 0, "a message an agent answered");

    // (c) Plain coordination between people still wakes the System agent.
    say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    assert_eq!(sweep().await, 1, "a plain plan message");
    assert_eq!(system_agent_runs(&pool, &system_agent).await, 1);
}
