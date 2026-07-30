//! Source-level contracts for cloud-auth persistence and message semantics.
//!
//! Runtime behavior remains covered by `cloud_auth_e2e`; these checks keep
//! migration registration and the SQL invariants visible without coupling the
//! runtime suite to one route-module layout.

const AUTH_MESSAGE_ROUTES_SOURCE: &str = concat!(
    include_str!("../src/auth/routes/message_handlers.rs"),
    include_str!("../src/auth/routes/message_list_handlers.rs"),
    include_str!("../src/auth/routes/message_policy.rs"),
    include_str!("../src/auth/routes/message_read_handlers.rs"),
    include_str!("../src/auth/routes/sync_handlers.rs"),
    include_str!("../src/auth/routes/types.rs"),
);

#[test]
fn cloud_message_listing_uses_newest_window_before_oldest_first_display_order() {
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("ORDER BY cm.created_at DESC"));
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("ORDER BY created_at ASC"));
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("FROM ("));
}

#[test]
fn cloud_message_listing_applies_durable_read_cursors() {
    let pool_source = include_str!("../src/pg/pool.rs");
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("cloud_read_cursors"));
    assert!(pool_source.contains("version: 28"));
    assert!(pool_source.contains("0028_cloud_read_cursors.sql"));
    assert!(pool_source.contains("version: 29"));
    assert!(pool_source.contains("0029_backfill_cloud_read_cursors.sql"));
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("peer_read_cursor"));
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("session_read_cursor"));
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("COALESCE(read_at"));
}

#[test]
fn cloud_self_addressed_messages_are_read_by_definition() {
    let messages_source = include_str!("../src/auth/messages.rs");
    let pool_source = include_str!("../src/pg/pool.rs");
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("let read_at = if is_self_message"));
    assert!(messages_source.contains("(message_id, from_account_id, to_account_id, body, created_at, delivered_at, read_at, session_id, client_message_id)"));
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("WHEN from_account_id = $1 AND to_account_id = $1"));
    assert!(pool_source.contains("version: 30"));
    assert!(pool_source.contains("0030_mark_self_cloud_messages_read.sql"));
    assert!(pool_source.contains("version: 31"));
    assert!(pool_source.contains("0031_cloud_message_attachment_previews.sql"));
}

#[test]
fn cloud_attachment_preview_recovery_only_updates_caller_visible_links() {
    let source = include_str!("../src/attachments/routes.rs");
    assert!(source.contains("UPDATE cloud_message_attachments cma"));
    assert!(source.contains("cm.message_id = cma.message_id"));
    assert!(source.contains("cm.from_account_id = $3 OR cm.to_account_id = $3"));
    assert!(source.contains("$3 = $4"));
}

#[test]
fn cloud_message_idempotency_migration_is_embedded() {
    let pool_source = include_str!("../src/pg/pool.rs");
    let messages_source = include_str!("../src/auth/messages.rs");
    assert!(pool_source.contains("version: 32"));
    assert!(pool_source.contains("0032_cloud_message_idempotency.sql"));
    assert!(AUTH_MESSAGE_ROUTES_SOURCE.contains("client_message_id"));
    assert!(messages_source.contains("ON CONFLICT"));
    assert!(messages_source.contains("tx.commit()"));
}

#[test]
fn cloud_message_transaction_preserves_attachment_previews() {
    let messages_source = include_str!("../src/auth/messages.rs");
    assert!(messages_source.contains(
        "(message_id, attachment_id, name, kind, mime_type, size_bytes, position, preview_url)"
    ));
    assert!(messages_source
        .contains("SELECT attachment_id, name, kind, mime_type, size_bytes, preview_url"));
    assert!(messages_source.contains(".bind(attachment.preview_url.as_deref())"));
}
