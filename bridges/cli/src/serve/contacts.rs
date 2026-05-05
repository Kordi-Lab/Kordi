use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{middleware, Extension, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::auth::{auth_middleware, AuthNode};
use super::{
    effective_contact_approval_policy, nodes_are_contacts, nodes_have_rejected_contact_request,
    ServerState,
};

#[derive(Debug, Serialize)]
pub struct ContactResp {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "ownerName")]
    pub owner_name: Option<String>,
    pub runtime: Option<String>,
    #[serde(rename = "humanId")]
    pub human_id: Option<String>,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    #[serde(rename = "isDefaultAgent")]
    pub is_default_agent: bool,
    #[serde(rename = "discoveryMode")]
    pub discovery_mode: Option<String>,
    #[serde(rename = "humanVisibilityPolicy")]
    pub human_visibility_policy: Option<String>,
    #[serde(rename = "contactApprovalPolicy")]
    pub contact_approval_policy: Option<String>,
    #[serde(rename = "agentReachabilityPolicy")]
    pub agent_reachability_policy: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ContactRequestReq {
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ContactRequestResp {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "requesterNodeId")]
    pub requester_node_id: String,
    #[serde(rename = "targetNodeId")]
    pub target_node_id: String,
    pub status: String,
    pub message: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "decidedAt")]
    pub decided_at: Option<String>,
    pub direction: String,
}

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/contacts", get(list_contacts))
        .route(
            "/v1/contacts/:node_id",
            put(add_contact).delete(remove_contact),
        )
        .route("/v1/contact-requests", get(list_contact_requests))
        .route("/v1/contact-requests/:node_id", post(request_contact))
        .route(
            "/v1/contact-requests/:request_id/approve",
            post(approve_contact_request),
        )
        .route(
            "/v1/contact-requests/:request_id/reject",
            post(reject_contact_request),
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
            "SELECT r.node_id, r.display_name, r.owner_name, r.runtime, r.human_id, r.agent_id, r.is_default_agent, r.discovery_mode, r.human_visibility_policy, r.contact_approval_policy, r.agent_reachability_policy, c.created_at \
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
                human_id: row.get(4)?,
                agent_id: row.get(5)?,
                is_default_agent: row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
                discovery_mode: row.get(7)?,
                human_visibility_policy: row.get(8)?,
                contact_approval_policy: row.get(9)?,
                agent_reachability_policy: row.get(10)?,
                created_at: row.get(11)?,
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|row| row.ok())
        .collect();
    Ok(Json(contacts))
}

fn normalize_request_message(message: Option<&str>) -> Option<String> {
    message
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn target_exists(
    conn: &rusqlite::Connection,
    target_node_id: &str,
) -> Result<bool, rusqlite::Error> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
            rusqlite::params![target_node_id],
            |_| Ok(()),
        )
        .is_ok())
}

fn target_contact_approval_policy(
    conn: &rusqlite::Connection,
    target_node_id: &str,
) -> Result<String, rusqlite::Error> {
    let policy = conn.query_row(
        "SELECT contact_approval_policy FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
        rusqlite::params![target_node_id],
        |row| row.get::<_, Option<String>>(0),
    )?;
    Ok(effective_contact_approval_policy(policy.as_deref()))
}

fn create_bidirectional_contact(
    conn: &rusqlite::Connection,
    left_node_id: &str,
    right_node_id: &str,
    created_at: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![left_node_id, right_node_id, created_at],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO server_contacts (node_id, contact_node_id, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![right_node_id, left_node_id, created_at],
    )?;
    Ok(())
}

fn record_contact_removal(
    conn: &rusqlite::Connection,
    remover_node_id: &str,
    removed_node_id: &str,
    removed_at: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE server_contact_requests
         SET status = 'rejected', decided_at = ?3
         WHERE ((requester_node_id = ?1 AND target_node_id = ?2) OR (requester_node_id = ?2 AND target_node_id = ?1))
           AND status != 'rejected'",
        rusqlite::params![remover_node_id, removed_node_id, removed_at],
    )?;
    conn.execute(
        "INSERT INTO server_contact_requests (request_id, requester_node_id, target_node_id, status, message, created_at, decided_at)
         VALUES (?1, ?2, ?3, 'rejected', ?4, ?5, ?5)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            removed_node_id,
            remover_node_id,
            Some("Contact deleted"),
            removed_at,
        ],
    )?;
    Ok(())
}

