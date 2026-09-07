use super::support::*;
use super::*;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ThreadAttention {
    pub conversation_id: Uuid,
    pub session_id: String,
    pub unread_count: i64,
    pub thread_count: i64,
    pub thread_unread_count: i64,
    pub next_root_id: Option<Uuid>,
    pub next_message_id: Option<Uuid>,
    pub muted: bool,
}

type ThreadAttentionRow = (
    Uuid,
    String,
    i64,
    i64,
    i64,
    Option<Uuid>,
    Option<Uuid>,
    bool,
);

pub async fn thread_attention(
    pool: &PgPool,
    account: &str,
    after: Option<Uuid>,
) -> Result<Vec<ThreadAttention>, StoreError> {
    let rows: Vec<ThreadAttentionRow> = query_as(
        r#"WITH conversations AS (
            SELECT c.conversation_id, COALESCE(c.legacy_session_id,c.conversation_id::text) session_id, viewer.last_read_sequence, COALESCE(viewer.muted_until>NOW(),false) muted
            FROM cloud_chat_conversations c JOIN cloud_chat_conversation_members viewer USING(conversation_id)
            WHERE viewer.account_id=$1 AND viewer.membership_state='active' AND ($2::uuid IS NULL OR c.conversation_id>$2)
            ORDER BY c.conversation_id LIMIT 200
        ), unread AS (
            SELECT m.conversation_id,m.message_id,m.thread_root_message_id,m.conversation_sequence
            FROM conversations c JOIN cloud_chat_messages m USING(conversation_id)
            LEFT JOIN cloud_chat_thread_read_cursors r ON r.conversation_id=m.conversation_id AND r.root_message_id=m.thread_root_message_id AND r.account_id=$1
            WHERE m.deleted_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=$1)
              AND (m.sender_account_id<>$1 OR m.attention_content->>'senderKind'='agent' OR m.attention_content->>'kind'='agent-response')
              AND COALESCE(m.attention_content->>'hidden','false')<>'true'
              AND COALESCE(m.attention_content->>'synchronizationOnly','false')<>'true'
              AND m.message_kind !~ '(control|snapshot|cursor|presence|identity)'
              AND (length(trim(COALESCE(m.attention_content->>'text','')))>0
                   OR jsonb_array_length(CASE WHEN jsonb_typeof(m.content->'legacy_attachments')='array' THEN m.content->'legacy_attachments' ELSE '[]'::jsonb END)>0
                   OR EXISTS(SELECT 1 FROM cloud_chat_message_attachments a WHERE a.message_id=m.message_id)
                   OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.content->'blocks')='array' THEN m.content->'blocks' ELSE '[]'::jsonb END) b WHERE b->>'type'='voice'))
              AND m.conversation_sequence > CASE WHEN m.thread_root_message_id IS NULL THEN c.last_read_sequence ELSE COALESCE(r.last_read_sequence,0) END
              AND (m.thread_root_message_id IS NULL OR EXISTS(
                  SELECT 1 FROM cloud_chat_messages root WHERE root.message_id=m.thread_root_message_id AND root.deleted_at IS NULL
                  AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=root.message_id AND v.account_id=$1)))
        ) SELECT c.conversation_id,c.session_id,COUNT(u.message_id),COUNT(DISTINCT u.thread_root_message_id),COUNT(u.message_id) FILTER(WHERE u.thread_root_message_id IS NOT NULL),
            (array_agg(u.thread_root_message_id ORDER BY u.conversation_sequence) FILTER(WHERE u.thread_root_message_id IS NOT NULL))[1],
            (array_agg(u.message_id ORDER BY u.conversation_sequence) FILTER(WHERE u.thread_root_message_id IS NOT NULL))[1],c.muted
        FROM conversations c LEFT JOIN unread u USING(conversation_id)
        GROUP BY c.conversation_id,c.session_id,c.muted ORDER BY c.conversation_id"#
    ).bind(account).bind(after).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                conversation_id,
                session_id,
                unread_count,
                thread_count,
                thread_unread_count,
                next_root_id,
                next_message_id,
                muted,
            )| ThreadAttention {
                conversation_id,
                session_id,
                unread_count,
                thread_count,
                thread_unread_count,
                next_root_id,
                next_message_id,
                muted,
            },
        )
        .collect())
}

