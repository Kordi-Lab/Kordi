//! Source-level contracts for the ancillary cloud-auth surface.
//!
//! Durable message, history, read-cursor, title, and sync behavior belongs to
//! `chat_sync_contract`. These checks prevent the retired chat transport from
//! being reintroduced while retaining security coverage for ancillary routes.

use std::path::Path;

#[test]
fn retired_chat_implementation_files_stay_removed() {
    let repository_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let auth_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/auth");
    for retired in [
        "messages.rs",
        "routes/message_handlers.rs",
        "routes/message_list_handlers.rs",
        "routes/message_policy.rs",
        "routes/message_read_handlers.rs",
        "routes/session_titles.rs",
        "routes/sync_handlers.rs",
    ] {
        assert!(
            !auth_root.join(retired).exists(),
            "retired chat source was restored: {retired}"
        );
    }
    for retired in [
        "bridges/cloud-server/src/messages/mod.rs",
        "bridges/cloud-server/src/messages/log.rs",
        "bridges/cloud-server/scripts/dry-run-localhost-kh-cleanup.sql",
        "docs/cloud-mobile-v1.md",
        "docs/cloud/cleanup/remove-localhost-kh-bridge-state-2026-05.md",
    ] {
        assert!(
            !repository_root.join(retired).exists(),
            "retired chat artifact was restored: {retired}"
        );
    }
}

#[test]
fn cloud_attachment_preview_recovery_only_updates_caller_visible_links() {
    let source = include_str!("../src/attachments/routes.rs");
    assert!(source.contains("cloud_chat_message_attachments attachment"));
    assert!(source.contains("cloud_chat_conversation_members member"));
    assert!(source.contains("member.account_id = $2"));
    assert!(source.contains("member.membership_state = 'active'"));
    assert!(source.contains("SET preview_url = $1"));
}

#[test]
fn message_migrations_remain_historical_and_retirement_is_latest() {
    let pool_source = include_str!("../src/pg/pool.rs");
    for migration in [28, 29, 30, 31, 32, 47, 48, 49, 50, 51] {
        assert!(
            pool_source.contains(&format!("version: {migration}")),
            "migration {migration} is no longer embedded"
        );
    }
    assert!(pool_source.contains("0047_reliable_chat_sync_v2.sql"));
    assert!(pool_source.contains("0048_backfill_reliable_chat_sync_v2.sql"));
    assert!(pool_source.contains("0049_relink_legacy_agent_responses.sql"));
    assert!(pool_source.contains("0050_chat_v2_artifact_links.sql"));
    assert!(pool_source.contains("0051_retire_chat_sync_v1.sql"));

    let library = include_str!("../src/lib.rs");
    let events = include_str!("../src/events/mod.rs");
    let artifacts = include_str!("../src/cloud_agent_runtime/artifacts/messages.rs");
    assert!(!library.contains("pub mod messages;"));
    assert!(!events.contains("publish_message_arrived"));
    assert!(!events.contains("publish_message_read"));
    assert!(!artifacts.contains("cloud_chat_legacy_message_map"));
}
