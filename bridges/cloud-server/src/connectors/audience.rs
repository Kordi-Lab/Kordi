//! Consent boundary for connector data (issue 1712, PR 5).
//!
//! Connector results describe other people: senders, attendees, members.
//! They may reach a run only when nobody but the owner can read what the run
//! produces. Every run insert records a [`ConnectorAudience`]; delivery gives
//! a `shared` run no connector tools at all.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::models::ConnectorAudience;

/// Audience of a run admitted for a message in `session_id`.
///
/// `owner_private` only when the owner sent the message and the session is
/// the owner's own agent conversation: a `kind = 'ai'` conversation the owner
/// created that has never had another member. Anything else, including a
/// session with no conversation row, is `shared`.
pub async fn audience_for_message(
    pool: &PgPool,
    session_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
) -> Result<ConnectorAudience, sqlx_core::Error> {
    let owner = owner_account_id.trim();
    if owner.is_empty() || owner != requester_account_id.trim() {
        return Ok(ConnectorAudience::Shared);
    }
    let (private,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_chat_conversations c \
         WHERE c.legacy_session_id = $1 AND c.kind = 'ai' AND c.created_by_account_id = $2 \
           AND NOT EXISTS(SELECT 1 FROM cloud_chat_conversation_members m \
                          WHERE m.conversation_id = c.conversation_id AND m.account_id <> $2))",
    )
    .bind(session_id.trim())
    .bind(owner)
    .fetch_one(pool)
    .await?;
    Ok(if private {
        ConnectorAudience::OwnerPrivate
    } else {
        ConnectorAudience::Shared
    })
}
