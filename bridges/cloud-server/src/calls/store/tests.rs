use super::{active, active_for_account, end, join, preferred_account_display_name, start};
use crate::calls::models::{CallKind, CallState, StartCallRequest};
use crate::chat_sync::models::{ConversationKind, CreateConversationRequest};
use crate::chat_sync::store::create_conversation;
use sqlx_core::query::query;
use uuid::Uuid;

#[test]
fn call_display_name_prefers_a_non_empty_profile_name() {
    assert_eq!(
        preferred_account_display_name(Some("Alex".to_string()), 123_456_789),
        "Alex"
    );
}

#[test]
fn call_display_name_formats_the_numeric_public_account_number() {
    assert_eq!(
        preferred_account_display_name(Some("  ".to_string()), 123_456_789),
        "123456789"
    );
}

#[tokio::test]
async fn concurrent_end_and_join_leave_a_terminal_call() {
    let Ok(database_url) = std::env::var("DATABASE_URL") else {
        return;
    };
    let pool = crate::pg::init_pool(&database_url).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let caller = format!("acct_call_caller_{suffix}");
    let callee = format!("acct_call_callee_{suffix}");
    let now = chrono::Utc::now().to_rfc3339();
    for account_id in [&caller, &callee] {
        query(
            "INSERT INTO cloud_accounts \
             (account_id, display_name, primary_email, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, $4)",
        )
        .bind(account_id)
        .bind(account_id)
        .bind(format!("{account_id}@e2e.local"))
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    }
    for (account_id, peer_account_id) in [(&caller, &callee), (&callee, &caller)] {
        query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, $3)",
        )
        .bind(account_id)
        .bind(peer_account_id)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();
    }
    let conversation = create_conversation(
        &pool,
        &caller,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: format!("session:direct:{suffix}"),
            member_account_ids: vec![callee.clone()],
        },
    )
    .await
    .unwrap()
    .value;
    let started = start(
        &pool,
        &caller,
        conversation.id,
        StartCallRequest {
            client_operation_id: Uuid::now_v7(),
            kind: CallKind::Video,
        },
    )
    .await
    .unwrap();

    let (ended, joined) = tokio::join!(
        end(&pool, &caller, started.call.id),
        join(&pool, &callee, started.call.id),
    );
    let ended = ended.unwrap();
    assert_eq!(ended.state, CallState::Ended);
    if let Ok(joined) = joined {
        assert!(joined.call.revision < ended.revision);
    }
    assert!(active(&pool, &caller, conversation.id)
        .await
        .unwrap()
        .is_none());
    assert!(active(&pool, &callee, conversation.id)
        .await
        .unwrap()
        .is_none());
    assert!(active_for_account(&pool, &caller).await.unwrap().is_empty());
    assert!(active_for_account(&pool, &callee).await.unwrap().is_empty());

    let repeated = end(&pool, &caller, started.call.id).await.unwrap();
    assert_eq!(repeated.state, CallState::Ended);
    assert_eq!(repeated.revision, ended.revision);
}
