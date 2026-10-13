//! Sync event types that already released clients understand.
//!
//! A client rejects a critical event whose type it does not know and stops
//! applying that account's sync stream until it is updated. Clients that are
//! already installed cannot learn new types, so a type outside this list must
//! never reach them as critical.

/// Event types accepted by both 0.0.2 beta 3 clients: the desktop projection
/// (`apply_event` in `canonical_sessions/chat_sync/projection.rs`) and the
/// iPhone projection (`projectedEvents` in `CloudAPIClient.swift`) at tag
/// `V0.0.2.beta3`. The two lists are identical, so this is their intersection.
/// Add a type here only after every supported client release handles it.
pub(crate) const BETA3_CLIENT_EVENT_TYPES: &[&str] = &[
    "conversation.created",
    "conversation.updated",
    "conversation.preferences.updated",
    "membership.updated",
    "membership.removed",
    "message.created",
    "message.updated",
    "message.deleted",
    "message.hidden",
    "reaction.updated",
    "delivery_cursor.updated",
    "read_cursor.updated",
    "generation.updated",
    "generation.completed",
    "generation.failed",
    "account.profile.updated",
    "account.directory.changed",
    "agent.definition.upserted",
    "agent.definition.archived",
    "agent.directory.changed",
    "provider-auth.updated",
    "task.upsert",
    "artifact.upsert",
    "artifact.archived",
    "session.pin.updated",
    "session.hidden",
    "session.unhidden",
    "session.deleted",
    "session.pinned",
    "session.unpinned",
    "session.muted",
    "session.unmuted",
    "session.marked_unread",
    "session.unmarked_unread",
    "group_space.pinned",
    "group_space.unpinned",
    "session-forked",
    "call.created",
    "call.updated",
    "device.added",
    "device.confirmed",
    "device.revoked",
    "device.renamed",
];

/// Returns whether an event may be stored as critical. A type that released
/// clients do not know is downgraded so it can never stall their sync.
pub(super) fn critical_for_released_clients(event_type: &str, requested: bool) -> bool {
    if !requested || BETA3_CLIENT_EVENT_TYPES.contains(&event_type) {
        return requested;
    }
    eprintln!(
        "[chat-sync] event type {event_type} is unknown to released clients; storing it as non-critical"
    );
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every type the server publishes through the critical insert paths
    /// (`insert_sync_event`, `insert_sync_event_fanout`, and their wrappers).
    /// Extend this list together with any new critical publisher.
    const PUBLISHED_CRITICAL_EVENT_TYPES: &[&str] = &[
        "conversation.created",
        "conversation.updated",
        "conversation.preferences.updated",
        "membership.updated",
        "membership.removed",
        "message.created",
        "message.updated",
        "message.deleted",
        "delivery_cursor.updated",
        "read_cursor.updated",
        "account.profile.updated",
        "account.directory.changed",
        "agent.definition.upserted",
        "agent.definition.archived",
        "agent.directory.changed",
        "provider-auth.updated",
        "task.upsert",
        "artifact.upsert",
        "session.pin.updated",
        "session.hidden",
        "session.unhidden",
        "session.deleted",
        "session.pinned",
        "session.unpinned",
        "session.muted",
        "session.unmuted",
        "session.marked_unread",
        "session.unmarked_unread",
        "group_space.pinned",
        "group_space.unpinned",
        "session-forked",
        "call.created",
        "call.updated",
        "device.added",
        "device.confirmed",
        "device.revoked",
        "device.renamed",
    ];

    #[test]
    fn every_published_critical_type_is_known_to_released_clients() {
        for event_type in PUBLISHED_CRITICAL_EVENT_TYPES {
            assert!(
                critical_for_released_clients(event_type, true),
                "{event_type} would stall released clients"
            );
        }
    }

    #[test]
    fn unknown_types_are_never_critical() {
        assert!(!critical_for_released_clients("document.shared", true));
        assert!(!critical_for_released_clients("", true));
        assert!(!critical_for_released_clients("Message.Created", true));
    }

    #[test]
    fn non_critical_requests_stay_non_critical() {
        assert!(!critical_for_released_clients("message.created", false));
        assert!(!critical_for_released_clients("document.shared", false));
    }

    #[test]
    fn allowlist_has_no_duplicates() {
        let unique = BETA3_CLIENT_EVENT_TYPES
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), BETA3_CLIENT_EVENT_TYPES.len());
    }
}
