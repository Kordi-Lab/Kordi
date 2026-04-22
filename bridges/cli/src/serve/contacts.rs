use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{middleware, Extension, Json, Router};
use serde::Serialize;
use std::sync::Arc;

use super::auth::{auth_middleware, AuthNode};
use super::ServerState;

#[derive(Debug, Serialize)]
pub struct ContactResp {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "ownerName")]
    pub owner_name: Option<String>,
    pub runtime: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/contacts", get(list_contacts))
        .route(
            "/v1/contacts/:node_id",
            put(add_contact).delete(remove_contact),
        )
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state)
}

async fn list_contacts(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
) -> Result<Json<Vec<ContactResp>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT r.node_id, r.display_name, r.owner_name, r.runtime, c.created_at \
             FROM server_contacts c \
             JOIN registered_nodes r ON r.node_id = c.contact_node_id \
             WHERE c.node_id = ?1 AND r.revoked_at IS NULL \
             ORDER BY COALESCE(r.display_name, r.owner_name, r.node_id) ASC, c.created_at ASC",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let contacts = stmt
        .query_map(rusqlite::params![auth.0], |row| {
            Ok(ContactResp {
                node_id: row.get(0)?,
                display_name: row.get(1)?,
                owner_name: row.get(2)?,
                runtime: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|row| row.ok())
        .collect();
    Ok(Json(contacts))
}

async fn add_contact(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(node_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let target = node_id.trim();
    let my_node_id = auth.0;
    if target.is_empty() || target == my_node_id.as_str() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let target_exists = db
        .query_row(
            "SELECT 1 FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
            rusqlite::params![target],
            |_| Ok(()),
        )
        .is_ok();
    if !target_exists {
        return Err(StatusCode::NOT_FOUND);
    }

    let now = chrono::Utc::now().to_rfc3339();
    db.execute(
        "INSERT OR IGNORE INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![&my_node_id, target, &now],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "INSERT OR IGNORE INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![target, &my_node_id, &now],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}

async fn remove_contact(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(node_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    let target = node_id.trim();
    let my_node_id = auth.0;
    if target.is_empty() || target == my_node_id.as_str() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "DELETE FROM server_contacts WHERE (node_id = ?1 AND contact_node_id = ?2) OR (node_id = ?2 AND contact_node_id = ?1)",
        rusqlite::params![&my_node_id, target],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_registered_node(state: &Arc<ServerState>, node_id: &str, runtime: Option<&str>) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, runtime, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                node_id,
                format!("ed_{node_id}"),
                format!("x_{node_id}"),
                format!("display-{node_id}"),
                format!("owner-{node_id}"),
                runtime,
                format!("hash_{node_id}"),
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn add_contact_creates_bidirectional_visibility() {
        let state = super::super::make_test_state();
        seed_registered_node(&state, "kd_alice", Some("generic"));
        seed_registered_node(&state, "kd_bob", Some("codex"));

        let status = add_contact(
            State(state.clone()),
            Extension(AuthNode("kd_alice".to_string())),
            Path("kd_bob".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::NO_CONTENT);

        let alice_contacts = list_contacts(
            State(state.clone()),
            Extension(AuthNode("kd_alice".to_string())),
        )
        .await
        .unwrap()
        .0;
        let bob_contacts = list_contacts(State(state), Extension(AuthNode("kd_bob".to_string())))
            .await
            .unwrap()
            .0;

        assert_eq!(alice_contacts.len(), 1);
        assert_eq!(alice_contacts[0].node_id, "kd_bob");
        assert_eq!(alice_contacts[0].runtime.as_deref(), Some("codex"));
        assert_eq!(bob_contacts.len(), 1);
        assert_eq!(bob_contacts[0].node_id, "kd_alice");
    }

    #[tokio::test]
    async fn remove_contact_clears_both_directions() {
        let state = super::super::make_test_state();
        seed_registered_node(&state, "kd_alice", None);
        seed_registered_node(&state, "kd_bob", None);

        add_contact(
            State(state.clone()),
            Extension(AuthNode("kd_alice".to_string())),
            Path("kd_bob".to_string()),
        )
        .await
        .unwrap();

        let status = remove_contact(
            State(state.clone()),
            Extension(AuthNode("kd_alice".to_string())),
            Path("kd_bob".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::NO_CONTENT);

        let alice_contacts = list_contacts(
            State(state.clone()),
            Extension(AuthNode("kd_alice".to_string())),
        )
        .await
        .unwrap()
        .0;
        let bob_contacts = list_contacts(State(state), Extension(AuthNode("kd_bob".to_string())))
            .await
            .unwrap()
            .0;

        assert!(alice_contacts.is_empty());
        assert!(bob_contacts.is_empty());
    }
}
