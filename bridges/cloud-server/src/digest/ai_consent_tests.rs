//! Digests and AI consent: another member's digest never reads a declined
//! person's messages, and background runs wait for an owner who allowed AI.

use serde_json::json;
use sqlx_core::query::query;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{store, worker};
use crate::plan_cards::tests::seed_account;

async fn pool() -> PgPool {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool).await.unwrap();
    pool
}

async fn person(pool: &PgPool, label: &str, consent: &str) -> String {
    let id = format!("digest-{label}-{}", Uuid::new_v4().simple());
    seed_account(pool, &id).await;
    query("UPDATE cloud_accounts SET ai_consent_status = $2 WHERE account_id = $1")
        .bind(&id)
        .bind(consent)
        .execute(pool)
        .await
        .unwrap();
    id
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn a_digest_never_reads_a_declined_persons_messages() {
    let pool = pool().await;
    let viewer = person(&pool, "viewer", "allowed").await;
    let declined = person(&pool, "declined", "declined").await;
    let undecided = person(&pool, "unset", "unset").await;
    let chat = Uuid::new_v4();
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, created_by_account_id, \
         client_operation_id, creation_fingerprint) VALUES ($1, 'group', $2, $3, 'test')",
    )
    .bind(chat)
    .bind(&viewer)
    .bind(Uuid::new_v4())
    .execute(&pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_conversation_members (conversation_id, account_id) VALUES ($1, $2)",
    )
    .bind(chat)
    .bind(&viewer)
    .execute(&pool)
    .await
    .unwrap();
    let mut ids = Vec::new();
    for (sequence, sender) in [&declined, &undecided].into_iter().enumerate() {
        let id = Uuid::new_v4();
        query(
            "INSERT INTO cloud_chat_messages (message_id, conversation_id, conversation_sequence, \
             sender_account_id, client_message_id, request_fingerprint, content) \
             VALUES ($1, $2, $3, $4, $5, 'test', $6)",
        )
        .bind(id)
        .bind(chat)
        .bind(sequence as i64 + 1)
        .bind(sender)
        .bind(Uuid::new_v4())
        .bind(json!({"blocks": [{"type": "text", "text": "Please review the draft."}]}))
        .execute(&pool)
        .await
        .unwrap();
        ids.push(id.to_string());
    }
    let input = store::input(&pool, &viewer, "en", "UTC", None)
        .await
        .unwrap();
    let sources: Vec<&str> = input.sources.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(
        sources,
        [ids[1].as_str()],
        "only the undecided member's message"
    );
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn background_digest_runs_wait_for_an_owner_who_allowed_ai() {
    let pool = pool().await;
    let allowed = person(&pool, "allowed", "allowed").await;
    let undecided = person(&pool, "unset", "unset").await;
    for account in [&allowed, &undecided] {
        store::initialize_preferences(&pool, account, "en", "UTC")
            .await
            .unwrap();
        // First in line for both the due check and the urgent check.
        query(
            "UPDATE cloud_account_digests SET checked_at = '2000-01-01', \
             urgent_since = '2000-01-01', retry_after = '2000-01-01' WHERE account_id = $1",
        )
        .bind(account)
        .execute(&pool)
        .await
        .unwrap();
    }
    let due = worker::claim_due(&pool).await.unwrap();
    assert!(due.contains(&allowed), "{due:?}");
    assert!(!due.contains(&undecided), "{due:?}");
    let urgent = worker::urgent_due(&pool).await.unwrap();
    assert!(urgent.contains(&allowed), "{urgent:?}");
    assert!(!urgent.contains(&undecided), "{urgent:?}");
}
