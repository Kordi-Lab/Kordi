use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use base64::Engine as _;
use ed25519_dalek::VerifyingKey;
use rand::Rng;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use super::ServerState;

/// Extension: authenticated node (from a node API key).
#[derive(Clone, Debug)]
pub struct AuthNode(pub String);

/// Generate a random API key: `bridges_sk_` + 32 random bytes base64url.
fn generate_api_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    format!("bridges_sk_{}", encoded)
}

fn hash_api_key(key: &str) -> String {
    let mut h = Sha256::new();
    h.update(key.as_bytes());
    hex::encode(h.finalize())
}

#[derive(Clone, Deserialize)]
pub struct RegisterReq {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "ed25519Pubkey")]
    pub ed25519_pubkey: String,
    #[serde(rename = "x25519Pubkey")]
    pub x25519_pubkey: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "ownerName")]
    pub owner_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RegisterResp {
    #[serde(rename = "apiKey")]
    pub api_key: String,
    #[serde(rename = "nodeId")]
    pub node_id: String,
}

#[derive(Clone, Deserialize)]
pub struct RevokeReq {
    pub reason: Option<String>,
    #[serde(rename = "replacementNodeId")]
    pub replacement_node_id: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct ReplaceReq {
    #[serde(rename = "newNodeId")]
    pub new_node_id: String,
    #[serde(rename = "newApiKey")]
    pub new_api_key: String,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LifecycleResp {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    #[serde(rename = "revokedAt")]
    pub revoked_at: Option<String>,
    #[serde(rename = "revocationReason")]
    pub revocation_reason: Option<String>,
    #[serde(rename = "replacementNodeId")]
    pub replacement_node_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReplaceResp {
    #[serde(rename = "oldNodeId")]
    pub old_node_id: String,
    #[serde(rename = "newNodeId")]
    pub new_node_id: String,
    #[serde(rename = "migratedProjectCount")]
    pub migrated_project_count: i64,
}

struct ValidatedRegisterReq {
    node_id: String,
    ed25519_pubkey: String,
    x25519_pubkey: String,
    display_name: Option<String>,
    owner_name: Option<String>,
}

fn normalize_optional_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn parse_ed25519_pubkey(value: &str) -> Result<([u8; 32], VerifyingKey), StatusCode> {
    let decoded = bs58::decode(value)
        .into_vec()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let bytes: [u8; 32] = decoded.try_into().map_err(|_| StatusCode::BAD_REQUEST)?;
    let verifying = VerifyingKey::from_bytes(&bytes).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok((bytes, verifying))
}

fn parse_x25519_pubkey(value: &str) -> Result<[u8; 32], StatusCode> {
    let decoded = hex::decode(value).map_err(|_| StatusCode::BAD_REQUEST)?;
    decoded.try_into().map_err(|_| StatusCode::BAD_REQUEST)
}

fn validate_register_req(req: &RegisterReq) -> Result<ValidatedRegisterReq, StatusCode> {
    let (ed_pub_bytes, verifying_key) = parse_ed25519_pubkey(&req.ed25519_pubkey)?;
    let x25519_pubkey = parse_x25519_pubkey(&req.x25519_pubkey)?;

    let derived_node_id = crate::identity::derive_node_id(&verifying_key);
    if req.node_id != derived_node_id {
        return Err(StatusCode::BAD_REQUEST);
    }

    let expected_x25519 = crate::crypto::ed25519_to_x25519_public(&ed_pub_bytes)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if x25519_pubkey != expected_x25519 {
        return Err(StatusCode::BAD_REQUEST);
    }

    Ok(ValidatedRegisterReq {
        node_id: derived_node_id,
        ed25519_pubkey: bs58::encode(ed_pub_bytes).into_string(),
        x25519_pubkey: hex::encode(expected_x25519),
        display_name: normalize_optional_text(req.display_name.as_deref()),
        owner_name: normalize_optional_text(req.owner_name.as_deref()),
    })
}

pub fn routes(state: Arc<ServerState>) -> Router {
    let public = Router::new()
        .route("/v1/auth/register", post(register))
        .with_state(state.clone());

    let protected = Router::new()
        .route("/v1/auth/me", get(me))
        .route("/v1/auth/refresh", post(refresh))
        .route("/v1/auth/revoke", post(revoke))
        .route("/v1/auth/replace", post(replace))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .with_state(state);

    public.merge(protected)
}

async fn register(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<RegisterReq>,
) -> Result<Json<RegisterResp>, StatusCode> {
    let validated = validate_register_req(&req)?;
    let api_key = generate_api_key();
    let key_hash = hash_api_key(&api_key);
    let now = chrono::Utc::now().to_rfc3339();

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let existing: Option<(String, String, Option<String>)> = db
        .query_row(
            "SELECT ed25519_pubkey, x25519_pubkey, revoked_at FROM registered_nodes WHERE node_id = ?1",
            rusqlite::params![validated.node_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if let Some((existing_ed25519, existing_x25519, revoked_at)) = existing {
        if revoked_at.is_some() {
            return Err(StatusCode::GONE);
        }
        if existing_ed25519 != validated.ed25519_pubkey
            || existing_x25519 != validated.x25519_pubkey
        {
            return Err(StatusCode::CONFLICT);
        }

        db.execute(
            "UPDATE registered_nodes SET display_name = ?1, owner_name = ?2, api_key_hash = ?3 WHERE node_id = ?4",
            rusqlite::params![
                validated.display_name,
                validated.owner_name,
                key_hash,
                validated.node_id,
            ],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    } else {
        db.execute(
            "INSERT INTO registered_nodes \
             (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, api_key_hash, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                validated.node_id,
                validated.ed25519_pubkey,
                validated.x25519_pubkey,
                validated.display_name,
                validated.owner_name,
                key_hash,
                now,
            ],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    Ok(Json(RegisterResp {
        api_key,
        node_id: validated.node_id,
    }))
}

async fn me(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
) -> Result<Json<LifecycleResp>, StatusCode> {
    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.query_row(
        "SELECT node_id, revoked_at, revocation_reason, replacement_node_id FROM registered_nodes WHERE node_id = ?1",
        rusqlite::params![auth.0],
        |row| {
            Ok(LifecycleResp {
                node_id: row.get(0)?,
                revoked_at: row.get(1)?,
                revocation_reason: row.get(2)?,
                replacement_node_id: row.get(3)?,
            })
        },
    )
    .map(Json)
    .map_err(|_| StatusCode::NOT_FOUND)
}

async fn refresh(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
) -> Result<Json<RegisterResp>, StatusCode> {
    let node_id = extract_node_id(&state, &headers)
        .await
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let api_key = generate_api_key();
    let key_hash = hash_api_key(&api_key);

    let db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    db.execute(
        "UPDATE registered_nodes SET api_key_hash = ?1 WHERE node_id = ?2",
        rusqlite::params![key_hash, node_id],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(RegisterResp { api_key, node_id }))
}

async fn revoke(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<RevokeReq>,
) -> Result<Json<LifecycleResp>, StatusCode> {
    let replacement_node_id = normalize_optional_text(req.replacement_node_id.as_deref());
    if replacement_node_id.as_deref() == Some(auth.0.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let revoked_at = chrono::Utc::now().to_rfc3339();
    let reason = normalize_optional_text(req.reason.as_deref());
    let mut db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let tx = db
        .transaction()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if let Some(replacement_node_id) = replacement_node_id.as_deref() {
        let replacement_exists = tx
            .query_row(
                "SELECT 1 FROM registered_nodes WHERE node_id = ?1 AND revoked_at IS NULL",
                rusqlite::params![replacement_node_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            .is_some();
        if !replacement_exists {
            return Err(StatusCode::BAD_REQUEST);
        }
    }

    tx.execute(
        "UPDATE registered_nodes SET revoked_at = ?1, revocation_reason = ?2, replacement_node_id = ?3, endpoint_hints = NULL, api_key_hash = '' WHERE node_id = ?4",
        rusqlite::params![revoked_at, reason, replacement_node_id, auth.0],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(LifecycleResp {
        node_id: auth.0,
        revoked_at: Some(revoked_at),
        revocation_reason: reason,
        replacement_node_id,
    }))
}

async fn replace(
    State(state): State<Arc<ServerState>>,
    Extension(auth): Extension<AuthNode>,
    Json(req): Json<ReplaceReq>,
) -> Result<Json<ReplaceResp>, StatusCode> {
    if req.new_node_id == auth.0 {
        return Err(StatusCode::BAD_REQUEST);
    }

    let now = chrono::Utc::now().to_rfc3339();
    let reason = normalize_optional_text(req.reason.as_deref())
        .or_else(|| Some("replaced_by_rotation".to_string()));
    let new_api_key_hash = hash_api_key(&req.new_api_key);

    let mut db = state
        .open_connection()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let tx = db
        .transaction()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let replacement_exists = tx
        .query_row(
            "SELECT 1 FROM registered_nodes WHERE node_id = ?1 AND api_key_hash = ?2 AND revoked_at IS NULL",
            rusqlite::params![req.new_node_id, new_api_key_hash],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .is_some();
    if !replacement_exists {
        return Err(StatusCode::BAD_REQUEST);
    }

    let replacement_membership_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM server_members WHERE node_id = ?1",
            rusqlite::params![req.new_node_id],
            |row| row.get(0),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if replacement_membership_count > 0 {
        return Err(StatusCode::CONFLICT);
    }

    let replacement_project_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM server_projects WHERE created_by = ?1",
            rusqlite::params![req.new_node_id],
            |row| row.get(0),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if replacement_project_count > 0 {
        return Err(StatusCode::CONFLICT);
    }

    let migrated_project_count: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM server_members WHERE node_id = ?1",
            rusqlite::params![auth.0],
            |row| row.get(0),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.execute(
        "INSERT INTO server_members (project_id, node_id, agent_role, joined_at)
         SELECT project_id, ?1, agent_role, ?2 FROM server_members WHERE node_id = ?3
         ON CONFLICT(project_id, node_id) DO UPDATE SET agent_role = excluded.agent_role",
        rusqlite::params![req.new_node_id, now, auth.0],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.execute(
        "DELETE FROM server_members WHERE node_id = ?1",
        rusqlite::params![auth.0],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.execute(
        "UPDATE server_projects SET created_by = ?1 WHERE created_by = ?2",
        rusqlite::params![req.new_node_id, auth.0],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.execute(
        "UPDATE registered_nodes SET revoked_at = ?1, revocation_reason = ?2, replacement_node_id = ?3, endpoint_hints = NULL, api_key_hash = '' WHERE node_id = ?4",
        rusqlite::params![now, reason, req.new_node_id, auth.0],
    )
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tx.commit().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(ReplaceResp {
        old_node_id: auth.0,
        new_node_id: req.new_node_id,
        migrated_project_count,
    }))
}

/// Middleware: verify Bearer token against `registered_nodes.api_key_hash` and inject `AuthNode`.
pub async fn auth_middleware(
    State(state): State<Arc<ServerState>>,
    mut req: Request,
    next: Next,
) -> Response {
    let token = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    let token = match token {
        Some(t) => t,
        None => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let token_hash = hash_api_key(token);
    let db = match state.open_connection() {
        Ok(db) => db,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let node_id: Option<String> = db
        .query_row(
            "SELECT node_id FROM registered_nodes WHERE api_key_hash = ?1 AND revoked_at IS NULL",
            rusqlite::params![token_hash],
            |row| row.get(0),
        )
        .ok();

    let Some(node_id) = node_id else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    req.extensions_mut().insert(AuthNode(node_id));
    next.run(req).await
}

/// Helper to extract node_id from Bearer token in headers.
pub async fn extract_node_id(state: &ServerState, headers: &HeaderMap) -> Option<String> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))?;
    let token_hash = hash_api_key(token);
    let db = state.open_connection().ok()?;

    db.query_row(
        "SELECT node_id FROM registered_nodes WHERE api_key_hash = ?1 AND revoked_at IS NULL",
        rusqlite::params![token_hash],
        |row| row.get(0),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use ed25519_dalek::SigningKey;
    use rand::rngs::OsRng;
    fn test_state() -> Arc<ServerState> {
        super::super::make_test_state()
    }

    fn register_req_from_signing(signing: &SigningKey) -> RegisterReq {
        let verifying = signing.verifying_key();
        let node_id = crate::identity::derive_node_id(&verifying);
        let x25519 = crate::crypto::ed25519_to_x25519_public(verifying.as_bytes()).unwrap();
        RegisterReq {
            node_id,
            ed25519_pubkey: bs58::encode(verifying.as_bytes()).into_string(),
            x25519_pubkey: hex::encode(x25519),
            display_name: Some("node".to_string()),
            owner_name: Some("owner".to_string()),
        }
    }

    fn auth_headers(api_key: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            format!("Bearer {}", api_key).parse().unwrap(),
        );
        headers
    }

    fn seed_project_membership(
        state: &Arc<ServerState>,
        project_id: &str,
        node_id: &str,
        role: &str,
    ) {
        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT OR IGNORE INTO server_projects (project_id, slug, display_name, description, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![project_id, project_id, project_id, Option::<String>::None, node_id, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO server_members (project_id, node_id, agent_role, joined_at) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![project_id, node_id, role, chrono::Utc::now().to_rfc3339()],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn register_rejects_mismatched_node_id() {
        let state = test_state();
        let signing = SigningKey::generate(&mut OsRng);
        let mut req = register_req_from_signing(&signing);
        req.node_id = "kd_wrong".to_string();

        let result = register(State(state), Json(req)).await;
        assert_eq!(result.unwrap_err(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn register_rejects_mismatched_x25519_pubkey() {
        let state = test_state();
        let signing = SigningKey::generate(&mut OsRng);
        let mut req = register_req_from_signing(&signing);
        req.x25519_pubkey = hex::encode([7u8; 32]);

        let result = register(State(state), Json(req)).await;
        assert_eq!(result.unwrap_err(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn register_rejects_overwrite_of_existing_node_with_different_keys() {
        let state = test_state();
        let signing = SigningKey::generate(&mut OsRng);
        let req = register_req_from_signing(&signing);

        let other = SigningKey::generate(&mut OsRng);
        let other_verifying = other.verifying_key();
        let other_x25519 =
            crate::crypto::ed25519_to_x25519_public(other_verifying.as_bytes()).unwrap();

        let db = state.open_connection().unwrap();
        db.execute(
            "INSERT INTO registered_nodes (node_id, ed25519_pubkey, x25519_pubkey, display_name, owner_name, api_key_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                req.node_id,
                bs58::encode(other_verifying.as_bytes()).into_string(),
                hex::encode(other_x25519),
                "other",
                Option::<String>::None,
                "hash",
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .unwrap();

        let result = register(State(state), Json(req)).await;
        assert_eq!(result.unwrap_err(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn register_allows_reregister_with_same_keys_and_rotates_api_key() {
        let state = test_state();
        let signing = SigningKey::generate(&mut OsRng);
        let req = register_req_from_signing(&signing);

        let first = register(State(state.clone()), Json(req.clone()))
            .await
            .unwrap()
            .0;
        let second = register(State(state.clone()), Json(req)).await.unwrap().0;

        assert_eq!(first.node_id, second.node_id);
        assert_ne!(first.api_key, second.api_key);
    }

    #[tokio::test]
    async fn refresh_invalidates_old_api_key() {
        let state = test_state();
        let signing = SigningKey::generate(&mut OsRng);
        let req = register_req_from_signing(&signing);
        let registered = register(State(state.clone()), Json(req)).await.unwrap().0;

        let headers = auth_headers(&registered.api_key);
        let refreshed = refresh(State(state.clone()), headers.clone())
            .await
            .unwrap()
            .0;

        let old = extract_node_id(&state, &headers).await;
        assert!(old.is_none());

        let new_headers = auth_headers(&refreshed.api_key);
        let node_id = extract_node_id(&state, &new_headers).await;
        assert_eq!(node_id.as_deref(), Some(refreshed.node_id.as_str()));
    }

    #[tokio::test]
    async fn revoke_invalidates_auth_and_records_replacement() {
        let state = test_state();
        let old = SigningKey::generate(&mut OsRng);
        let old_registered = register(State(state.clone()), Json(register_req_from_signing(&old)))
            .await
            .unwrap()
            .0;

        let replacement = SigningKey::generate(&mut OsRng);
        let replacement_registered = register(
            State(state.clone()),
            Json(register_req_from_signing(&replacement)),
        )
        .await
        .unwrap()
        .0;

        let response = revoke(
            State(state.clone()),
            Extension(AuthNode(old_registered.node_id.clone())),
            Json(RevokeReq {
                reason: Some("compromised".to_string()),
                replacement_node_id: Some(replacement_registered.node_id.clone()),
            }),
        )
        .await
        .unwrap()
        .0;

        assert!(response.revoked_at.is_some());
        assert_eq!(
            response.replacement_node_id.as_deref(),
            Some(replacement_registered.node_id.as_str())
        );
        assert_eq!(response.revocation_reason.as_deref(), Some("compromised"));
        assert!(
            extract_node_id(&state, &auth_headers(&old_registered.api_key))
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn replace_rejects_replacement_node_with_existing_memberships() {
        let state = test_state();
        let old = SigningKey::generate(&mut OsRng);
        let old_registered = register(State(state.clone()), Json(register_req_from_signing(&old)))
            .await
            .unwrap()
            .0;
        let replacement = SigningKey::generate(&mut OsRng);
        let replacement_registered = register(
            State(state.clone()),
            Json(register_req_from_signing(&replacement)),
        )
        .await
        .unwrap()
        .0;

        seed_project_membership(
            &state,
            "proj_replacement_busy",
            &replacement_registered.node_id,
            "member",
        );

        let result = replace(
            State(state.clone()),
            Extension(AuthNode(old_registered.node_id.clone())),
            Json(ReplaceReq {
                new_node_id: replacement_registered.node_id.clone(),
                new_api_key: replacement_registered.api_key.clone(),
                reason: None,
            }),
        )
        .await;

        assert_eq!(result.unwrap_err(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn replace_migrates_memberships_and_revokes_old_node() {
        let state = test_state();
        let old = SigningKey::generate(&mut OsRng);
        let old_registered = register(State(state.clone()), Json(register_req_from_signing(&old)))
            .await
            .unwrap()
            .0;
        let replacement = SigningKey::generate(&mut OsRng);
        let replacement_registered = register(
            State(state.clone()),
            Json(register_req_from_signing(&replacement)),
        )
        .await
        .unwrap()
        .0;

        seed_project_membership(&state, "proj_rotate", &old_registered.node_id, "owner");

        let response = replace(
            State(state.clone()),
            Extension(AuthNode(old_registered.node_id.clone())),
            Json(ReplaceReq {
                new_node_id: replacement_registered.node_id.clone(),
                new_api_key: replacement_registered.api_key.clone(),
                reason: None,
            }),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(response.old_node_id, old_registered.node_id);
        assert_eq!(response.new_node_id, replacement_registered.node_id);
        assert_eq!(response.migrated_project_count, 1);
        assert!(
            extract_node_id(&state, &auth_headers(&old_registered.api_key))
                .await
                .is_none()
        );
        assert_eq!(
            extract_node_id(&state, &auth_headers(&replacement_registered.api_key))
                .await
                .as_deref(),
            Some(replacement_registered.node_id.as_str())
        );

        let db = state.open_connection().unwrap();
        let role: String = db
            .query_row(
                "SELECT agent_role FROM server_members WHERE project_id = ?1 AND node_id = ?2",
                rusqlite::params!["proj_rotate", replacement_registered.node_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(role, "owner");
        let old_member_exists = db
            .query_row(
                "SELECT 1 FROM server_members WHERE project_id = ?1 AND node_id = ?2",
                rusqlite::params!["proj_rotate", old_registered.node_id],
                |_| Ok(()),
            )
            .optional()
            .unwrap()
            .is_some();
        assert!(!old_member_exists);
    }
}
