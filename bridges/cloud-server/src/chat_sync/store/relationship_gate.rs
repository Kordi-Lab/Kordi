//! Consent gates for conversations between people.
//!
//! Two accounts are contacts only while both accepted each other and neither
//! blocked the other (`cloud_accounts_are_contacts`). Direct and AI
//! conversations with other people, and adding people to groups, need that
//! relationship; messaging inside a group one already belongs to does not.

use super::*;

/// Returned when someone writes in a direct conversation with a person who is
/// no longer (or not yet) their contact.
pub const DIRECT_REQUIRES_CONTACT: &str = "You can send messages here only while you're contacts. Send a contact request, and you can chat once it's accepted.";
/// Returned when someone creates a group with, or adds, a person who is not
/// their contact.
pub const GROUP_ADD_REQUIRES_CONTACT: &str =
    "You can add only your contacts to a group. To invite someone else, share an invite link.";

/// Requires every other active person in a conversation that is not a group
/// (`direct` or `ai`) to be a contact of `account_id`. Nobody can leave such a
/// conversation, so removing or blocking a contact must stop writing there.
/// Groups pass unchanged, and so do Kordi service accounts (Kordi Support and
/// PiP) on either side, identified by membership rather than the session id.
/// Call it after `require_active_member`.
pub(crate) async fn require_direct_relationship(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), StoreError> {
    if crate::relationships::may_write_outside_groups(
        &mut **transaction,
        conversation_id,
        account_id,
    )
    .await?
    {
        return Ok(());
    }
    Err(StoreError::RelationshipRequired(DIRECT_REQUIRES_CONTACT))
}

/// Requires each peer of a new conversation to be a contact of `account_id`,
/// except the trusted Kordi Support owner.
pub(super) async fn require_contacts_for_new_conversation(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    kind: ConversationKind,
    peers: &[String],
    trusted_peer_account_id: Option<&str>,
) -> Result<(), StoreError> {
    if peers.is_empty() {
        return Ok(());
    }
    let refused: (i64,) = query_as(
        "SELECT COUNT(*) FROM unnest($2::TEXT[]) AS peer(account_id) \
         WHERE peer.account_id IS DISTINCT FROM $3 \
           AND NOT cloud_accounts_are_contacts($1, peer.account_id)",
    )
    .bind(account_id)
    .bind(peers)
    .bind(trusted_peer_account_id)
    .fetch_one(&mut **transaction)
    .await?;
    if refused.0 == 0 {
        return Ok(());
    }
    Err(StoreError::RelationshipRequired(match kind {
        ConversationKind::Group => GROUP_ADD_REQUIRES_CONTACT,
        _ => DIRECT_REQUIRES_CONTACT,
    }))
}

/// Where a group conversation sits in its group space.
pub(super) struct GroupSpace {
    /// The `legacy_session_id` of the space's main conversation.
    pub root: String,
    /// Whether this conversation is the space's main conversation.
    pub is_root: bool,
}

impl GroupSpace {
    pub(super) fn new(legacy_session_id: Option<&str>, group_space_id: Option<&str>) -> Self {
        let legacy = legacy_session_id.unwrap_or_default();
        let root = group_space_id
            .filter(|value| !value.is_empty())
            .unwrap_or(legacy)
            .to_string();
        Self {
            is_root: root == legacy,
            root,
        }
    }
}

/// The accounts among `account_ids` that are active members of the space's
/// main group conversation.
pub(super) async fn active_in_root(
    transaction: &mut Transaction<'_, Postgres>,
    root: &str,
    account_ids: &[String],
) -> Result<BTreeSet<String>, StoreError> {
    let rows: Vec<(String,)> = query_as(
        "SELECT member.account_id \
         FROM cloud_chat_conversations conversation \
         JOIN cloud_chat_conversation_members member \
           ON member.conversation_id = conversation.conversation_id \
         WHERE conversation.legacy_session_id = $1 \
           AND conversation.kind = 'group' \
           AND member.membership_state = 'active' \
           AND member.account_id = ANY($2)",
    )
    .bind(root)
    .bind(account_ids)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows.into_iter().map(|(account_id,)| account_id).collect())
}

/// Requires each account an admin adds to a group to be the admin's contact,
/// unless this is a channel of a space and both are active in its main
/// conversation (for example, someone who joined through an invite link).
/// That exception never applies while either of the two blocked the other.
pub(super) async fn require_contacts_for_group_add(
    transaction: &mut Transaction<'_, Postgres>,
    actor_account_id: &str,
    space: &GroupSpace,
    added: &[String],
) -> Result<(), StoreError> {
    if added.is_empty() {
        return Ok(());
    }
    let rows: Vec<(String, bool)> = query_as(
        "SELECT peer.account_id, cloud_accounts_blocked_either_way($1, peer.account_id) \
         FROM unnest($2::TEXT[]) AS peer(account_id) \
         WHERE NOT cloud_accounts_are_contacts($1, peer.account_id)",
    )
    .bind(actor_account_id)
    .bind(added)
    .fetch_all(&mut **transaction)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }
    let mut strangers = rows
        .iter()
        .map(|(account_id, _)| account_id.clone())
        .collect::<Vec<_>>();
    if !space.is_root {
        let mut candidates = strangers.clone();
        candidates.push(actor_account_id.to_string());
        let active = active_in_root(transaction, &space.root, &candidates).await?;
        if active.contains(actor_account_id) {
            strangers = rows
                .into_iter()
                .filter(|(account_id, blocked)| *blocked || !active.contains(account_id))
                .map(|(account_id, _)| account_id)
                .collect();
        }
    }
    if strangers.is_empty() {
        Ok(())
    } else {
        Err(StoreError::RelationshipRequired(GROUP_ADD_REQUIRES_CONTACT))
    }
}

#[cfg(test)]
mod tests {
    use super::GroupSpace;

    #[test]
    fn a_conversation_without_a_space_is_its_own_root() {
        let space = GroupSpace::new(Some("session:group:team"), None);
        assert!(space.is_root);
        assert_eq!(space.root, "session:group:team");
        let space = GroupSpace::new(Some("session:group:team"), Some(""));
        assert!(space.is_root);
    }

    #[test]
    fn a_channel_points_at_its_space_root() {
        let root = GroupSpace::new(Some("session:group:team"), Some("session:group:team"));
        assert!(root.is_root);
        let channel = GroupSpace::new(
            Some("session:group:team:design"),
            Some("session:group:team"),
        );
        assert!(!channel.is_root);
        assert_eq!(channel.root, "session:group:team");
    }
}
