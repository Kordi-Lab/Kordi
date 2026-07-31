//! Focused SQLite persistence adapters for canonical session resources.

mod identities;
mod sessions;

pub(super) use identities::{select_identity, upsert_identity_in_db};
pub(super) use sessions::{
    enforce_only_local_group_self, open_or_create_session_in_db, select_session, upsert_participant,
};
