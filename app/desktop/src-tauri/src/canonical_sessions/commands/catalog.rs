//! Typed read models for canonical session catalog and transcript commands.

mod full_state;
mod message_page;
mod message_sources;
mod rows;
mod session_catalog;

pub(in crate::canonical_sessions) use full_state::{
    desktop_canonical_session_state, load_state_from_db,
};
pub(in crate::canonical_sessions) use message_page::desktop_canonical_session_messages;
#[cfg(test)]
pub(super) use message_page::load_message_page_from_db;
pub(in crate::canonical_sessions) use message_sources::desktop_canonical_existing_message_sources;
#[cfg(test)]
pub(in crate::canonical_sessions) use message_sources::existing_message_sources_from_db;
pub(in crate::canonical_sessions) use session_catalog::desktop_canonical_session_catalog;
#[cfg(test)]
pub(super) use session_catalog::load_catalog_from_db;
