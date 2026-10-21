//! Response shapes for the contact profile route. Keys are camelCase and
//! identical on every platform.

use serde::Serialize;

use super::super::DefaultAgentProfileResponse;
use crate::common_ground::ProfileCommonGround;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ContactProfileResponse {
    pub account_id: String,
    /// Null for agents and the system contact, which have no Kordi ID.
    pub kordi_id: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub about: Option<String>,
    /// `person`, `agent`, or `system`.
    pub kind: &'static str,
    pub is_self: bool,
    pub is_contact: bool,
    /// Null for agents and the system contact.
    pub presence: Option<ProfilePresence>,
    pub default_agent: Option<ProfileDefaultAgent>,
    pub owner: Option<ProfileOwner>,
    pub contact_since: Option<String>,
    pub shared: SharedSummary,
    pub common_ground: Option<ProfileCommonGround>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProfilePresence {
    /// `online` or `offline`.
    pub status: &'static str,
    pub last_seen_at: Option<String>,
}

/// The public profile's default agent, plus the id to open its profile with.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProfileDefaultAgent {
    #[serde(flatten)]
    pub agent: DefaultAgentProfileResponse,
    pub account_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProfileOwner {
    pub account_id: String,
    pub kordi_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SharedSummary {
    pub media_count: i64,
    pub link_count: i64,
    pub document_count: i64,
    pub groups: Vec<SharedGroup>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SharedGroup {
    pub group_id: String,
    pub title: Option<String>,
    pub avatar_url: Option<String>,
}
