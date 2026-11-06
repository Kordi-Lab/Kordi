//! What account deletion does to conversations
//! (docs/development/account-deletion.md):
//!
//! - A conversation with no other active person is deleted.
//! - A direct conversation loses every message, and the other person is
//!   removed from it, so their devices drop it. The empty row stays only so
//!   that removal can reach their devices through the sync stream.
//! - Any other conversation is kept. A group the person owned passes to the
//!   longest-standing admin, else the longest-standing active member. Their
//!   messages move to the Deleted account stand-in, which joins as a member
//!   who left so clients can name it, and their identity is scrubbed from
//!   every stored message there. Remaining members get the same
//!   `membership.updated` event as for any membership change.
//!
//! Everything runs in the caller's transaction, before the account row is
//! deleted.

use std::collections::{BTreeSet, HashSet};

use super::account_scrub::AccountScrub;
use super::support::*;
use super::*;
use crate::deleted_account::{DELETED_ACCOUNT_ID, DELETED_DISPLAY_NAME};

/// At most this many changed messages per kept conversation are announced
/// to members' devices; older ones are already changed in storage and load
/// that way.
const MAX_ANNOUNCED_MESSAGES: i64 = 200;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ConversationRemoval {
    pub deleted: usize,
    pub direct: usize,
    pub kept: usize,
    pub transferred: usize,
}

type ConversationRow = (Uuid, String, Option<String>, Option<String>, i64);

