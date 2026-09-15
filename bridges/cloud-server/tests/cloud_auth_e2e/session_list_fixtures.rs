use sqlx_core::query::query;

pub(super) async fn seed_stale_group(
    pool: &sqlx_postgres::PgPool,
    account_id: &str,
    session_id: Option<&str>,
    space_id: Option<&str>,
    membership: &str,
) -> uuid::Uuid {
    let id = uuid::Uuid::now_v7();
    query(
        "INSERT INTO cloud_chat_conversations \
         (conversation_id, kind, created_by_account_id, client_operation_id, \
          creation_fingerprint, legacy_session_id, group_space_id) \
         VALUES ($1, 'group', $2, $1, 'stale-group-test', $3, $4)",
    )
    .bind(id)
    .bind(account_id)
    .bind(session_id)
    .bind(space_id)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_chat_conversation_members \
         (conversation_id, account_id, membership_state, pinned_at, muted_until, marked_unread_at) \
         VALUES ($1, $2, $3, NOW(), 'infinity'::timestamptz, NOW())",
    )
    .bind(id)
    .bind(account_id)
    .bind(membership)
    .execute(pool)
    .await
    .unwrap();
    id
}