#[derive(Debug, Serialize)]
pub struct ThreadPage {
    pub root: MessageSnapshot,
    pub is_thread: bool,
    pub messages: Vec<MessageSnapshot>,
    pub first_unread_message_id: Option<Uuid>,
    pub next_after_sequence: Option<i64>,
}

pub async fn thread_page(
    pool: &PgPool,
    account: &str,
    conversation: Uuid,
    message: Uuid,
    after: Option<i64>,
) -> Result<ThreadPage, StoreError> {
    if after.is_some_and(|sequence| sequence < 0) {
        return Err(StoreError::InvalidInput(
            "thread sequence must be nonnegative",
        ));
    }
    let mut tx = pool.begin().await?;
    query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    require_active_member(&mut tx, conversation, account).await?;
    let row: Option<(Uuid,Option<Uuid>,i64)>=query_as("SELECT message_id,thread_root_message_id,conversation_sequence FROM cloud_chat_messages m WHERE conversation_id=$1 AND (message_id=$2 OR client_message_id=$2) AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=$3) ORDER BY (message_id=$2) DESC LIMIT 1")
        .bind(conversation).bind(message).bind(account).fetch_optional(&mut *tx).await?;
    let (id, root, target_sequence) = row.ok_or(StoreError::NotFound)?;
    let is_thread = root.is_some() || after.is_some();
    let root_id = root.unwrap_or(id);
    let accessible: Option<(Uuid,)> = query_as("SELECT message_id FROM cloud_chat_messages m WHERE message_id=$1 AND conversation_id=$2 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=$3)")
        .bind(root_id).bind(conversation).bind(account).fetch_optional(&mut *tx).await?;
    if accessible.is_none() {
        return Err(StoreError::NotFound);
    }
    let root = load_message(&mut tx, root_id).await?;
    let read:Option<(i64,)>=query_as("SELECT last_read_sequence FROM cloud_chat_thread_read_cursors WHERE conversation_id=$1 AND root_message_id=$2 AND account_id=$3")
        .bind(conversation).bind(root_id).bind(account).fetch_optional(&mut *tx).await?;
    let cursor = read.map(|r| r.0).unwrap_or(0);
    let ids:Vec<(Uuid,i64,String)>=query_as("SELECT message_id,conversation_sequence,sender_account_id FROM cloud_chat_messages m WHERE conversation_id=$1 AND thread_root_message_id=$2 AND conversation_sequence>$3 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=$4) ORDER BY conversation_sequence LIMIT 101")
        .bind(conversation).bind(root_id).bind(after.unwrap_or(if is_thread { cursor.min(target_sequence.saturating_sub(1)) } else { cursor })).bind(account).fetch_all(&mut *tx).await?;
    let more = ids.len() > 100;
    let mut messages = Vec::new();
    for (id, _, _) in ids.into_iter().take(100) {
        messages.push(load_message(&mut tx, id).await?);
    }
    let first_unread_message_id = messages
        .iter()
        .find(|m| {
            m.conversation_sequence > cursor
                && (m.sender_account_id != account
                    || crate::notifications::is_agent_authored_message(m))
                && crate::notifications::is_frontend_visible_message(m)
        })
        .map(|m| m.id);
    let next_after_sequence = if more {
        messages.last().map(|m| m.conversation_sequence)
    } else {
        None
    };
    tx.commit().await?;
    Ok(ThreadPage {
        root,
        is_thread,
        messages,
        first_unread_message_id,
        next_after_sequence,
    })
}
