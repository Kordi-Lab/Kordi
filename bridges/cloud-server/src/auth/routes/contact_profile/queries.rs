//! Reads behind the contact profile. Every count is a plain query over the
//! direct conversation, group memberships, and shared documents of the two
//! accounts; none needs an index of its own at today's sizes.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::types::{SharedGroup, SharedSummary};

/// Groups in common returned on a profile.
const MAX_GROUPS: i64 = 20;

type AccountTuple = (String, i64, Option<String>, Option<String>, Option<String>);

pub(super) struct AccountRow {
    pub account_id: String,
    pub kordi_id: i64,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub about: Option<String>,
}

pub(super) async fn account(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<AccountRow>, sqlx_core::Error> {
    let row: Option<AccountTuple> = query_as(
        "SELECT account_id, public_account_number, display_name, avatar_url, about \
         FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(account_id, kordi_id, display_name, avatar_url, about)| AccountRow {
            account_id,
            kordi_id,
            display_name,
            avatar_url,
            about,
        },
    ))
}

/// When `viewer` added `peer`, if `peer` is in their contacts.
pub(super) async fn contact_since(
    pool: &PgPool,
    viewer: &str,
    peer: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(
        "SELECT created_at FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2",
    )
    .bind(viewer)
    .bind(peer)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(created_at,)| created_at))
}

/// Messages of the person-to-person direct conversation between `$1` (the
/// viewer) and `$2` (not a chat with either one's agent) that the viewer still sees: not deleted, not deleted for the viewer, and
/// not a hidden synchronization record.
const DIRECT_MESSAGES_CTE: &str = "WITH direct AS ( \
        SELECT conversation.conversation_id, conversation.legacy_session_id \
        FROM cloud_chat_conversations conversation \
        WHERE conversation.kind = 'direct' \
          AND conversation.legacy_session_id LIKE 'session:direct-person:%' \
          AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                      WHERE member.conversation_id = conversation.conversation_id \
                        AND member.account_id = $1) \
          AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                      WHERE member.conversation_id = conversation.conversation_id \
                        AND member.account_id = $2) \
    ), visible AS ( \
        SELECT message.message_id, message.attention_content \
        FROM cloud_chat_messages message \
        WHERE message.conversation_id IN (SELECT conversation_id FROM direct) \
          AND message.deleted_at IS NULL \
          AND COALESCE(message.attention_content->>'hidden', 'false') <> 'true' \
          AND NOT EXISTS (SELECT 1 FROM cloud_chat_message_visibility hidden \
                          WHERE hidden.message_id = message.message_id \
                            AND hidden.account_id = $1) \
    )";

pub(super) async fn shared(
    pool: &PgPool,
    viewer: &str,
    peer: &str,
) -> Result<SharedSummary, sqlx_core::Error> {
    let (media_count, link_count, document_count): (i64, i64, i64) = query_as(&format!(
        "{DIRECT_MESSAGES_CTE} SELECT \
           (SELECT COUNT(*) FROM visible WHERE EXISTS ( \
                SELECT 1 FROM cloud_chat_message_attachments link \
                WHERE link.message_id = visible.message_id)), \
           (SELECT COUNT(*) FROM visible \
            WHERE COALESCE(visible.attention_content->>'text', '') LIKE '%http://%' \
               OR COALESCE(visible.attention_content->>'text', '') LIKE '%https://%'), \
           (SELECT COUNT(DISTINCT share.attachment_id) FROM cloud_document_shares share \
            WHERE share.revoked_at IS NULL \
              AND share.owner_account_id IN ($1, $2) \
              AND (share.session_id IN (SELECT legacy_session_id FROM direct) \
                   OR EXISTS (SELECT 1 FROM cloud_chat_message_attachments link \
                              JOIN visible ON visible.message_id = link.message_id \
                              WHERE link.attachment_id = share.attachment_id)))"
    ))
    .bind(viewer)
    .bind(peer)
    .fetch_one(pool)
    .await?;
    Ok(SharedSummary {
        media_count,
        link_count,
        document_count,
        groups: groups_in_common(pool, viewer, peer).await?,
    })
}

/// Groups both accounts are active members of, newest first. A group is a
/// group space; its channels are conversations that share the space id.
async fn groups_in_common(
    pool: &PgPool,
    viewer: &str,
    peer: &str,
) -> Result<Vec<SharedGroup>, sqlx_core::Error> {
    let rows: Vec<(String, Option<String>, Option<String>)> = query_as(
        "WITH channels AS ( \
             SELECT COALESCE(conversation.group_space_id, \
                        regexp_replace(COALESCE(conversation.legacy_session_id, \
                            conversation.conversation_id::text), '^(group:)+', '')) AS space_id, \
                    conversation.group_space_id, \
                    COALESCE(NULLIF(btrim(conversation.group_title), ''), \
                             NULLIF(btrim(conversation.shared_title), '')) AS title, \
                    conversation.group_avatar, conversation.created_at \
             FROM cloud_chat_conversations conversation \
             JOIN cloud_chat_conversation_members mine \
               ON mine.conversation_id = conversation.conversation_id \
              AND mine.account_id = $1 AND mine.membership_state = 'active' \
             JOIN cloud_chat_conversation_members theirs \
               ON theirs.conversation_id = conversation.conversation_id \
              AND theirs.account_id = $2 AND theirs.membership_state = 'active' \
             WHERE conversation.kind = 'group' \
         ), spaces AS ( \
             SELECT DISTINCT ON (space_id) space_id, title, \
                    MAX(created_at) OVER (PARTITION BY space_id) AS newest, \
                    (SELECT channel.group_avatar->>'imageUrl' FROM channels channel \
                     WHERE channel.space_id = channels.space_id \
                       AND channel.group_avatar->>'imageUrl' IS NOT NULL \
                     ORDER BY (channel.group_avatar->>'updatedAtMs')::bigint DESC NULLS LAST \
                     LIMIT 1) AS avatar_url \
             FROM channels \
             ORDER BY space_id, (title IS NULL), created_at ASC \
         ) \
         SELECT space_id, title, avatar_url FROM spaces \
         ORDER BY newest DESC, space_id ASC LIMIT $3",
    )
    .bind(viewer)
    .bind(peer)
    .bind(MAX_GROUPS)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(group_id, title, avatar_url)| SharedGroup {
            group_id,
            title,
            avatar_url,
        })
        .collect())
}
