//! Local/cloud identity migration composition boundary.

mod cloud_profile;
mod local_identities;

pub(super) use cloud_profile::adopt_cloud_profile_identity_in_db;
#[cfg(test)]
pub(super) use local_identities::update_local_profile_identities;
pub(super) use local_identities::{local_agent_identity_id, local_profile_human_identity_id};
