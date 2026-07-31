mod catalog;
mod delivery;
mod groups;
mod lifecycle;

#[cfg(test)]
pub(super) use self::catalog::load_state_from_db;
pub(super) use self::catalog::{
    desktop_canonical_session_catalog, desktop_canonical_session_messages,
    desktop_canonical_session_state,
};
#[cfg(test)]
use self::catalog::{load_catalog_from_db, load_message_page_from_db};
#[cfg(test)]
use self::delivery::update_canonical_message_delivery_in_db;
pub(super) use self::delivery::{
    desktop_canonical_append_message, desktop_canonical_append_message_fast,
    desktop_canonical_create_delegated_exchange, desktop_canonical_update_message_delivery,
    desktop_canonical_upsert_message, desktop_canonical_upsert_message_fast,
};
#[cfg(test)]
use self::groups::{add_canonical_group_members_in_db, select_session_participants};
pub(super) use self::groups::{
    desktop_canonical_add_group_members_fast, desktop_canonical_add_session_participants,
    desktop_canonical_remove_session_participant, desktop_canonical_rename_session,
    desktop_canonical_set_session_participant_role, desktop_canonical_update_session_metadata,
};
pub(crate) use self::lifecycle::{archive_session, delete_session, session_exists};
pub(super) use self::lifecycle::{
    desktop_canonical_adopt_cloud_profile_identity, desktop_canonical_mark_session_read,
    desktop_canonical_open_or_create_session, desktop_canonical_open_or_create_session_fast,
    desktop_canonical_update_presence, desktop_canonical_upsert_identity,
    desktop_canonical_upsert_identity_fast,
};

#[cfg(test)]
mod catalog_tests;
