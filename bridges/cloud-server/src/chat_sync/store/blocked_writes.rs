//! Membership plus the block check for writing a message.

use super::support::require_active_member;
use super::*;

/// Requires an active member who may write here: in a direct or AI
/// conversation, neither the writer nor another active member blocked the
/// other. Removing a contact keeps the direct conversation, so contact rows
/// alone cannot stop a blocked person from writing there.
pub(super) async fn require_active_writer(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), StoreError> {
    require_active_member(transaction, conversation_id, account_id).await?;
    crate::safety::blocks::refuse_blocked_direct(transaction, conversation_id, account_id).await
}
