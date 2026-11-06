//! Run history never carries messages from people who declined AI.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::json;
use sqlx_core::query::query;
use uuid::Uuid;

use super::super::ClaimRunRequest;
use super::fallback_prompt_for_claim;
use crate::plan_cards::tests::seed_account;

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn history_leaves_out_messages_from_people_who_declined_ai() {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let owner = format!("history-owner-{suffix}");
    let declined = format!("history-declined-{suffix}");
    let undecided = format!("history-unset-{suffix}");
    for account in [&owner, &declined, &undecided] {
        seed_account(&pool, account).await;
    }
    for (account, status) in [(&declined, "declined"), (&undecided, "unset")] {
        query("UPDATE cloud_accounts SET ai_consent_status = $2 WHERE account_id = $1")
            .bind(account)
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
    }
    let conversation = Uuid::new_v4();
    let session = format!("history-consent-{suffix}");
    query(
        "INSERT INTO cloud_chat_conversations (conversation_id, kind, created_by_account_id, \
         client_operation_id, creation_fingerprint, legacy_session_id) \
         VALUES ($1, 'group', $2, $3, 'test', $4)",
    )
    .bind(conversation)
    .bind(&owner)
    .bind(Uuid::new_v4())
    .bind(&session)
    .execute(&pool)
    .await
    .unwrap();
    // Group messages carry their sender, so history names them as participants.
    let group_text = |sender: &str, text: &str| {
        let person = json!({"accountId": sender, "displayName": "Member", "avatarUrl": null});
        let envelope = json!({
            "kind": "group-message", "groupId": "group-history", "groupTitle": null,
            "createdByAccountId": sender, "actor": person, "participants": [person],
            "message": {"id": Uuid::new_v4().to_string(), "senderAccountId": sender,
                        "text": text, "createdAtMs": 0, "senderKind": "person"},
        });
        format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap())
        )
    };
    let mut request = String::new();
    for (sequence, (sender, text)) in [
        (&undecided, "Friday works for me"),
        (&declined, "My private reply about Friday"),
        (&owner, "Can you plan Friday?"),
    ]
    .into_iter()
    .enumerate()
    {
        let id = Uuid::new_v4();
        let body = if sender == &owner {
            text.to_string()
        } else {
            group_text(sender, text)
        };
        query(
            "INSERT INTO cloud_chat_messages (message_id, conversation_id, conversation_sequence, \
             sender_account_id, client_message_id, request_fingerprint, content) \
             VALUES ($1, $2, $3, $4, $5, 'test', $6)",
        )
        .bind(id)
        .bind(conversation)
        .bind(sequence as i64 + 1)
        .bind(sender)
        .bind(Uuid::new_v4())
        .bind(json!({"blocks": [{"type": "text", "text": body}]}))
        .execute(&pool)
        .await
        .unwrap();
        request = id.to_string();
    }
    let prompt = fallback_prompt_for_claim(
        &pool,
        &ClaimRunRequest {
            request_message_id: request.clone(),
            session_id: session,
            owner_account_id: owner.clone(),
            requester_account_id: owner,
            prompt: "Can you plan Friday?".into(),
            runtime_route: None,
            idempotency_key: request,
        },
        None,
    )
    .await
    .unwrap();
    let everything = format!("{}\n{}", prompt.user_prompt, prompt.omp_input);
    assert!(everything.contains("Friday works for me"), "{everything}");
    assert!(!everything.contains("My private reply"), "{everything}");
}
