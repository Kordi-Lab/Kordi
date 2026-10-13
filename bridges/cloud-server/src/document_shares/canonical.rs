//! Canonical documents and their forwarded copies.
//!
//! Forwarding re-uploads an attachment under the sender's account. The copy
//! records `document_source_attachment_id`, and every document route works on
//! the end of that chain, the canonical attachment, after checking access on
//! the id it was given. The "family" of a canonical document is the document
//! plus every copy whose chain reaches it.

use std::collections::{HashMap, HashSet};

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::access::DocumentRecord;
use super::model::{DocumentFormat, Viewer};

/// Longest chain followed; one hop in practice.
pub(crate) const MAX_SOURCE_HOPS: usize = 8;

/// `family(attachment_id)`: `$1` and every copy whose chain reaches it.
pub(crate) const FAMILY_CTE: &str = "WITH RECURSIVE family(attachment_id, depth) AS ( \
       SELECT $1::text, 0 \
       UNION \
       SELECT copy.attachment_id, family.depth + 1 \
       FROM cloud_attachments copy \
       JOIN family ON copy.document_source_attachment_id = family.attachment_id \
       WHERE family.depth < 8) ";

/// Follows `links` (attachment id to its source) from `start` and returns
/// the last attachment reached that exists in `links`. Stops at a missing
/// link, a cycle, or after [`MAX_SOURCE_HOPS`].
pub(crate) fn resolve_chain(start: &str, links: &[(String, Option<String>)]) -> String {
    let next: HashMap<&str, Option<&str>> = links
        .iter()
        .map(|(id, source)| (id.as_str(), source.as_deref()))
        .collect();
    let mut current = start;
    let mut seen = HashSet::from([start]);
    for _ in 0..MAX_SOURCE_HOPS {
        match next.get(current).copied().flatten() {
            Some(source) if next.contains_key(source) && seen.insert(source) => current = source,
            _ => break,
        }
    }
    current.to_string()
}

/// The canonical attachment for `requested`.
pub(crate) async fn canonical_attachment_id(
    pool: &PgPool,
    requested: &str,
) -> Result<String, sqlx_core::Error> {
    let links: Vec<(String, Option<String>)> = query_as(
        "WITH RECURSIVE chain(attachment_id, source, depth) AS ( \
           SELECT attachment_id, document_source_attachment_id, 0 \
           FROM cloud_attachments WHERE attachment_id = $1 \
           UNION ALL \
           SELECT next.attachment_id, next.document_source_attachment_id, chain.depth + 1 \
           FROM cloud_attachments next JOIN chain ON next.attachment_id = chain.source \
           WHERE chain.depth < $2) \
         SELECT attachment_id, source FROM chain",
    )
    .bind(requested)
    .bind(MAX_SOURCE_HOPS as i32)
    .fetch_all(pool)
    .await?;
    Ok(resolve_chain(requested, &links))
}

/// Whether `account_id` is an active member of a conversation that carries
/// the canonical attachment or one of its copies.
pub(crate) async fn is_family_member(
    pool: &PgPool,
    canonical: &str,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let (member,): (bool,) = query_as(&format!(
        "{FAMILY_CTE} SELECT EXISTS ( \
           SELECT 1 FROM cloud_chat_message_attachments link \
           JOIN cloud_chat_messages message ON message.message_id = link.message_id \
           JOIN cloud_chat_conversation_members member \
             ON member.conversation_id = message.conversation_id \
           WHERE link.attachment_id IN (SELECT attachment_id FROM family) \
             AND member.account_id = $2 AND member.membership_state = 'active')"
    ))
    .bind(canonical)
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    Ok(member)
}

/// The owner and the active members of every conversation that carries the
/// canonical attachment or one of its copies.
pub(crate) async fn family_audience(
    pool: &PgPool,
    record: &DocumentRecord,
) -> Result<Vec<String>, sqlx_core::Error> {
    let rows: Vec<(String,)> = query_as(&format!(
        "{FAMILY_CTE} SELECT DISTINCT member.account_id \
         FROM cloud_chat_message_attachments link \
         JOIN cloud_chat_messages message ON message.message_id = link.message_id \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = message.conversation_id \
         WHERE link.attachment_id IN (SELECT attachment_id FROM family) \
           AND member.membership_state = 'active'"
    ))
    .bind(&record.attachment_id)
    .fetch_all(pool)
    .await?;
    let mut audience = vec![record.owner_account_id.clone()];
    audience.extend(rows.into_iter().map(|(id,)| id));
    audience.sort();
    audience.dedup();
    Ok(audience)
}

/// An attachment of the family that `account_id` owns or was sent, canonical
/// first; used to authorize routes that only know the canonical id.
pub(crate) async fn readable_family_attachment(
    pool: &PgPool,
    canonical: &str,
    account_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(&format!(
        "{FAMILY_CTE} SELECT attachment.attachment_id FROM cloud_attachments attachment \
         JOIN (SELECT attachment_id, MIN(depth) AS depth FROM family GROUP BY attachment_id) \
           member_of_family ON member_of_family.attachment_id = attachment.attachment_id \
         WHERE attachment.owner_account_id = $2 OR EXISTS ( \
           SELECT 1 FROM cloud_chat_message_attachments link \
           JOIN cloud_chat_messages message ON message.message_id = link.message_id \
           JOIN cloud_chat_conversation_members member \
             ON member.conversation_id = message.conversation_id \
           WHERE link.attachment_id = attachment.attachment_id \
             AND member.account_id = $2 AND member.membership_state = 'active') \
         ORDER BY member_of_family.depth ASC, attachment.attachment_id ASC LIMIT 1"
    ))
    .bind(canonical)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id,)| id))
}

/// `viewerCan.edit`: Markdown documents, for owners and for active members of
/// a conversation that carries the document or a copy of it.
pub(crate) async fn can_edit(
    pool: &PgPool,
    record: &DocumentRecord,
    viewer: Viewer,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    if record.format != DocumentFormat::Markdown {
        return Ok(false);
    }
    match viewer {
        Viewer::Owner => Ok(true),
        Viewer::Member => is_family_member(pool, &record.attachment_id, account_id).await,
        Viewer::Public => Ok(false),
    }
}
