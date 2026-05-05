mod config;
mod conversations;
mod identity;

pub(super) use self::config::{
    bridge_hosts_match, delete_bridge_host_secrets, desktop_bridge_config_path,
    desktop_bridge_conversations_path, format_time_label, format_time_label_with_seconds,
    hosted_bridge_dir, korde_dir, legacy_bridge_config_path, load_bridge_store,
    load_legacy_bridge_config, normalize_imported_bridge_host, normalize_server_url, now_ms,
    parse_imported_bridge_store, save_bridge_store, write_bridge_store_export,
};
pub(super) use self::conversations::{
    append_conversation_message_to_storage, append_conversation_message_to_storage_with_timestamp,
    bridge_conversation_id, bridge_request_is_cancelled, delete_conversations_for_host,
    list_runnable_bridge_agent_jobs_from_storage, list_running_bridge_agent_jobs_from_storage,
    load_bridge_inbox_event_from_storage, load_conversation_store,
    mark_bridge_agent_job_retry_wait_in_storage, mark_bridge_agent_job_running_in_storage,
    mark_bridge_agent_job_terminal_in_storage, mark_bridge_conversation_read_in_storage,
    note_peer_heartbeat_in_storage, note_peer_typing_in_storage,
    record_bridge_inbox_event_and_agent_job, save_conversation_store,
    update_message_delivery_state_in_storage, BridgeAgentJobInsert, BridgeAgentJobRecord,
    BridgeInboxEventInsert, BridgeInboxEventRecord,
};
pub(super) use self::identity::{
    derive_node_id, ed25519_to_x25519_public, load_or_create_bridge_identity_for_agent,
};

#[cfg(test)]
use self::config::{bridge_store_export, hydrate_bridge_store_secrets, DesktopBridgeSecretsStore};
#[cfg(test)]
use self::conversations::{
    create_bridge_agent_job_if_absent, find_conversation_for_peer, init_conversation_schema,
    insert_bridge_inbox_event_if_absent, list_runnable_bridge_agent_jobs, load_bridge_agent_job,
    load_conversation_store_from_db, mark_bridge_agent_job_running, mark_bridge_agent_job_terminal,
    reconcile_and_repair_persisted_conversation_rows,
    repair_split_bridge_person_session_relay_rows, scoped_conversation_id,
    update_message_delivery_state_in_db_for_test, upsert_conversation_record,
};
#[cfg(test)]
use super::{
    default_bridge_agent_runtime, DesktopBridgeAgentConfig, DesktopBridgeConversationMessageRecord,
    DesktopBridgeConversationRecord, DesktopBridgeHostConfig, DesktopBridgeStore,
};
#[cfg(test)]
use rusqlite::Connection;

#[cfg(test)]
mod tests;
