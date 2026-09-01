use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::super::{
    AddCanonicalGroupMembersRequest, CanonicalGroupMemberJoinEvent, CanonicalGroupMembershipUpdate,
    ClassifyLegacyCloudGroupTitleNoticeRequest, UpdateCanonicalMessageDeliveryRequest,
};
use super::{
    add_canonical_group_members_in_db, classify_legacy_cloud_group_title_notices_in_db,
    list_legacy_cloud_group_title_notice_ids_in_db, load_catalog_from_db,
    load_message_page_from_db, load_state_from_db, reconcile_canonical_message_mirror_in_db,
    select_session_participants, update_canonical_message_delivery_in_db,
};

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory canonical db");
    super::super::schema::initialize_schema(&conn).expect("initialize canonical schema");
    conn
}

fn seed_identity(conn: &Connection) {
    conn.execute(
        "INSERT INTO identities (
            id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('human:me', 'human', 'Me', 'local', 'human:me', 1, 1)",
        [],
    )
    .expect("seed identity");
}

#[test]
fn cloud_message_cleanup_covers_versions_self_agent_and_authoritative_pruning() {
    let mut conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:cleanup', 'group', 'Cleanup', 'active', 'human:me', 1, 1, 6)",
        [],
    )
    .expect("seed session");
    for (id, transport, source, sequence) in [
        ("keep-group", "cloud-group", "cloud-group:wire-keep", 1),
        ("stale-group-v1", "cloud-group", "cloud-group:wire-stale", 2),
        (
            "stale-group-v2",
            "cloud-group",
            "cloud-group:wire-stale:2",
            3,
        ),
        ("keep-self", "cloud-self-agent", "self-keep", 4),
        ("stale-self", "cloud-self-agent", "self-stale", 5),
        (
            "derived-offline",
            "cloud-group-agent-offline",
            "cloud-group-agent-offline:request-1:acct_agent",
            6,
        ),
    ] {
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, status, sequence_num, created_at_ms, updated_at_ms,
                source_transport, source_event_id
             ) VALUES (?1, 'session:cleanup', 'human:me', 'user', 'text',
                ?1, 'sent', ?4, ?4, ?4, ?2, ?3)",
            params![id, transport, source, sequence],
        )
        .expect("seed canonical message");
    }
    for (message_id, sequence) in [("wire-keep", 1), ("self-keep", 2)] {
        conn.execute(
            "INSERT INTO chat_sync_messages (
                account_id, message_id, conversation_id, conversation_sequence,
                version, snapshot_json, updated_at_ms
             ) VALUES ('acct_me', ?1, 'conversation-1', ?2, 1, '{}', 1)",
            params![message_id, sequence],
        )
        .expect("seed synced message");
    }

    let deleted = super::lifecycle::prune_missing_cloud_messages_in_db(&mut conn, "acct_me")
        .expect("prune stale messages");
    assert_eq!(
        deleted.into_iter().collect::<HashSet<_>>(),
        HashSet::from([
            "stale-group-v1".to_string(),
            "stale-group-v2".to_string(),
            "stale-self".to_string(),
        ])
    );
    let remaining = conn
        .prepare("SELECT id FROM session_messages ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        remaining,
        vec!["derived-offline", "keep-group", "keep-self"]
    );

    let deleted_group = super::lifecycle::delete_cloud_message_in_db(&mut conn, "wire-keep")
        .expect("delete group message");
    let deleted_self = super::lifecycle::delete_cloud_message_in_db(&mut conn, "self-keep")
        .expect("delete self-agent message");
    assert_eq!(deleted_group, vec!["keep-group"]);
    assert_eq!(deleted_self, vec!["keep-self"]);
    let synced_rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chat_sync_messages WHERE message_id IN ('wire-keep', 'self-keep')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(synced_rows, 0);
}

mod catalog;
mod delivery;
mod membership;
mod message_mirror;
