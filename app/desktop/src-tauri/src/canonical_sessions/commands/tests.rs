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

mod catalog;
mod delivery;
mod membership;
mod message_mirror;