fn create_or_request_contact(
    conn: &rusqlite::Connection,
    requester_node_id: &str,
    target_node_id: &str,
    message: Option<&str>,
) -> Result<StatusCode, StatusCode> {
    if !target_exists(conn, target_node_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? {
        return Err(StatusCode::NOT_FOUND);
    }
    if nodes_are_contacts(conn, requester_node_id, target_node_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        return Ok(StatusCode::NO_CONTENT);
    }

    let approval_policy = target_contact_approval_policy(conn, target_node_id)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let has_rejected_relationship =
        nodes_have_rejected_contact_request(conn, requester_node_id, target_node_id)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let now = chrono::Utc::now().to_rfc3339();
    if approval_policy == "auto" && !has_rejected_relationship {
        create_bidirectional_contact(conn, requester_node_id, target_node_id, &now)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        return Ok(StatusCode::NO_CONTENT);
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let message = normalize_request_message(message);
    let updated = conn
        .execute(
            "UPDATE server_contact_requests
             SET message = COALESCE(?1, message), created_at = ?2, decided_at = NULL, status = 'pending'
             WHERE requester_node_id = ?3 AND target_node_id = ?4 AND status = 'pending'",
            rusqlite::params![message, &now, requester_node_id, target_node_id],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if updated == 0 {
        conn.execute(
            "INSERT INTO server_contact_requests (request_id, requester_node_id, target_node_id, status, message, created_at, decided_at)
             VALUES (?1, ?2, ?3, 'pending', ?4, ?5, NULL)",
            rusqlite::params![request_id, requester_node_id, target_node_id, message, now],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    Ok(StatusCode::ACCEPTED)
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
    create_or_request_contact(&db, &my_node_id, target, None)
}

async fn request_contact(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(node_id): Path<String>,
    Json(req): Json<ContactRequestReq>,
) -> Result<StatusCode, StatusCode> {
    let target = node_id.trim();
    let my_node_id = auth.0;
    if target.is_empty() || target == my_node_id.as_str() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    create_or_request_contact(&db, &my_node_id, target, req.message.as_deref())
}

async fn list_contact_requests(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
) -> Result<Json<Vec<ContactRequestResp>>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut stmt = db
        .prepare(
            "SELECT request_id, requester_node_id, target_node_id, status, message, created_at, decided_at
             FROM server_contact_requests
             WHERE requester_node_id = ?1 OR target_node_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let auth_node_id = auth.0;
    let requests = stmt
        .query_map(rusqlite::params![auth_node_id.as_str()], |row| {
            let requester_node_id = row.get::<_, String>(1)?;
            let target_node_id = row.get::<_, String>(2)?;
            let direction = if target_node_id == auth_node_id {
                "incoming"
            } else if requester_node_id == auth_node_id {
                "outgoing"
            } else {
                "related"
            };
            Ok(ContactRequestResp {
                request_id: row.get(0)?,
                requester_node_id,
                target_node_id,
                status: row.get(3)?,
                message: row.get(4)?,
                created_at: row.get(5)?,
                decided_at: row.get(6)?,
                direction: direction.to_string(),
            })
        })
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .filter_map(|row| row.ok())
        .collect();
    Ok(Json(requests))
}

async fn decide_contact_request(
    state: Arc<ServerState>,
    approver_node_id: String,
    request_id: String,
    next_status: &str,
) -> Result<StatusCode, StatusCode> {
    if !matches!(next_status, "approved" | "rejected") {
        return Err(StatusCode::BAD_REQUEST);
    }
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let request = db
        .query_row(
            "SELECT requester_node_id, target_node_id, status FROM server_contact_requests WHERE request_id = ?1",
            rusqlite::params![request_id.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let (requester_node_id, target_node_id, status) = request;
    if target_node_id != approver_node_id || status != "pending" {
        return Err(StatusCode::FORBIDDEN);
    }

    let now = chrono::Utc::now().to_rfc3339();
    if next_status == "approved" {
        create_bidirectional_contact(&db, &requester_node_id, &target_node_id, &now)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    db.execute(
        "UPDATE server_contact_requests SET status = ?1, decided_at = ?2 WHERE request_id = ?3",
        rusqlite::params![next_status, now, request_id],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn approve_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(request_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    decide_contact_request(state, auth.0, request_id, "approved").await
}

async fn reject_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Path(request_id): Path<String>,
) -> Result<StatusCode, StatusCode> {
    decide_contact_request(state, auth.0, request_id, "rejected").await
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
    let now = chrono::Utc::now().to_rfc3339();
    record_contact_removal(&db, &my_node_id, target, &now)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_registered_node(state: &Arc<ServerState>, node_id: &str, runtime: Option<&str>) {
        seed_registered_node_with_approval(state, node_id, runtime, Some("auto"));
    }

    fn seed_registered_node_with_approval(
        state: &Arc<ServerState>,
        node_id: &str,
        runtime: Option<&str>,
        contact_approval_policy: Option<&str>,
    ) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, runtime, contact_approval_policy, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                node_id,
                format!("ed_{node_id}"),
                format!("x_{node_id}"),
                format!("display-{node_id}"),
                format!("owner-{node_id}"),
                runtime,
                contact_approval_policy,
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
    async fn remove_contact_clears_both_directions_and_blocks_new_direct_messages() {
        let state = super::super::make_test_state();
        seed_registered_node(&state, "kd_alice", None);
        seed_registered_node(&state, "kd_bob", None);
        state
            .open_connection()
            .unwrap()
            .execute(
                "UPDATE registered_nodes SET human_visibility_policy = 'server-open', contact_approval_policy = 'auto' WHERE node_id = 'kd_alice'",
                [],
            )
            .unwrap();

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
        let bob_contacts = list_contacts(
            State(state.clone()),
            Extension(AuthNode("kd_bob".to_string())),
        )
        .await
        .unwrap()
        .0;
        let bob_requests = list_contact_requests(
            State(state.clone()),
            Extension(AuthNode("kd_bob".to_string())),
        )
        .await
        .unwrap()
        .0;
        let db = state.open_connection().unwrap();

        assert!(alice_contacts.is_empty());
        assert!(bob_contacts.is_empty());
        assert!(bob_requests.iter().any(|request| {
            request.requester_node_id == "kd_bob"
                && request.target_node_id == "kd_alice"
                && request.status == "rejected"
        }));
        assert!(!super::super::nodes_can_directly_reach(
            &db,
            "kd_bob",
            "kd_alice",
            super::super::DirectAccessKind::Person,
        )
        .unwrap());
    }

    #[tokio::test]
    async fn add_contact_for_approval_required_target_waits_for_target_approval() {
        let state = super::super::make_test_state();
        seed_registered_node(&state, "kd_alice", Some("generic"));
        seed_registered_node_with_approval(
            &state,
            "kd_bob",
            Some("codex"),
            Some("approval-required"),
        );

        let status = add_contact(
            State(state.clone()),
            Extension(AuthNode("kd_alice".to_string())),
            Path("kd_bob".to_string()),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::ACCEPTED);

        let alice_contacts = list_contacts(
            State(state.clone()),
            Extension(AuthNode("kd_alice".to_string())),
        )
        .await
        .unwrap()
        .0;
        assert!(alice_contacts.is_empty());

        let bob_requests = list_contact_requests(
            State(state.clone()),
            Extension(AuthNode("kd_bob".to_string())),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(bob_requests.len(), 1);
        assert_eq!(bob_requests[0].requester_node_id, "kd_alice");
        assert_eq!(bob_requests[0].target_node_id, "kd_bob");
        assert_eq!(bob_requests[0].status, "pending");
        assert_eq!(bob_requests[0].direction, "incoming");

        let approved = approve_contact_request(
            State(state.clone()),
            Extension(AuthNode("kd_bob".to_string())),
            Path(bob_requests[0].request_id.clone()),
        )
        .await
        .unwrap();
        assert_eq!(approved, StatusCode::NO_CONTENT);

        let bob_contacts = list_contacts(State(state), Extension(AuthNode("kd_bob".to_string())))
            .await
            .unwrap()
            .0;
        assert_eq!(bob_contacts.len(), 1);
        assert_eq!(bob_contacts[0].node_id, "kd_alice");
    }
}