pub async fn remove_account_from_conversations(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    removed_attachments: &HashSet<String>,
) -> Result<ConversationRemoval, StoreError> {
    crate::deleted_account::ensure_account(transaction).await?;
    let service = crate::system_account::service_account_ids();
    // Their reactions and their attachments leave every message first, so
    // the snapshots sent below no longer carry them.
    query("DELETE FROM cloud_chat_message_reactions WHERE account_id = $1")
        .bind(account_id)
        .execute(&mut **transaction)
        .await?;
    let removed: Vec<String> = removed_attachments.iter().cloned().collect();
    query("DELETE FROM cloud_chat_message_attachments WHERE attachment_id = ANY($1)")
        .bind(&removed)
        .execute(&mut **transaction)
        .await?;

    // Every conversation they belong to or wrote in, with how many other
    // people are still active in it.
    let conversations: Vec<ConversationRow> = query_as(
        "SELECT c.conversation_id, c.kind, me.role, me.membership_state, \
                (SELECT COUNT(*) FROM cloud_chat_conversation_members other \
                 WHERE other.conversation_id = c.conversation_id AND other.account_id <> $1 \
                   AND other.membership_state = 'active' \
                   AND NOT (other.account_id = ANY($2))) \
         FROM cloud_chat_conversations c \
         LEFT JOIN cloud_chat_conversation_members me \
           ON me.conversation_id = c.conversation_id AND me.account_id = $1 \
         WHERE me.account_id IS NOT NULL \
            OR EXISTS (SELECT 1 FROM cloud_chat_messages m \
                       WHERE m.conversation_id = c.conversation_id AND m.sender_account_id = $1) \
         ORDER BY c.conversation_id \
         FOR UPDATE OF c",
    )
    .bind(account_id)
    .bind(&service)
    .fetch_all(&mut **transaction)
    .await?;

    let mut outcome = ConversationRemoval::default();
    let mut deleted = Vec::new();
    let scrub = AccountScrub {
        account_id,
        replacement_id: DELETED_ACCOUNT_ID,
        replacement_name: DELETED_DISPLAY_NAME,
        removed_attachments,
    };
    for (conversation_id, kind, role, state, others) in conversations {
        if others == 0 {
            deleted.push(conversation_id);
        } else if kind == "direct" {
            empty_direct_conversation(transaction, conversation_id, account_id).await?;
            outcome.direct += 1;
        } else {
            let owner = role.as_deref() == Some("owner") && state.as_deref() == Some("active");
            if owner && hand_over(transaction, conversation_id, account_id).await? {
                outcome.transferred += 1;
            }
            keep_conversation(transaction, conversation_id, account_id, &scrub).await?;
            outcome.kept += 1;
        }
    }
    if !deleted.is_empty() {
        query("DELETE FROM cloud_chat_conversations WHERE conversation_id = ANY($1)")
            .bind(&deleted)
            .execute(&mut **transaction)
            .await?;
    }
    outcome.deleted = deleted.len();
    // Conversations they created but no longer take part in name the
    // stand-in as creator. Any conversation still in their personal
    // organization moves to its owner's personal organization, or to none
    // when it has no owner left.
    query(
        "UPDATE cloud_chat_conversations SET created_by_account_id = $2 \
         WHERE created_by_account_id = $1",
    )
    .bind(account_id)
    .bind(DELETED_ACCOUNT_ID)
    .execute(&mut **transaction)
    .await?;
    query(
        "UPDATE cloud_chat_conversations SET organization_id = cloud_personal_organization( \
           NULLIF(cloud_conversation_owner(conversation_id), $2)) \
         WHERE organization_id = cloud_personal_organization($1)",
    )
    .bind(account_id)
    .bind(DELETED_ACCOUNT_ID)
    .execute(&mut **transaction)
    .await?;
    // Plan cards they made and requests they wrote to other people's agent
    // sessions stay where they are, from the stand-in.
    for table in ["cloud_plan_cards", "cloud_agent_subsession_chat"] {
        let column = if table == "cloud_plan_cards" {
            "created_by_account_id"
        } else {
            "sender_account_id"
        };
        query(&format!(
            "UPDATE {table} SET {column} = $2 WHERE {column} = $1"
        ))
        .bind(account_id)
        .bind(DELETED_ACCOUNT_ID)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(outcome)
}

/// Deletes every message of a direct conversation and removes the other
/// person, telling their devices.
async fn empty_direct_conversation(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), StoreError> {
    // Synced copies of its messages go too; only the removal below is sent.
    for table in [
        "cloud_chat_user_sync_events",
        "cloud_chat_messages",
        "cloud_plan_cards",
        "cloud_calls",
    ] {
        query(&format!("DELETE FROM {table} WHERE conversation_id = $1"))
            .bind(conversation_id)
            .execute(&mut **transaction)
            .await?;
    }
    query(
        "DELETE FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    let version: (i32,) = query_as(
        "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now(), \
           created_by_account_id = CASE WHEN created_by_account_id = $2 THEN $3 \
             ELSE created_by_account_id END \
         WHERE conversation_id = $1 RETURNING version",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(DELETED_ACCOUNT_ID)
    .fetch_one(&mut **transaction)
    .await?;
    let peers: Vec<(String,)> = query_as(
        "UPDATE cloud_chat_conversation_members \
         SET membership_state = 'removed', left_at = now(), version = version + 1 \
         WHERE conversation_id = $1 AND membership_state = 'active' \
         RETURNING account_id",
    )
    .bind(conversation_id)
    .fetch_all(&mut **transaction)
    .await?;
    for (peer,) in peers {
        insert_sync_event(
            transaction,
            &peer,
            "membership.removed",
            Some(conversation_id),
            Some(conversation_id),
            Some(version.0),
            &json!({
                "conversation_id": conversation_id,
                "account_id": peer,
                "membership_state": "removed",
                "version": version.0,
            }),
        )
        .await?;
    }
    Ok(())
}

/// Passes the conversation to the longest-standing admin, else the
/// longest-standing active member. Returns whether it changed hands.
async fn hand_over(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<bool, StoreError> {
    let service = crate::system_account::service_account_ids();
    let heir: Option<(String,)> = query_as(
        "SELECT account_id FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id <> $2 AND membership_state = 'active' \
           AND NOT (account_id = ANY($3)) \
         ORDER BY (role = 'admin') DESC, joined_at ASC, account_id ASC \
         LIMIT 1",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(&service)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((heir,)) = heir else {
        return Ok(false);
    };
    // Demote first, so the conversation has one owner at every step, as a
    // transfer does.
    for (member, role) in [(account_id, "admin"), (heir.as_str(), "owner")] {
        query(
            "UPDATE cloud_chat_conversation_members SET role = $3, version = version + 1 \
             WHERE conversation_id = $1 AND account_id = $2",
        )
        .bind(conversation_id)
        .bind(member)
        .bind(role)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(true)
}

async fn keep_conversation(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
    scrub: &AccountScrub<'_>,
) -> Result<(), StoreError> {
    let wrote: (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_messages \
         WHERE conversation_id = $1 AND sender_account_id = $2)",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(&mut **transaction)
    .await?;
    if wrote.0 {
        // The stand-in joins as a member who left, so member lists name
        // the sender of the kept messages.
        query(
            "INSERT INTO cloud_chat_conversation_members \
             (conversation_id, account_id, role, membership_state, joined_at, left_at) \
             SELECT $1, $2, 'member', 'left', \
                    COALESCE((SELECT joined_at FROM cloud_chat_conversation_members \
                              WHERE conversation_id = $1 AND account_id = $3), now()), now() \
             ON CONFLICT (conversation_id, account_id) DO NOTHING",
        )
        .bind(conversation_id)
        .bind(DELETED_ACCOUNT_ID)
        .bind(account_id)
        .execute(&mut **transaction)
        .await?;
    }
    query(
        "DELETE FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2",
    )
    .bind(conversation_id)
    .bind(account_id)
    .execute(&mut **transaction)
    .await?;
    let mut changed: BTreeSet<Uuid> = query_as::<_, (Uuid,)>(
        "UPDATE cloud_chat_messages SET sender_account_id = $3, version = version + 1 \
         WHERE conversation_id = $1 AND sender_account_id = $2 RETURNING message_id",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(DELETED_ACCOUNT_ID)
    .fetch_all(&mut **transaction)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();
    // Group envelopes name every participant, so each one is read; other
    // content only when it names the account.
    let stored: Vec<(Uuid, Value)> = query_as(
        "SELECT message_id, content FROM cloud_chat_messages \
         WHERE conversation_id = $1 \
           AND (strpos(content::text, 'kordi-cloud-group:') > 0 \
                OR strpos(content::text, $2) > 0 OR sender_account_id = $3)",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(DELETED_ACCOUNT_ID)
    .fetch_all(&mut **transaction)
    .await?;
    let mut ids = Vec::new();
    let mut contents = Vec::new();
    for (message_id, mut content) in stored {
        if scrub.scrub(&mut content) {
            ids.push(message_id);
            contents.push(content);
        }
    }
    if !ids.is_empty() {
        query(
            "UPDATE cloud_chat_messages message \
             SET content = scrubbed.content, version = message.version + 1 \
             FROM UNNEST($1::UUID[], $2::JSONB[]) AS scrubbed(message_id, content) \
             WHERE message.message_id = scrubbed.message_id",
        )
        .bind(&ids)
        .bind(&contents)
        .execute(&mut **transaction)
        .await?;
        changed.extend(ids);
    }
    query(
        "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now(), \
           created_by_account_id = CASE WHEN created_by_account_id = $2 THEN $3 \
             ELSE created_by_account_id END \
         WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(DELETED_ACCOUNT_ID)
    .execute(&mut **transaction)
    .await?;
    // A conversation in their personal organization moves to its new
    // owner's personal organization before members hear about it.
    query(
        "UPDATE cloud_chat_conversations SET organization_id = cloud_personal_organization( \
           NULLIF(cloud_conversation_owner(conversation_id), $3)) \
         WHERE conversation_id = $1 AND organization_id = cloud_personal_organization($2)",
    )
    .bind(conversation_id)
    .bind(account_id)
    .bind(DELETED_ACCOUNT_ID)
    .execute(&mut **transaction)
    .await?;
    announce(transaction, conversation_id, &changed).await
}

/// Tells every active member's devices about the new member list, then
/// about the newest changed messages.
async fn announce(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    changed: &BTreeSet<Uuid>,
) -> Result<(), StoreError> {
    let projections = load_active_conversation_projections(transaction, conversation_id).await?;
    for (member, projection) in &projections {
        insert_sync_event(
            transaction,
            member,
            "membership.updated",
            Some(conversation_id),
            Some(conversation_id),
            Some(projection.version),
            &json!({ "conversation": projection }),
        )
        .await?;
    }
    let changed: Vec<Uuid> = changed.iter().copied().collect();
    let newest: Vec<(Uuid,)> = query_as(
        "SELECT message_id FROM cloud_chat_messages WHERE message_id = ANY($1) \
         ORDER BY conversation_sequence DESC LIMIT $2",
    )
    .bind(&changed)
    .bind(MAX_ANNOUNCED_MESSAGES)
    .fetch_all(&mut **transaction)
    .await?;
    for (message_id,) in newest.into_iter().rev() {
        let message = load_message(transaction, message_id).await?;
        let payloads = projections
            .iter()
            .map(|(member, conversation)| {
                (
                    member.clone(),
                    json!({ "message": &message, "conversation": conversation }),
                )
            })
            .collect();
        insert_sync_event_fanout(
            transaction,
            "message.updated",
            Some(conversation_id),
            Some(message.id),
            Some(message.version),
            payloads,
        )
        .await?;
    }
    Ok(())
}
