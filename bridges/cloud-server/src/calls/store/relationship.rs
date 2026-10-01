//! Ending calls when two people stop being contacts.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{end, CallStoreError};

/// Ends every ringing or active call in a direct conversation whose two
/// active members are `a` and `b`. Each call ends through [`end`], so members
/// get the usual `call.updated` event and call activity. Returns how many
/// calls were ended.
pub async fn end_direct_calls_between(
    pool: &PgPool,
    a: &str,
    b: &str,
) -> Result<usize, CallStoreError> {
    let calls: Vec<(Uuid, String)> = query_as(
        "SELECT call.call_id, call.created_by_account_id \
         FROM cloud_calls call \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = call.conversation_id \
         WHERE call.ended_at IS NULL \
           AND conversation.kind = 'direct' \
           AND (SELECT array_agg(member.account_id ORDER BY member.account_id) \
                FROM cloud_chat_conversation_members member \
                WHERE member.conversation_id = conversation.conversation_id \
                  AND member.membership_state = 'active') \
               = ARRAY[least($1::TEXT, $2::TEXT), greatest($1::TEXT, $2::TEXT)] \
         ORDER BY call.call_id",
    )
    .bind(a)
    .bind(b)
    .fetch_all(pool)
    .await?;
    let mut ended = 0;
    for (call_id, created_by) in calls {
        // A meeting can be ended only by its creator; any participant can end
        // a ringing or active voice or video call.
        let actor = if created_by == b { b } else { a };
        end(pool, actor, call_id).await?;
        ended += 1;
    }
    Ok(ended)
}

#[cfg(test)]
mod tests {
    use sqlx_core::query::query;
    use sqlx_core::query_as::query_as;
    use uuid::Uuid;

    use super::super::start;
    use super::end_direct_calls_between;
    use crate::calls::models::{CallKind, StartCallRequest};
    use crate::chat_sync::models::{ConversationKind, CreateConversationRequest};
    use crate::chat_sync::store::create_conversation;

    #[tokio::test]
    async fn only_the_pairs_direct_call_is_ended() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let pool = crate::pg::init_pool(&database_url).await.unwrap();
        let suffix = Uuid::new_v4().simple().to_string();
        let accounts = ["a", "b", "c"].map(|name| format!("acct_end_calls_{name}_{suffix}"));
        let now = chrono::Utc::now().to_rfc3339();
        for account_id in &accounts {
            query(
                "INSERT INTO cloud_accounts \
                 (account_id, display_name, primary_email, created_at, updated_at, \
                  avatar_source, avatar_style, avatar_seed, avatar_renderer_version, \
                  avatar_version, avatar_updated_at) \
                 VALUES ($1, $1, $1 || '@example.test', $2, $2, \
                         'generated', 'lorelei', $1, 'test', 1, $2)",
            )
            .bind(account_id)
            .bind(&now)
            .execute(&pool)
            .await
            .unwrap();
        }
        let [a, b, c] = &accounts;
        for (left, right) in [(a, b), (b, a), (a, c), (c, a), (b, c), (c, b)] {
            query("INSERT INTO cloud_contacts VALUES ($1, $2, $3)")
                .bind(left)
                .bind(right)
                .bind(&now)
                .execute(&pool)
                .await
                .unwrap();
        }
        let conversation = |kind: ConversationKind, session: String, members: Vec<String>| {
            let pool = pool.clone();
            let creator = a.clone();
            async move {
                create_conversation(
                    &pool,
                    &creator,
                    CreateConversationRequest {
                        client_operation_id: Uuid::now_v7(),
                        kind,
                        shared_title: None,
                        client_session_id: session,
                        member_account_ids: members,
                    },
                )
                .await
                .unwrap()
                .value
                .id
            }
        };
        let mut pair = [a.as_str(), b.as_str()];
        pair.sort_unstable();
        let direct_ab = conversation(
            ConversationKind::Direct,
            format!("session:direct-person:{}:{}", pair[0], pair[1]),
            vec![b.clone()],
        )
        .await;
        let mut other_pair = [a.as_str(), c.as_str()];
        other_pair.sort_unstable();
        let direct_ac = conversation(
            ConversationKind::Direct,
            format!("session:direct-person:{}:{}", other_pair[0], other_pair[1]),
            vec![c.clone()],
        )
        .await;
        let group = conversation(
            ConversationKind::Group,
            format!("session:group:{suffix}"),
            vec![b.clone(), c.clone()],
        )
        .await;
        let mut calls = Vec::new();
        for (caller, conversation_id) in [(b, direct_ab), (a, direct_ac), (a, group)] {
            let started = start(
                &pool,
                caller,
                conversation_id,
                StartCallRequest {
                    client_operation_id: Uuid::now_v7(),
                    kind: CallKind::Voice,
                },
            )
            .await
            .unwrap();
            calls.push(started.call.id);
        }

        assert_eq!(end_direct_calls_between(&pool, a, b).await.unwrap(), 1);
        let open: Vec<(Uuid,)> = query_as(
            "SELECT call_id FROM cloud_calls WHERE call_id = ANY($1) AND ended_at IS NULL \
             ORDER BY call_id",
        )
        .bind(&calls)
        .fetch_all(&pool)
        .await
        .unwrap();
        let mut expected = vec![calls[1], calls[2]];
        expected.sort();
        assert_eq!(
            open.into_iter().map(|(id,)| id).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(end_direct_calls_between(&pool, b, a).await.unwrap(), 0);
    }
}
