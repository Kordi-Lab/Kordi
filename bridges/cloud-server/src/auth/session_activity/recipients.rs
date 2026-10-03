//! Who hears about task and artifact activity in a session.
//!
//! The client names the participants of its activity, but the server decides
//! who receives it: the sender, and the active members of the session's
//! conversation that the sender may reach. A block in either direction stops
//! it, and so does a direct or AI chat with someone who is no longer the
//! sender's contact, as for chat messages.

use std::collections::BTreeSet;

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::chat_sync::store::StoreError;

/// Publishes one activity event to the session's allowed recipients.
pub(super) async fn publish_chat_event(
    pool: &PgPool,
    participant_account_ids: &[String],
    sender_account_id: &str,
    session_id: &str,
    event_type: &str,
    payload: serde_json::Value,
) -> Result<(), StoreError> {
    let conversation_id =
        crate::chat_sync::store::conversation_id_for_session(pool, sender_account_id, session_id)
            .await?;
    let candidates = cloud_activity_recipient_ids(sender_account_id, participant_account_ids);
    let recipients =
        allowed_recipients(pool, conversation_id, sender_account_id, &candidates).await?;
    crate::chat_sync::store::publish_user_sync_events(
        pool,
        &recipients,
        event_type,
        conversation_id,
        payload,
    )
    .await
}

/// The named participants plus the sender, trimmed and without duplicates.
fn cloud_activity_recipient_ids(
    owner_account_id: &str,
    participant_account_ids: &[String],
) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for value in participant_account_ids {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            ids.insert(trimmed.to_string());
        }
    }
    let owner = owner_account_id.trim();
    if !owner.is_empty() {
        ids.insert(owner.to_string());
    }
    ids.into_iter().collect()
}

/// The sender, plus each candidate who is an active member of the sender's
/// conversation for the session and whom the sender may reach there. Without
/// a conversation the activity stays with the sender.
async fn allowed_recipients(
    pool: &PgPool,
    conversation_id: Option<Uuid>,
    sender_account_id: &str,
    candidates: &[String],
) -> Result<Vec<String>, sqlx_core::Error> {
    let mut recipients = BTreeSet::from([sender_account_id.to_string()]);
    if let Some(conversation_id) = conversation_id {
        let rows: Vec<(String,)> = query_as(
            "SELECT member.account_id \
             FROM cloud_chat_conversation_members member \
             JOIN cloud_chat_conversations conversation \
               ON conversation.conversation_id = member.conversation_id \
             WHERE member.conversation_id = $1 \
               AND member.membership_state = 'active' \
               AND member.account_id = ANY($2) \
               AND member.account_id <> $3 \
               AND NOT cloud_accounts_blocked_either_way($3, member.account_id) \
               AND (conversation.kind = 'group' \
                    OR cloud_accounts_are_contacts($3, member.account_id) \
                    OR cloud_account_is_service($3) \
                    OR cloud_account_is_service(member.account_id))",
        )
        .bind(conversation_id)
        .bind(candidates)
        .bind(sender_account_id)
        .fetch_all(pool)
        .await?;
        recipients.extend(rows.into_iter().map(|(account_id,)| account_id));
    }
    Ok(recipients.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx_core::query::query;

    #[test]
    fn cloud_activity_recipient_ids_exclude_duplicates_and_empty_values() {
        let recipients = cloud_activity_recipient_ids(
            "acct_owner",
            &[
                "acct_b".to_string(),
                "acct_owner".to_string(),
                " ".to_string(),
                "acct_b".to_string(),
            ],
        );

        assert_eq!(
            recipients,
            vec!["acct_b".to_string(), "acct_owner".to_string()]
        );
    }

    async fn account(pool: &PgPool, label: &str) -> String {
        let account_id = format!("acct_activity_{label}_{}", Uuid::new_v4().simple());
        query(
            "INSERT INTO cloud_accounts(account_id, created_at, updated_at, avatar_source, \
               avatar_style, avatar_seed, avatar_renderer_version, avatar_version, \
               avatar_updated_at) \
             VALUES ($1, $2, $2, 'generated', 'lorelei', $1, 'test', 1, $2)",
        )
        .bind(&account_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .unwrap();
        account_id
    }

    async fn conversation(pool: &PgPool, kind: &str, members: &[&String]) -> Uuid {
        let id = Uuid::now_v7();
        query(
            "INSERT INTO cloud_chat_conversations \
             (conversation_id, kind, created_by_account_id, client_operation_id, \
              creation_fingerprint, legacy_session_id) \
             VALUES ($1, $2, $3, $1, 'test', $4)",
        )
        .bind(id)
        .bind(kind)
        .bind(members[0])
        .bind(if kind == "direct" {
            format!("session:direct-person:{id}")
        } else {
            format!("session:group:{id}")
        })
        .execute(pool)
        .await
        .unwrap();
        for member in members {
            query(
                "INSERT INTO cloud_chat_conversation_members (conversation_id, account_id, role) \
                 VALUES ($1, $2, 'member')",
            )
            .bind(id)
            .bind(member)
            .execute(pool)
            .await
            .unwrap();
        }
        id
    }

    #[tokio::test]
    async fn activity_reaches_only_members_the_sender_may_reach() {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = crate::pg::init_pool(&url).await.expect("init test pool");
        let sender = account(&pool, "sender").await;
        let member = account(&pool, "member").await;
        let blocker = account(&pool, "blocker").await;
        let outsider = account(&pool, "outsider").await;
        let group = conversation(&pool, "group", &[&sender, &member, &blocker]).await;
        let direct = conversation(&pool, "direct", &[&sender, &member]).await;
        query(
            "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) \
             VALUES ($1, $2)",
        )
        .bind(&blocker)
        .bind(&sender)
        .execute(&pool)
        .await
        .unwrap();
        let candidates = vec![
            sender.clone(),
            member.clone(),
            blocker.clone(),
            outsider.clone(),
        ];
        let mut expected = vec![sender.clone(), member.clone()];
        expected.sort();
        assert_eq!(
            allowed_recipients(&pool, Some(group), &sender, &candidates)
                .await
                .unwrap(),
            expected
        );
        // A direct chat with someone who is not a contact reaches only the sender.
        assert_eq!(
            allowed_recipients(&pool, Some(direct), &sender, &candidates)
                .await
                .unwrap(),
            vec![sender.clone()]
        );
        query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, now()::text), ($2, $1, now()::text)",
        )
        .bind(&sender)
        .bind(&member)
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(
            allowed_recipients(&pool, Some(direct), &sender, &candidates)
                .await
                .unwrap(),
            expected
        );
        assert_eq!(
            allowed_recipients(&pool, None, &sender, &candidates)
                .await
                .unwrap(),
            vec![sender.clone()]
        );
    }
}
