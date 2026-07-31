//! Shared fixtures and scenario partitions for relay and durable-mailbox behavior.

use super::relay_test_support::{
    seed_registered_node, seed_registered_node_with_policy, RegisteredNodePolicy,
};
use super::*;
use std::path::{Path, PathBuf};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;

fn test_db_path() -> PathBuf {
    std::env::temp_dir().join(format!("bridges-relay-test-{}.db", Uuid::new_v4()))
}

fn test_state_for_path(db_path: &Path) -> Arc<ServerState> {
    let conn = Connection::open(db_path).unwrap();
    super::super::init_server_db(&conn).unwrap();
    drop(conn);
    Arc::new(ServerState::new(db_path.to_path_buf()))
}

fn seed_mailbox_entry(state: &ServerState, from: &str, to: &str, blob: &str) {
    let mut conn = state.open_connection().unwrap();
    let entry = MailboxEntry {
        from: from.to_string(),
        blob: blob.to_string(),
        project_id: None,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let outcome = enqueue_mailbox_entry(&mut conn, to, &entry, None).unwrap();
    assert!(matches!(outcome, EnqueueOutcome::Inserted { .. }));
}

fn seed_contact(state: &ServerState, left: &str, right: &str) {
    let conn = state.open_connection().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![left, right, &now],
    )
    .unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![right, left, now],
    )
    .unwrap();
}

fn seed_project_members(state: &ServerState, project_id: &str, node_ids: &[&str]) {
    let conn = state.open_connection().unwrap();
    let now = chrono::Utc::now().to_rfc3339();
    for node_id in node_ids {
        conn.execute(
            "INSERT OR IGNORE INTO server_members (project_id, node_id, agent_role, joined_at) VALUES (?1, ?2, 'member', ?3)",
            rusqlite::params![project_id, node_id, &now],
        )
        .unwrap();
    }
}

async fn connect_test_derp_client(
    base_url: &str,
    api_key: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut request = format!("{base_url}/ws/derp").into_client_request().unwrap();
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {api_key}").parse().unwrap(),
    );
    let (socket, _) = connect_async(request).await.unwrap();
    socket
}

mod acknowledgement;
mod authorization;
mod persistence;
mod realtime;
