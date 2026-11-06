//! The System agent never reads messages from members who declined AI.

use crate::chat_sync::models::SendMessageRequest;
use crate::plan_cards::tests::{seed_account, seed_conversation};
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

async fn send(pool: &sqlx_postgres::PgPool, sender: &str, chat: Uuid, text: &str) {
    crate::chat_sync::store::send_message(
        pool,
        sender,
        chat,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": text}], "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send message");
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn messages_of_members_who_declined_ai_stay_out_of_the_context() {
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
    let system_agent = format!("system-agent-consent-{suffix}");
    let allowed = format!("member-allowed-{suffix}");
    let declined = format!("member-declined-{suffix}");
    let undecided = format!("member-unset-{suffix}");
    for account in [&system_agent, &allowed, &declined, &undecided] {
        seed_account(&pool, account).await;
    }
    for (account, status) in [(&allowed, "allowed"), (&declined, "declined")] {
        query("UPDATE cloud_accounts SET ai_consent_status = $2 WHERE account_id = $1")
            .bind(account)
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &allowed, &[&allowed, &declined, &undecided]).await;
    super::membership::join_conversation(&pool, &system_agent, chat)
        .await
        .expect("join the System agent");
    let (context_start,): (i64,) = query_as(
        "SELECT context_start_sequence FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    send(&pool, &allowed, chat, "Lunch on Friday at noon?").await;
    send(&pool, &declined, chat, "My private reply about Friday").await;
    send(&pool, &undecided, chat, "Friday works for me").await;
    let (latest,): (i64,) = query_as(
        "SELECT latest_message_sequence FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    let config = super::SystemAgentConfig {
        resource_pools: super::test_config(&system_agent).resource_pools,
        system_prompt: super::prompt::system_prompt(Some("Synthetic system persona.")).unwrap(),
        group_chat_enabled: true,
        account_id: system_agent.clone(),
        owner_email: "system-agent-test@example.invalid".to_string(),
        agent_id: "system-agent-consent-test".to_string(),
        name: "System".to_string(),
        subtitle: "Test".to_string(),
        provider_auth: super::SystemAgentProviderAuth::openai_api_key(
            "synthetic-key",
            "synthetic-model",
        )
        .unwrap(),
    };
    let input = super::input::build_input(
        &pool,
        &config,
        &super::input::Candidate {
            conversation_id: chat,
            legacy_session_id: String::new(),
            latest_sequence: latest,
            seen_sequence: context_start,
            context_start_sequence: context_start,
            hooks_fired: json!({}),
        },
    )
    .await
    .unwrap();
    let texts: Vec<&str> = input["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|message| message["text"].as_str())
        .collect();
    assert_eq!(
        texts,
        ["Lunch on Friday at noon?", "Friday works for me"],
        "{input}"
    );
    assert!(!input.to_string().contains("My private reply"), "{input}");
}
