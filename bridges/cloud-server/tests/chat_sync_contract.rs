use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("resolve repository root")
}

fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).expect("read contract source")
}

fn read_runtime_sources(path: &Path) -> String {
    let mut entries = fs::read_dir(path)
        .expect("read runtime source directory")
        .map(|entry| entry.expect("read runtime source entry"))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    entries
        .into_iter()
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                read_runtime_sources(&path)
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                read(path)
            } else {
                String::new()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn durable_event_and_message_schemas_are_valid_json_contracts() {
    let root = repository_root();
    let event: Value = serde_json::from_str(&read(
        root.join("shared/chat-sync/schemas/event-envelope.schema.json"),
    ))
    .expect("event schema is valid JSON");
    let message: Value = serde_json::from_str(&read(
        root.join("shared/chat-sync/schemas/message.schema.json"),
    ))
    .expect("message schema is valid JSON");

    assert_eq!(event["properties"]["protocol_version"]["const"], 2);
    let required = event["required"].as_array().expect("event required list");
    for field in [
        "stream_seq",
        "event_id",
        "protocol_version",
        "type",
        "critical",
        "payload",
    ] {
        assert!(
            required.iter().any(|value| value == field),
            "missing {field}"
        );
    }

    let event_types = event["properties"]["type"]["enum"]
        .as_array()
        .expect("event type registry");
    for event_type in [
        "conversation.updated",
        "conversation.preferences.updated",
        "message.created",
        "delivery_cursor.updated",
        "read_cursor.updated",
    ] {
        assert!(
            event_types.iter().any(|value| value == event_type),
            "missing durable event type {event_type}"
        );
    }

    let content_required = message["properties"]["content"]["required"]
        .as_array()
        .expect("message content required list");
    assert!(content_required.iter().any(|value| value == "schema"));
    assert!(content_required.iter().any(|value| value == "blocks"));
    assert_eq!(
        message["properties"]["reactions"]["items"]["properties"]["account_ids"]["uniqueItems"],
        true
    );
}

#[test]
fn migration_embeds_canonical_ordering_idempotency_and_title_state() {
    let root = repository_root();
    let migration =
        read(root.join("bridges/cloud-server/migrations/0047_reliable_chat_sync_v2.sql"));
    let lowercase = migration.to_ascii_lowercase();

    for invariant in [
        "unique (conversation_id, conversation_sequence)",
        "unique (sender_account_id, client_message_id)",
        "primary key (account_id, stream_seq)",
        "check (last_read_sequence <= last_delivered_sequence)",
        "shared_title",
        "personal_title",
        "preferences_version",
        "request_fingerprint",
    ] {
        assert!(
            lowercase.contains(invariant),
            "missing invariant: {invariant}"
        );
    }
    assert!(!lowercase.contains("drop table"));

    let pool = read(root.join("bridges/cloud-server/src/pg/pool.rs"));
    let migration_33 = pool.find("version: 33").expect("migration 33 embedded");
    let migration_35 = pool.find("version: 35").expect("migration 35 embedded");
    let migration_47 = pool.find("version: 47").expect("migration 47 embedded");
    let migration_48 = pool.find("version: 48").expect("migration 48 embedded");
    let migration_49 = pool.find("version: 49").expect("migration 49 embedded");
    let migration_50 = pool.find("version: 50").expect("migration 50 embedded");
    let migration_51 = pool.find("version: 51").expect("migration 51 embedded");
    assert!(
        migration_33 < migration_35
            && migration_35 < migration_47
            && migration_47 < migration_48
            && migration_48 < migration_49
            && migration_49 < migration_50
            && migration_50 < migration_51
    );
    assert!(pool.contains("0047_reliable_chat_sync_v2.sql"));
    assert!(pool.contains("0048_backfill_reliable_chat_sync_v2.sql"));
    assert!(pool.contains("0049_relink_legacy_agent_responses.sql"));
    assert!(pool.contains("0050_chat_v2_artifact_links.sql"));
    assert!(pool.contains("0051_retire_chat_sync_v1.sql"));
    assert!(pool.contains("0062_call_revisions.sql"));

    let backfill =
        read(root.join("bridges/cloud-server/migrations/0048_backfill_reliable_chat_sync_v2.sql"));
    for invariant in [
        "cloud_chat_legacy_message_map",
        "row_number() over",
        "last_seq = cloud_chat_user_sync_heads.last_seq + 1",
        "min_seq = cloud_chat_user_sync_heads.last_seq + 1",
    ] {
        assert!(
            backfill.to_ascii_lowercase().contains(invariant),
            "backfill is missing invariant: {invariant}"
        );
    }

    let agent_relink =
        read(root.join("bridges/cloud-server/migrations/0049_relink_legacy_agent_responses.sql"));
    for invariant in [
        "cloud_chat_legacy_message_map",
        "reply_to_message_id = candidate.request_message_id",
        "'{requestid}'",
        "version = response.version + 1",
        "min_seq = cloud_chat_user_sync_heads.last_seq + 1",
    ] {
        assert!(
            agent_relink.to_ascii_lowercase().contains(invariant),
            "agent-response relink is missing invariant: {invariant}"
        );
    }

    let retirement =
        read(root.join("bridges/cloud-server/migrations/0051_retire_chat_sync_v1.sql"));
    let retirement_lowercase = retirement.to_ascii_lowercase();
    for invariant in [
        "set request_message_id = mapping.canonical_message_id::text",
        "set response_message_id = mapping.canonical_message_id::text",
        "raise exception 'cannot retire chat sync v1",
        "alter column protocol_version set default 2",
        "check (protocol_version = 2)",
        "drop table if exists cloud_chat_legacy_message_map",
        "drop table if exists cloud_messages",
        "drop table if exists cloud_sync_events",
        "drop table if exists cloud_read_cursors",
        "drop table if exists cloud_session_titles",
        "drop table if exists server_messages",
    ] {
        assert!(
            retirement_lowercase.contains(invariant),
            "v1 retirement is missing invariant: {invariant}"
        );
    }
    assert!(!retirement.lines().any(|line| {
        let line = line.trim_start().to_ascii_lowercase();
        line.starts_with("drop table") && line.contains("cascade")
    }));
}

#[test]
fn canonical_routes_are_exclusive_for_chat_and_require_signed_cursors() {
    let root = repository_root();
    let routes = format!(
        "{}\n{}",
        read(root.join("bridges/cloud-server/src/chat_sync/routes.rs")),
        read(root.join("bridges/cloud-server/src/chat_sync/routes/http.rs")),
    );
    let server = read(root.join("bridges/cloud-server/src/server.rs"));

    for route in [
        "/v2/chat/conversations",
        "/v2/chat/conversations/:conversation_id/preferences",
        "/v2/chat/conversations/:conversation_id/members",
        "/v2/chat/conversations/:conversation_id/messages",
        "/v2/chat/conversations/:conversation_id/messages/:message_id/reactions",
        "/v2/chat/conversations/:conversation_id/delivered",
        "/v2/chat/conversations/:conversation_id/read",
        "/v2/chat/sync",
        "/v2/chat/sync/bootstrap",
        "/v2/chat/realtime/ticket",
    ] {
        assert!(routes.contains(route), "missing route {route}");
    }
    assert!(routes.contains("KORDI_CHAT_SYNC_CURSOR_SECRET"));
    assert!(!routes.contains("KORDI_CHAT_SYNC_V2_ENABLED"));
    assert!(!routes.contains("CHAT_SYNC_V2_DISABLED"));
    assert!(server.contains("chat_sync::routes::routes"));
    assert!(server.contains("/v2/chat/realtime"));
    let runtime_source = read_runtime_sources(&root.join("bridges/cloud-server/src"));
    for retired in [
        "/v1/cloud/messages",
        "/v1/cloud/messages/read",
        "/v1/cloud/sync",
        "/v1/cloud/sessions/:source_session_id/read",
        "/v1/cloud/sessions/:source_session_id/title",
    ] {
        assert!(
            !runtime_source.contains(retired),
            "retired chat route is still reachable: {retired}"
        );
    }
}
