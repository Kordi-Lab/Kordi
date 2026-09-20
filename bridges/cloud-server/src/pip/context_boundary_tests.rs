use crate::chat_sync::models::SendMessageRequest;
use crate::plan_cards::tests::{seed_account, seed_conversation};
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn provider_context_excludes_pre_join_messages_across_retry_and_completion() {
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
    let pip = format!("pip-boundary-{}", Uuid::new_v4().simple());
    let member = format!("member-boundary-{}", Uuid::new_v4().simple());
    for account in [&pip, &member] {
        seed_account(&pool, account).await;
    }
    let chat = Uuid::new_v4();
    seed_conversation(&pool, chat, &member, &[&member]).await;
    for text in ["Before one", "Before two"] {
        crate::chat_sync::store::send_message(
            &pool,
            &member,
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
        .expect("send pre-join message");
    }
    super::membership::join_conversation(&pool, &pip, chat)
        .await
        .expect("join PiP");
    let (context_start,): (i64,) = query_as(
        "SELECT context_start_sequence FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    crate::chat_sync::store::send_message(
        &pool,
        &member,
        chat,
        SendMessageRequest {
            client_message_id: Uuid::new_v4(),
            kind: "text".to_string(),
            content: json!({"schema": 1, "blocks": [{"type": "text", "text": "After PiP joined"}], "legacy_attachments": []}),
            reply_to_message_id: None,
            attachment_ids: Vec::new(),
        },
    )
    .await
    .expect("send post-join message");
    let (latest,): (i64,) = query_as(
        "SELECT latest_message_sequence FROM cloud_chat_conversations WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    let config = super::PipConfig {
        account_id: pip.clone(),
        owner_email: "pip-test@example.invalid".to_string(),
        agent_id: "pip-boundary-test".to_string(),
        name: "PiP".to_string(),
        subtitle: "Test".to_string(),
        provider_auth: super::PipProviderAuth::openai_api_key("synthetic-key", "synthetic-model")
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
    let messages = input["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["text"], "After PiP joined");

    let now = chrono::Utc::now().to_rfc3339();
    let failed_run = format!("pip_{}", Uuid::new_v4().simple());
    let prompt =
        json!({"hooks": [{"name": "new_messages", "sinceSequence": context_start}]}).to_string();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES($1,$1,$1,'pip-boundary-test',$2,$2,'queued',$3,$4,$4)")
        .bind(&failed_run)
        .bind(&pip)
        .bind(prompt)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE cloud_pip_conversation_state SET active_run_id = $2, seen_sequence = $3 WHERE conversation_id = $1")
        .bind(chat)
        .bind(&failed_run)
        .bind(latest)
        .execute(&pool)
        .await
        .unwrap();
    super::store::fail(&pool, &failed_run, None, "synthetic_failure")
        .await
        .unwrap();
    let (retry_seen, retry_boundary): (i64, i64) = query_as(
        "SELECT seen_sequence, context_start_sequence FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((retry_seen, retry_boundary), (context_start, context_start));

    let completed_run = format!("pip_{}", Uuid::new_v4().simple());
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,claimed_by,created_at,updated_at) VALUES($1,$1,$1,'pip-boundary-test',$2,$2,'running','{\"hooks\":[],\"openCard\":null}','boundary-runner',$3,$3)")
        .bind(&completed_run)
        .bind(&pip)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    query("UPDATE cloud_pip_conversation_state SET active_run_id = $2, seen_sequence = $3 WHERE conversation_id = $1")
        .bind(chat)
        .bind(&completed_run)
        .bind(latest)
        .execute(&pool)
        .await
        .unwrap();
    super::store::complete(
        &pool,
        &completed_run,
        "boundary-runner",
        "{\"message\":null}",
    )
    .await
    .unwrap();
    let (completed_seen, completed_boundary): (i64, i64) = query_as(
        "SELECT seen_sequence, context_start_sequence FROM cloud_pip_conversation_state WHERE conversation_id = $1",
    )
    .bind(chat)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (completed_seen, completed_boundary),
        (latest, context_start)
    );
}
