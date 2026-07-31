//! Focused SQLite persistence adapters for canonical session resources.

mod identities;

pub(super) use identities::{select_identity, upsert_identity_in_db};
