//! The sweep query against a real database: members' messages wake PiP, its
//! own messages and cards it has seen do not.

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

async fn selected(pool: &PgPool, pip: &str, conversation_id: Uuid) -> bool {
    query("UPDATE cloud_pip_conversation_state SET checked_at = now() - interval '1 hour'")
        .execute(pool)
        .await
        .unwrap();
    let rows: Vec<(Uuid, Option<String>, i64, i64, Value)> = query_as(super::store::SWEEP_SQL)
        .bind(pip)
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
    let (pip, jordan) = (format!("pip-{suffix}"), format!("jordan-{suffix}"));
    for account in [&pip, &jordan] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &jordan, &[&jordan, &pip]).await;
    query("INSERT INTO cloud_pip_conversation_state (conversation_id) VALUES ($1)")
        .bind(chat)
        .execute(&pool)
        .await
        .unwrap();

    say(&pool, &pip, chat, "Vote card is up.").await;
    assert!(!selected(&pool, &pip, chat).await, "PiP's own message");
    say(&pool, &jordan, chat, "Dinner Friday at 7?").await;
    assert!(selected(&pool, &pip, chat).await, "a member's message");

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
    assert!(selected(&pool, &pip, chat).await, "an unseen card change");
    super::cards::mark_card_seen(&pool, chat, &card.event_id, card.revision)
        .await
        .unwrap();
    super::cards::mark_card_seen(&pool, chat, &card.event_id, 0)
        .await
        .unwrap();
    assert!(!selected(&pool, &pip, chat).await, "a card PiP has seen");
    super::store::release_stale_runs(&pool)
        .await
        .expect("release query");
}
