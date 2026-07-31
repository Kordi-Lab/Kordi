//! Focused SQLite persistence adapters for canonical session resources.

mod delegated_exchanges;
mod identities;
mod messages;
mod sessions;

pub(crate) use delegated_exchanges::{create_delegated_exchange_in_db, select_delegated_exchange};
pub(super) use identities::{select_identity, upsert_identity_in_db};
pub(crate) use messages::{
    append_message_in_db, select_message, select_message_by_source, upsert_message_in_db,
};
pub(super) use sessions::{
    enforce_only_local_group_self, open_or_create_session_in_db, select_session, upsert_participant,
};
