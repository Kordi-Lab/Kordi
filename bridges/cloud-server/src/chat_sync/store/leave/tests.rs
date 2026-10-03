//! PiP stays in a group when people leave it, and is never made its owner.

use super::*;
use crate::chat_sync::models::CreateConversationRequest;

async fn test_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

async fn account(pool: &PgPool, account_id: &str) {
    query(
        "INSERT INTO cloud_accounts(account_id, created_at, updated_at, avatar_source, \
           avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, $2, $2, 'generated', 'lorelei', $1, 'test', 1, $2) \
         ON CONFLICT (account_id) DO NOTHING",
    )
    .bind(account_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn pip_stays_when_the_last_person_leaves_and_never_becomes_owner() {
    let Some(pool) = test_pool().await else {
        return;
    };
    let pip = crate::pip::test_service_account();
    account(&pool, pip).await;
    let suffix = Uuid::new_v4().simple().to_string();
    let (owner, member) = (
        format!("acct_leave_owner_{suffix}"),
        format!("acct_leave_member_{suffix}"),
    );
    account(&pool, &owner).await;
    account(&pool, &member).await;
    query(
        "INSERT INTO cloud_contacts(account_id, peer_account_id, created_at) \
         VALUES ($1, $2, $3), ($2, $1, $3)",
    )
    .bind(&owner)
    .bind(&member)
    .bind(chrono::Utc::now().to_rfc3339())
    .execute(&pool)
    .await
    .unwrap();
    let group = crate::chat_sync::store::create_conversation(
        &pool,
        &owner,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Group,
            shared_title: Some("PiP group".to_string()),
            client_session_id: format!("session:group:pip-leave-{suffix}"),
            member_account_ids: vec![member.clone()],
        },
    )
    .await
    .unwrap()
    .value
    .id;
    // PiP joins only while the group's AI access setting turns it on.
    query("UPDATE cloud_chat_ai_policies SET pip_enabled = true WHERE conversation_id = $1")
        .bind(group)
        .execute(&pool)
        .await
        .unwrap();
    assert!(crate::pip::membership::join_conversation(&pool, pip, group)
        .await
        .unwrap());

    let leave = |account_id: String| {
        let pool = pool.clone();
        async move {
            leave_group(
                &pool,
                &account_id,
                group,
                LeaveConversationRequest {
                    client_operation_id: Uuid::now_v7(),
                    successor_account_id: Some(pip.to_string()),
                },
            )
            .await
            .unwrap()
        }
    };
    // The owner suggests PiP; a person becomes the owner instead.
    assert_eq!(
        leave(owner.clone()).await.successor_account_id,
        Some(member.clone())
    );
    // The last person leaves: nobody is promoted and PiP stays.
    assert_eq!(leave(member.clone()).await.successor_account_id, None);
    let rows: Vec<(String, String, String)> = query_as(
        "SELECT account_id, membership_state, role FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 ORDER BY account_id",
    )
    .bind(group)
    .fetch_all(&pool)
    .await
    .unwrap();
    let pip_row = rows.iter().find(|row| row.0 == pip).expect("PiP row");
    assert_eq!(pip_row.1, "active");
    assert_ne!(pip_row.2, "owner");
    assert!(rows
        .iter()
        .filter(|row| row.0 != pip)
        .all(|row| row.1 == "left"));
    // Nothing for PiP's membership reconciliation (`reconcile_groups`) to
    // change. Calling it here would change PiP's membership in groups other
    // tests create, so this checks its selection and its per-conversation
    // join for this group.
    assert!(!crate::pip::membership::mismatched_groups(&pool, pip)
        .await
        .unwrap()
        .iter()
        .any(|(conversation_id, _)| *conversation_id == group));
    assert!(
        !crate::pip::membership::join_conversation(&pool, pip, group)
            .await
            .unwrap()
    );
    let (state,): (String,) = query_as(
        "SELECT membership_state FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(group)
    .bind(&member)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "left");
}
