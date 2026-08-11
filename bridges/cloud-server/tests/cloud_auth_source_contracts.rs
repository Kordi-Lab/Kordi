//! Source-level contracts for the cloud-auth surface that remains beside chat v2.
//!
//! Durable message, history, read-cursor, title, and sync behavior belongs to
//! `chat_sync_v2_contract`. These checks prevent the deleted v1 transport from
//! being reintroduced while retaining security coverage for ancillary routes.

use std::path::Path;

#[test]
fn retired_v1_chat_implementation_files_stay_removed() {
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
            "retired v1 chat source was restored: {retired}"
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
fn legacy_message_migrations_remain_historical_and_v2_is_latest() {
    let pool_source = include_str!("../src/pg/pool.rs");
    for migration in [28, 29, 30, 31, 32, 47, 48, 49, 50] {
        assert!(
            pool_source.contains(&format!("version: {migration}")),
            "migration {migration} is no longer embedded"
        );
    }
    assert!(pool_source.contains("0047_reliable_chat_sync_v2.sql"));
    assert!(pool_source.contains("0048_backfill_reliable_chat_sync_v2.sql"));
    assert!(pool_source.contains("0049_relink_legacy_agent_responses.sql"));
    assert!(pool_source.contains("0050_chat_v2_artifact_links.sql"));
}
