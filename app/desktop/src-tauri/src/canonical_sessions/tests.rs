use rusqlite::Connection;

use super::*;

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    schema::initialize_schema(&conn).expect("initialize schema");
    conn
}

fn canonical_desktop_project_group_id(project_root: &str) -> Option<String> {
    let normalized = project_root.trim();
    if normalized.is_empty() {
        None
    } else {
        Some(format!("project:{normalized}"))
    }
}

fn seed_identity(conn: &Connection, id: &str, display_name: &str, kind: &str) -> CanonicalIdentity {
    seed_identity_with_source(conn, id, display_name, kind, "local", None)
}

fn seed_identity_with_source(
    conn: &Connection,
    id: &str,
    display_name: &str,
    kind: &str,
    source: &str,
    owner_identity_id: Option<&str>,
) -> CanonicalIdentity {
    upsert_identity_in_db(
        conn,
        UpsertCanonicalIdentityRequest {
            id: Some(id.to_string()),
            kind: kind.to_string(),
            display_name: display_name.to_string(),
            owner_identity_id: owner_identity_id.map(ToString::to_string),
            source: Some(source.to_string()),
            source_host_id: source
                .eq_ignore_ascii_case("bridge")
                .then(|| "bridge-host".to_string()),
            bridge_node_id: source
                .eq_ignore_ascii_case("bridge")
                .then(|| format!("node-{}", id.replace(':', "-"))),
            human_id: kind
                .eq_ignore_ascii_case("human")
                .then(|| id.trim_start_matches("human:").to_string()),
            agent_id: kind
                .eq_ignore_ascii_case("agent")
                .then(|| id.trim_start_matches("agent:").to_string()),
            avatar_key: Some(id.to_string()),
            profile_image_url: None,
            metadata: None,
        },
    )
    .expect("seed identity")
}

mod desktop_sync;
mod direct_message_sync;
mod group_authority;
mod group_titles;
mod identity_sessions;
mod profile_adoption;
mod profile_lifecycle;
mod replay_idempotence;
mod session_observation;
mod session_titles;
mod wire_identity;
