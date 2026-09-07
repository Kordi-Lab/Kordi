use serde::{Deserialize, Serialize};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgConnection;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionVisibilitySnapshot {
    pub hidden_session_ids: Vec<String>,
    pub deleted_session_ids: Vec<String>,
    pub pinned_session_ids: Vec<String>,
    pub muted_session_ids: Vec<String>,
    pub unread_session_ids: Vec<String>,
    pub pinned_group_space_ids: Vec<String>,
}

/// Use the caller's transaction so visibility and the bootstrap cursor describe
/// the same account snapshot, rather than racing an independent HTTP refresh.
pub async fn load(
    conn: &mut PgConnection,
    account_id: &str,
) -> Result<SessionVisibilitySnapshot, sqlx_core::error::Error> {
    let mut snapshot = SessionVisibilitySnapshot::default();
    let rows: Vec<(String, Option<String>, Option<String>)> = query_as(
        "SELECT session_id, hidden_at, deleted_at FROM cloud_account_session_visibility \
         WHERE account_id=$1 AND (hidden_at IS NOT NULL OR deleted_at IS NOT NULL) \
         ORDER BY updated_at, session_id",
    )
    .bind(account_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, hidden, deleted) in rows {
        if deleted.is_some() {
            snapshot.deleted_session_ids.push(id);
        } else if hidden.is_some() {
            snapshot.hidden_session_ids.push(id);
        }
    }
    let preferences: Vec<(String, bool, bool, bool)> = query_as(
        "SELECT COALESCE(c.legacy_session_id,c.conversation_id::text), \
         m.pinned_at IS NOT NULL, m.muted_until IS NOT NULL AND m.muted_until>NOW(), \
         m.marked_unread_at IS NOT NULL FROM cloud_chat_conversation_members m \
         JOIN cloud_chat_conversations c ON c.conversation_id=m.conversation_id \
         WHERE m.account_id=$1 AND m.membership_state='active' \
         ORDER BY c.updated_at DESC,c.conversation_id",
    )
    .bind(account_id)
    .fetch_all(&mut *conn)
    .await?;
    for (id, pinned, muted, unread) in preferences {
        if pinned {
            snapshot.pinned_session_ids.push(id.clone());
        }
        if muted {
            snapshot.muted_session_ids.push(id.clone());
        }
        if unread {
            snapshot.unread_session_ids.push(id);
        }
    }
    snapshot.pinned_group_space_ids = query_as::<_, (String,)>(
        "SELECT group_space_id FROM cloud_account_group_space_preferences \
         WHERE account_id=$1 AND pinned_at IS NOT NULL ORDER BY updated_at DESC,group_space_id",
    )
    .bind(account_id)
    .fetch_all(conn)
    .await?
    .into_iter()
    .map(|row| row.0)
    .collect();
    Ok(snapshot)
}
