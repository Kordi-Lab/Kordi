//! Canonical group memory scope ids on the Mac (#1710).
//!
//! The account server keys group memories by the cloud group conversation id.
//! A group turn on the Mac runs under the local canonical session id instead
//! (`session:group:<local id>`, or the runtime form
//! `cloud-agent:<account>:session:group:<local id>:request:<message id>`).
//! The desktop host records which cloud group id stands behind each local
//! group session, and every group scope id is normalised through here before
//! it reaches a lesson file, the cache, or the account.

use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

const GROUP_MARKER: &str = "session:group:";
const REQUEST_MARKER: &str = ":request:";

static GROUP_ALIASES: LazyLock<RwLock<HashMap<String, String>>> =
    LazyLock::new(|| RwLock::new(HashMap::new()));

/// The group id inside a group session id: the text after `session:group:` up
/// to `:request:` or the end. `None` when `raw` is not a group session id.
pub fn group_session_part(raw: &str) -> Option<&str> {
    let raw = raw.trim();
    let start = raw.find(GROUP_MARKER)? + GROUP_MARKER.len();
    let rest = &raw[start..];
    let id = rest
        .find(REQUEST_MARKER)
        .map_or(rest, |end| &rest[..end])
        .trim();
    (!id.is_empty()).then_some(id)
}

/// Record that the local group session `local_session_id` (bare id or any
/// group session id form) is the cloud group `cloud_group_id`. Returns true
/// when the mapping is new or changed. Blank values are ignored.
pub fn remember_group_scope_alias(local_session_id: &str, cloud_group_id: &str) -> bool {
    let local = group_session_part(local_session_id).unwrap_or(local_session_id.trim());
    let cloud = cloud_group_id.trim();
    if local.is_empty() || cloud.is_empty() || local == cloud {
        return false;
    }
    let mut aliases = match GROUP_ALIASES.write() {
        Ok(aliases) => aliases,
        Err(poisoned) => poisoned.into_inner(),
    };
    aliases
        .insert(local.to_string(), cloud.to_string())
        .as_deref()
        != Some(cloud)
}

/// The scope id of a group memory: the cloud group id behind `raw`. Accepts a
/// bare id, `session:group:<id>`, and the cloud-agent runtime form. A local id
/// with a recorded alias maps to its cloud id. A group session id without a
/// known alias keeps the `session:group:<id>` form, so the row stays local
/// until the cloud id is known; a bare id is returned trimmed.
pub fn canonical_group_scope_id(raw: &str) -> String {
    let session_part = group_session_part(raw);
    let id = session_part.unwrap_or(raw.trim());
    let aliases = match GROUP_ALIASES.read() {
        Ok(aliases) => aliases,
        Err(poisoned) => poisoned.into_inner(),
    };
    match (aliases.get(id), session_part) {
        (Some(cloud), _) => cloud.clone(),
        (None, Some(local)) => format!("{GROUP_MARKER}{local}"),
        (None, None) => id.to_string(),
    }
}

/// True when a group scope id is still a local group session id, which the
/// account server does not know.
pub fn is_local_group_scope_id(scope_id: &str) -> bool {
    scope_id.trim().starts_with(GROUP_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_unmapped_group_session_forms_local() {
        assert_eq!(
            canonical_group_scope_id("session:group:gs-bare"),
            "session:group:gs-bare"
        );
        assert_eq!(
            canonical_group_scope_id("cloud-agent:acct_a:session:group:gs-runtime:request:msg_1"),
            "session:group:gs-runtime"
        );
        assert_eq!(
            canonical_group_scope_id("cloud-agent:acct_a:session:group:gs-no-request"),
            "session:group:gs-no-request"
        );
        assert_eq!(
            canonical_group_scope_id("  session:group:gs-space  "),
            "session:group:gs-space"
        );
        assert!(is_local_group_scope_id("session:group:gs-bare"));
        assert!(!is_local_group_scope_id("gs-cloud"));
        assert_eq!(group_session_part("session:group:"), None);
        assert_eq!(group_session_part("session-123"), None);
    }

    #[test]
    fn maps_known_local_ids_to_cloud_ids() {
        assert!(remember_group_scope_alias(
            "session:group:gs-local-1",
            " gs-cloud-1 "
        ));
        assert!(!remember_group_scope_alias("gs-local-1", "gs-cloud-1"));
        assert_eq!(canonical_group_scope_id("gs-local-1"), "gs-cloud-1");
        assert_eq!(
            canonical_group_scope_id("session:group:gs-local-1"),
            "gs-cloud-1"
        );
        assert_eq!(
            canonical_group_scope_id("cloud-agent:acct:session:group:gs-local-1:request:m"),
            "gs-cloud-1"
        );
        assert_eq!(canonical_group_scope_id(" gs-local-1\n"), "gs-cloud-1");
    }

    #[test]
    fn leaves_unknown_and_cloud_ids_unchanged() {
        assert!(remember_group_scope_alias("gs-local-2", "gs-cloud-2"));
        assert_eq!(canonical_group_scope_id("gs-unknown"), "gs-unknown");
        assert_eq!(canonical_group_scope_id("gs-cloud-2"), "gs-cloud-2");
        assert!(!remember_group_scope_alias("", "gs-cloud-3"));
        assert!(!remember_group_scope_alias("gs-local-3", "  "));
        assert_eq!(canonical_group_scope_id("gs-local-3"), "gs-local-3");
        assert_eq!(
            canonical_group_scope_id("session:group:gs-local-3"),
            "session:group:gs-local-3"
        );
    }
}
