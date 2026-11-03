//! Select observation authority separately from the execution lease.
use kordi_cli::desktop_runtime::{DesktopChatContextMessage, DesktopCloudExecutionLease};
use kordi_core::types::RuntimeIdentity;
use kordi_tools::SessionObservationRuntime;

pub(in crate::chat) fn owner_personal_turn(
    lease: Option<&DesktopCloudExecutionLease>,
    stored_scope: Option<&str>,
    identity: Option<&DesktopChatContextMessage>,
) -> bool {
    let (Some(lease), Some(identity)) = (lease, identity) else {
        return false;
    };
    // The server marks a conversation owner_private only if it has never
    // had another member. An owner speaking in a group is still scoped.
    lease.connector_audience.as_deref() == Some("owner_private")
        && lease.session_id.starts_with("session:self-agent:")
        && !lease.owner_account_id.trim().is_empty()
        && stored_scope.is_none_or(|scope| scope == lease.session_id)
        && serde_json::from_str::<RuntimeIdentity>(&identity.text).is_ok_and(|identity| {
            identity.owner_account_id == lease.owner_account_id
                && identity.requester_account_id == lease.owner_account_id
        })
}

pub(in crate::chat) fn build(
    lease: Option<DesktopCloudExecutionLease>,
    scope: Option<String>,
    directory: Option<String>,
    calendar: Option<kordi_tools::calendar::CalendarRuntime>,
    identity: Option<DesktopChatContextMessage>,
) -> SessionObservationRuntime {
    if owner_personal_turn(lease.as_ref(), scope.as_deref(), identity.as_ref()) {
        // Personal requests also acquire execution leases for cross-device
        // coordination. That lease must not restrict discovery to the chat
        // containing the request. Account membership still authorizes reads.
        return super::build_with_identity(None, None, calendar, identity);
    }
    if let Some(lease) = lease {
        let session = lease.session_id.clone();
        return super::cloud::build(lease, session, calendar);
    }
    super::build_with_identity(scope, directory, calendar, identity)
}
