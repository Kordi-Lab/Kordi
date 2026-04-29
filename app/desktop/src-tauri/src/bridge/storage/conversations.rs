mod actions;
mod lookup;
mod merge;
mod outreach_metadata;
mod records;
mod repair;
mod schema;

pub(in crate::bridge) use actions::{
    append_conversation_message_to_storage, bridge_request_is_cancelled,
    delete_conversations_for_host, load_conversation_store,
    mark_bridge_conversation_read_in_storage, note_peer_heartbeat_in_storage,
    note_peer_typing_in_storage, save_conversation_store, update_message_delivery_state_in_storage,
};
pub(in crate::bridge) use lookup::bridge_conversation_id;

#[cfg(test)]
pub(in crate::bridge::storage) use repair::repair_split_bridge_person_session_relay_rows;

#[cfg(test)]
pub(in crate::bridge::storage) use lookup::{find_conversation_for_peer, scoped_conversation_id};
#[cfg(test)]
pub(in crate::bridge::storage) use records::{
    load_conversation_store_from_db, upsert_conversation_record,
};
#[cfg(test)]
pub(in crate::bridge::storage) use schema::{
    init_conversation_schema, reconcile_and_repair_persisted_conversation_rows,
};
