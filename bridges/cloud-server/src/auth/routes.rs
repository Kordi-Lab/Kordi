//! HTTP routes for the Cloud Edition email/password auth slice.
//!
//! Mounted under `/v1/cloud/auth/*`, `/v1/cloud/accounts/:id/profile`, and
//! `/v1/cloud/contacts`. Layered on top of `auth::accounts` (DB),
//! `auth::password` (hashing/policy), `auth::session` (token lifecycle),
//! and `auth::rate_limit` (in-memory abuse mitigation).

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::auth::password::{
    hash_password, validate_email, validate_password_strength, verify_password,
    EmailFormatError, PasswordHasherConfig, PasswordPolicyError, PASSWORD_ALGORITHM_ID,
};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::session::{
    bump_expiry, hash_session_token, issue_session, lookup_session, revoke_session,
    DEFAULT_SESSION_LIFETIME_DAYS, SESSION_TOKEN_PREFIX,
};
use crate::db_runner::DbRunnerError;
use crate::server::ServerState;

/// Internal outcome for the login closure that runs inside the single-writer
/// runner. The handler converts this into a `Response` after the blocking
/// section completes, so all rate-limit bookkeeping happens on the async
/// side where the limiter lives.
enum LoginOutcome {
    Authenticated {
        account: AccountResponse,
        session_token: String,
        session_expires_at: chrono::DateTime<chrono::Utc>,
    },
    AccountMissingOrNoPassword {
        account_id: Option<String>,
    },
    WrongPassword {
        account_id: String,
    },
    PasswordVerifyError,
    DbError,
}

#[derive(Debug)]
enum LoginRunnerError {
    Db(DbRunnerError),
}

impl From<DbRunnerError> for LoginRunnerError {
    fn from(value: DbRunnerError) -> Self {
        Self::Db(value)
    }
}

const AVATAR_SEED_PREFIX: &str = "kordi-pixel-avatar://";
const SIGNUP_DEFAULT_DEVICE_NAME: &str = "cloud-email-password-device";

#[derive(Debug, Clone)]
pub struct CloudSession {
    pub token_id: String,
    pub account_id: String,
    pub device_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarSeed")]
    pub avatar_seed: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct AccountResponse {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "primaryEmail")]
    pub primary_email: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    #[serde(rename = "passwordSet")]
    pub password_set: bool,
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub token: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub account: AccountResponse,
    pub session: SessionResponse,
}

#[derive(Debug, Serialize)]
pub struct PublicProfileResponse {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    #[serde(rename = "isContact")]
    pub is_contact: bool,
    #[serde(rename = "isSelf")]
    pub is_self: bool,
}

#[derive(Debug, Deserialize)]
pub struct AddContactRequest {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
}

#[derive(Debug, Serialize)]
pub struct ContactSummary {
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(rename = "nodeId")]
    pub node_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct ContactsListResponse {
    pub contacts: Vec<ContactSummary>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    #[serde(rename = "errorCode")]
    error_code: &'static str,
    message: String,
}

fn err(code: &'static str, message: impl Into<String>, status: StatusCode) -> Response {
    let body = ErrorBody {
        error_code: code,
        message: message.into(),
    };
    (status, Json(body)).into_response()
}

fn limited_response(retry_after: std::time::Duration) -> Response {
    let secs = retry_after.as_secs().max(1);
    let mut response = err("rate_limited", "Too many attempts. Try again shortly.", StatusCode::TOO_MANY_REQUESTS);
    response
        .headers_mut()
        .insert("Retry-After", secs.to_string().parse().unwrap());
    response
}

fn map_password_policy(err_value: PasswordPolicyError) -> Response {
    err("weak_password", err_value.to_string(), StatusCode::BAD_REQUEST)
}

fn map_email_format(err_value: EmailFormatError) -> Response {
    err("invalid_email", err_value.to_string(), StatusCode::BAD_REQUEST)
}

fn ip_from_extension(ip: Option<&ConnectInfo<SocketAddr>>) -> Option<IpAddr> {
    ip.map(|info| info.0.ip())
}

fn bearer_token_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer ").map(str::trim))
}

fn account_response_row(
    conn: &rusqlite::Connection,
    account_id: &str,
) -> Result<Option<AccountResponse>, rusqlite::Error> {
    // Bridges-node lookup belonged to the local-first server and has been
    // removed from the cloud server. The desktop pairs cloud accounts with
    // bridges nodes via a separate flow against `bridges/cli`.
    let node_id: Option<String> = None;
    conn.query_row(
        "SELECT account_id, display_name, primary_email, avatar_url, password_hash \
         FROM cloud_accounts WHERE account_id = ?1",
        rusqlite::params![account_id],
        |row| {
            let password_hash: Option<String> = row.get(4)?;
            Ok(AccountResponse {
                account_id: row.get(0)?,
                display_name: row.get(1)?,
                primary_email: row.get(2)?,
                avatar_url: row.get(3)?,
                node_id: node_id.clone(),
                password_set: password_hash.is_some(),
            })
        },
    )
    .optional()
}

fn write_audit(
    conn: &rusqlite::Connection,
    account_id: Option<&str>,
    device_id: Option<&str>,
    event_type: &str,
    metadata_json: serde_json::Value,
) -> Result<(), rusqlite::Error> {
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    conn.execute(
        "INSERT INTO cloud_audit_events (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            event_id,
            account_id,
            device_id,
            event_type,
            metadata_json.to_string(),
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

pub fn routes(state: Arc<ServerState>) -> Router {
    routes_with_config(state, PasswordHasherConfig::production(), CloudRateLimiter::default())
}

pub fn routes_with_config(
    state: Arc<ServerState>,
    hasher_config: PasswordHasherConfig,
    rate_limiter: CloudRateLimiter,
) -> Router {
    let rate_limiter = Arc::new(rate_limiter);
    let hasher_config = Arc::new(hasher_config);

    let public = Router::new()
        .route("/v1/cloud/auth/signup", post(signup))
        .route("/v1/cloud/auth/login", post(login))
        .layer(Extension(rate_limiter.clone()))
        .layer(Extension(hasher_config.clone()))
        .with_state(state.clone());

    let protected = Router::new()
        .route("/v1/cloud/auth/me", get(me))
        .route("/v1/cloud/auth/logout", post(logout))
        .route("/v1/cloud/accounts/:account_id/profile", get(get_profile))
        .route("/v1/cloud/contacts", get(list_contacts).post(add_contact))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state);

    public.merge(protected)
}

pub async fn cloud_session_middleware(
    State(state): State<Arc<ServerState>>,
    headers: HeaderMap,
    mut req: Request,
    next: Next,
) -> Response {
    let token = match bearer_token_from_headers(&headers) {
        Some(token) if token.starts_with(SESSION_TOKEN_PREFIX) => token.to_string(),
        _ => return err("invalid_session", "Missing or malformed session token.", StatusCode::UNAUTHORIZED),
    };

    let db = match state.open_connection() {
        Ok(db) => db,
        Err(_) => return err("server_error", "Database unavailable.", StatusCode::INTERNAL_SERVER_ERROR),
    };

    match lookup_session(&db, &token) {
        Ok(Some(row)) => {
            // Sliding-window expiry refresh for active sessions. Best-effort.
            let _ = bump_expiry(&db, &row.token_id, DEFAULT_SESSION_LIFETIME_DAYS);
            req.extensions_mut().insert(CloudSession {
                token_id: row.token_id,
                account_id: row.account_id,
                device_id: row.device_id,
            });
            next.run(req).await
        }
        Ok(None) => err("invalid_session", "Session is expired or revoked.", StatusCode::UNAUTHORIZED),
        Err(_) => err("server_error", "Could not validate session.", StatusCode::INTERNAL_SERVER_ERROR),
    }
}

async fn signup(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(hasher_config): Extension<Arc<PasswordHasherConfig>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    Json(req): Json<SignupRequest>,
) -> Response {
    let peer_ip = ip_from_extension(connect_info.as_ref());
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip) {
        return limited_response(retry_after);
    }

    let normalized_email = match validate_email(&req.email) {
        Ok(value) => value,
        Err(err_value) => return map_email_format(err_value),
    };
    if let Err(policy_err) = validate_password_strength(&req.password) {
        return map_password_policy(policy_err);
    }

    let display_name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(80).collect::<String>());

    let avatar_url = req
        .avatar_seed
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|seed| format!("{}{}", AVATAR_SEED_PREFIX, seed));

    let password_hash = match hash_password(&req.password, *hasher_config.as_ref()) {
        Ok(hash) => hash,
        Err(_) => {
            return err(
                "server_error",
                "Could not hash password.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let mut db = match state.open_connection() {
        Ok(db) => db,
        Err(_) => {
            return err(
                "server_error",
                "Database unavailable.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    // Email uniqueness is enforced by the unique index on LOWER(primary_email).
    // We still do an explicit precheck so we can return a friendly error code
    // rather than mapping a generic UNIQUE-constraint failure.
    let existing_id: Option<String> = match db
        .query_row(
            "SELECT account_id FROM cloud_accounts WHERE LOWER(primary_email) = ?1",
            rusqlite::params![normalized_email],
            |row| row.get(0),
        )
        .optional()
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    if existing_id.is_some() {
        return err(
            "email_in_use",
            "An account with this email already exists.",
            StatusCode::CONFLICT,
        );
    }

    let now = Utc::now().to_rfc3339();
    let account_id = format!("acct_{}", uuid::Uuid::new_v4().simple());
    let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());

    let device_public_key = format!("placeholder-{}", uuid::Uuid::new_v4().simple());

    let tx = match db.transaction() {
        Ok(tx) => tx,
        Err(_) => {
            return err(
                "server_error",
                "Could not start transaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    if tx
        .execute(
            "INSERT INTO cloud_accounts \
             (account_id, display_name, primary_email, avatar_url, created_at, updated_at, password_hash, password_algorithm, password_updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?5)",
            rusqlite::params![
                account_id,
                display_name,
                normalized_email,
                avatar_url,
                now,
                password_hash,
                PASSWORD_ALGORITHM_ID,
            ],
        )
        .is_err()
    {
        return err(
            "server_error",
            "Could not create account.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if tx
        .execute(
            "INSERT INTO cloud_devices \
             (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            rusqlite::params![
                device_id,
                account_id,
                SIGNUP_DEFAULT_DEVICE_NAME,
                device_public_key,
                now,
            ],
        )
        .is_err()
    {
        return err(
            "server_error",
            "Could not create device.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let issued = match issue_session(&tx, &account_id, &device_id, DEFAULT_SESSION_LIFETIME_DAYS) {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not issue session.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let _ = write_audit(
        &tx,
        Some(&account_id),
        Some(&device_id),
        "account.created",
        serde_json::json!({
            "ip": peer_ip.map(|ip| ip.to_string()),
        }),
    );

    if tx.commit().is_err() {
        return err(
            "server_error",
            "Could not commit signup.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let account = AccountResponse {
        account_id: account_id.clone(),
        display_name,
        primary_email: Some(normalized_email),
        avatar_url,
        // Fresh signup — no bridges device registered yet. The desktop calls
        // register-device after this, then /me returns the resolved node_id.
        node_id: None,
        password_set: true,
    };
    let body = AuthResponse {
        account,
        session: SessionResponse {
            token: issued.plaintext_token,
            expires_at: issued.expires_at.to_rfc3339(),
        },
    };
    (StatusCode::CREATED, Json(body)).into_response()
}

async fn login(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    Json(req): Json<LoginRequest>,
) -> Response {
    let peer_ip = ip_from_extension(connect_info.as_ref());
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip) {
        return limited_response(retry_after);
    }

    let normalized_email = match validate_email(&req.email) {
        Ok(value) => value,
        Err(err_value) => return map_email_format(err_value),
    };

    if let RateLimitDecision::Limited { retry_after } =
        rate_limiter.check_email_lockout(&normalized_email)
    {
        return limited_response(retry_after);
    }

    let runner = match state.db_runner().await {
        Ok(runner) => runner.clone(),
        Err(_) => {
            return err(
                "server_error",
                "Database unavailable.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    // Move the entire DB + password-verify body into the single-writer
    // runner. Password verification (argon2) is CPU-bound; doing it inside
    // spawn_blocking keeps it off the async executor.
    let plaintext_password = req.password.clone();
    let email_for_query = normalized_email.clone();
    let peer_ip_str = peer_ip.map(|ip| ip.to_string());
    let outcome = match runner
        .write::<_, LoginOutcome, LoginRunnerError>(move |conn| {
            let row: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)> =
                match conn
                    .query_row(
                        "SELECT account_id, display_name, primary_email, avatar_url, password_hash \
                         FROM cloud_accounts WHERE LOWER(primary_email) = ?1",
                        rusqlite::params![email_for_query],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                            ))
                        },
                    )
                    .optional()
                {
                    Ok(value) => value,
                    Err(_) => return Ok(LoginOutcome::DbError),
                };

            let Some((account_id, display_name, primary_email, avatar_url, password_hash)) = row else {
                return Ok(LoginOutcome::AccountMissingOrNoPassword { account_id: None });
            };
            let Some(password_hash) = password_hash else {
                return Ok(LoginOutcome::AccountMissingOrNoPassword {
                    account_id: Some(account_id),
                });
            };

            let verified = match verify_password(&password_hash, &plaintext_password) {
                Ok(value) => value,
                Err(_) => return Ok(LoginOutcome::PasswordVerifyError),
            };
            if !verified {
                let _ = write_audit(
                    conn,
                    Some(&account_id),
                    None,
                    "auth.login.failure",
                    serde_json::json!({"ip": peer_ip_str}),
                );
                return Ok(LoginOutcome::WrongPassword { account_id });
            }

            let now = Utc::now().to_rfc3339();
            let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());
            let device_public_key = format!("placeholder-{}", uuid::Uuid::new_v4().simple());

            let tx = match conn.transaction() {
                Ok(tx) => tx,
                Err(_) => return Ok(LoginOutcome::DbError),
            };

            if tx
                .execute(
                    "INSERT INTO cloud_devices \
                     (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    rusqlite::params![
                        device_id,
                        account_id,
                        SIGNUP_DEFAULT_DEVICE_NAME,
                        device_public_key,
                        now,
                    ],
                )
                .is_err()
            {
                return Ok(LoginOutcome::DbError);
            }

            let issued = match issue_session(&tx, &account_id, &device_id, DEFAULT_SESSION_LIFETIME_DAYS) {
                Ok(value) => value,
                Err(_) => return Ok(LoginOutcome::DbError),
            };

            let _ = write_audit(
                &tx,
                Some(&account_id),
                Some(&device_id),
                "auth.login.success",
                serde_json::json!({"ip": peer_ip_str}),
            );

            if tx.commit().is_err() {
                return Ok(LoginOutcome::DbError);
            }

            Ok(LoginOutcome::Authenticated {
                account: AccountResponse {
                    account_id,
                    display_name,
                    primary_email,
                    avatar_url,
                    // Login creates a fresh device row; the bridges node for
                    // it gets created when register-device runs next. /me
                    // will see it.
                    node_id: None,
                    password_set: true,
                },
                session_token: issued.plaintext_token,
                session_expires_at: issued.expires_at,
            })
        })
        .await
    {
        Ok(outcome) => outcome,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    match outcome {
        LoginOutcome::AccountMissingOrNoPassword { .. } => {
            rate_limiter.record_email_failure(&normalized_email);
            err(
                "invalid_credentials",
                "Email or password is incorrect.",
                StatusCode::UNAUTHORIZED,
            )
        }
        LoginOutcome::WrongPassword { .. } => {
            rate_limiter.record_email_failure(&normalized_email);
            err(
                "invalid_credentials",
                "Email or password is incorrect.",
                StatusCode::UNAUTHORIZED,
            )
        }
        LoginOutcome::PasswordVerifyError => err(
            "server_error",
            "Could not verify password.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        LoginOutcome::DbError => err(
            "server_error",
            "Database error.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        LoginOutcome::Authenticated {
            account,
            session_token,
            session_expires_at,
        } => {
            rate_limiter.clear_email_failures(&normalized_email);
            let body = AuthResponse {
                account,
                session: SessionResponse {
                    token: session_token,
                    expires_at: session_expires_at.to_rfc3339(),
                },
            };
            (StatusCode::OK, Json(body)).into_response()
        }
    }
}

async fn me(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let db = match state.open_connection() {
        Ok(db) => db,
        Err(_) => {
            return err(
                "server_error",
                "Database unavailable.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    match account_response_row(&db, &session.account_id) {
        Ok(Some(account)) => Json(account).into_response(),
        Ok(None) => err(
            "account_missing",
            "Account no longer exists.",
            StatusCode::NOT_FOUND,
        ),
        Err(_) => err(
            "server_error",
            "Could not fetch account.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

async fn logout(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let db = match state.open_connection() {
        Ok(db) => db,
        Err(_) => {
            return err(
                "server_error",
                "Database unavailable.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    if revoke_session(&db, &session.token_id).is_err() {
        return err(
            "server_error",
            "Could not revoke session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let _ = write_audit(
        &db,
        Some(&session.account_id),
        Some(&session.device_id),
        "auth.logout",
        serde_json::json!({}),
    );
    StatusCode::NO_CONTENT.into_response()
}


async fn get_profile(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(account_id): axum::extract::Path<String>,
) -> Response {
    let target = account_id.trim().to_string();
    if target.is_empty() {
        return err(
            "invalid_account_id",
            "Account id is required.",
            StatusCode::BAD_REQUEST,
        );
    }

    let db = match state.open_connection() {
        Ok(db) => db,
        Err(_) => {
            return err(
                "server_error",
                "Database unavailable.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let row: Option<(String, Option<String>, Option<String>)> = match db
        .query_row(
            "SELECT account_id, display_name, avatar_url FROM cloud_accounts WHERE account_id = ?1",
            rusqlite::params![target],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let Some((account_id, display_name, avatar_url)) = row else {
        return err(
            "account_missing",
            "No account found with that id.",
            StatusCode::NOT_FOUND,
        );
    };

    let is_self = account_id == session.account_id;
    let is_contact = !is_self
        && db
            .query_row(
                "SELECT 1 FROM cloud_contacts WHERE account_id = ?1 AND peer_account_id = ?2",
                rusqlite::params![session.account_id, account_id],
                |_| Ok(()),
            )
            .optional()
            .unwrap_or(None)
            .is_some();

    // bridges-node lookup belonged to bridges/cli; this server doesn't
    // own the registered_nodes table. The desktop pairs cloud accounts with
    // bridges nodes through a separate bridges/cli flow.
    let _ = &db;
    let node_id: Option<String> = None;

    Json(PublicProfileResponse {
        account_id,
        display_name,
        avatar_url,
        node_id,
        is_contact,
        is_self,
    })
    .into_response()
}

async fn add_contact(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<AddContactRequest>,
) -> Response {
    let peer = req.peer_account_id.trim().to_string();
    if peer.is_empty() {
        return err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if peer == session.account_id {
        return err(
            "self_contact",
            "You cannot add yourself as a contact.",
            StatusCode::BAD_REQUEST,
        );
    }

    let db = match state.open_connection() {
        Ok(db) => db,
        Err(_) => {
            return err(
                "server_error",
                "Database unavailable.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let peer_exists: Option<()> = match db
        .query_row(
            "SELECT 1 FROM cloud_accounts WHERE account_id = ?1",
            rusqlite::params![peer],
            |_| Ok(()),
        )
        .optional()
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    if peer_exists.is_none() {
        return err(
            "account_missing",
            "No account found with that id.",
            StatusCode::NOT_FOUND,
        );
    }

    let now = Utc::now().to_rfc3339();
    if db
        .execute(
            "INSERT OR IGNORE INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![session.account_id, peer, now],
        )
        .is_err()
    {
        return err(
            "server_error",
            "Could not add contact.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    // (bridges-node mirroring removed; that flow lives on bridges/cli now.)

    let _ = write_audit(
        &db,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.added",
        serde_json::json!({"peer": peer}),
    );

    StatusCode::NO_CONTENT.into_response()
}

async fn list_contacts(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let db = match state.open_connection() {
        Ok(db) => db,
        Err(_) => {
            return err(
                "server_error",
                "Database unavailable.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let mut stmt = match db.prepare(
        // bridges-node id is no longer carried in this response; the desktop
        // pairs cloud contacts with bridges nodes via bridges/cli separately.
        "SELECT a.account_id, a.display_name, a.avatar_url, c.created_at, NULL AS node_id \
         FROM cloud_contacts c \
         JOIN cloud_accounts a ON a.account_id = c.peer_account_id \
         WHERE c.account_id = ?1 \
         ORDER BY c.created_at ASC",
    ) {
        Ok(stmt) => stmt,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let rows = match stmt.query_map(rusqlite::params![session.account_id], |row| {
        Ok(ContactSummary {
            account_id: row.get(0)?,
            display_name: row.get(1)?,
            avatar_url: row.get(2)?,
            created_at: row.get(3)?,
            node_id: row.get(4)?,
        })
    }) {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let mut contacts = Vec::new();
    for row in rows {
        match row {
            Ok(summary) => contacts.push(summary),
            Err(_) => {
                return err(
                    "server_error",
                    "Database error.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                )
            }
        }
    }

    Json(ContactsListResponse { contacts }).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request as HttpRequest, StatusCode};
    use serde_json::json;
    use std::path::PathBuf;
    use tower::util::ServiceExt;

    fn test_state_with_init() -> Arc<ServerState> {
        let db_path =
            std::env::temp_dir().join(format!("cloud-auth-test-{}.db", uuid::Uuid::new_v4()));
        let conn = rusqlite::Connection::open(&db_path).expect("open test db");
        crate::schema::init_server_db(&conn).expect("init schema");
        drop(conn);
        Arc::new(ServerState::new(db_path))
    }

    fn fast_test_router(state: Arc<ServerState>) -> Router {
        let limiter = CloudRateLimiter::new(crate::auth::rate_limit::CloudRateLimitConfig {
            per_ip_limit: 1000,
            per_ip_window: std::time::Duration::from_secs(60),
            per_email_failure_limit: 5,
            per_email_lockout: std::time::Duration::from_secs(900),
        });
        routes_with_config(state, PasswordHasherConfig::for_tests(), limiter)
    }

    async fn read_json(response: Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("read body");
        if bytes.is_empty() {
            return serde_json::Value::Null;
        }
        serde_json::from_slice(&bytes).expect("parse json")
    }

    fn signup_body(email: &str, password: &str) -> Body {
        Body::from(
            json!({
                "email": email,
                "password": password,
                "displayName": "Tester",
                "avatarSeed": "cloud-signup:abcd",
            })
            .to_string(),
        )
    }

    fn login_body(email: &str, password: &str) -> Body {
        Body::from(json!({"email": email, "password": password}).to_string())
    }

    fn post(uri: &str, body: Body) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(body)
            .unwrap()
    }

    fn get_with_token(uri: &str, token: &str) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method("GET")
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    }

    fn post_with_token(uri: &str, token: &str) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method("POST")
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    }

    fn cleanup_state(state: &ServerState) {
        let _ = std::fs::remove_file(&state.db_path);
        let extensions = ["-shm", "-wal"];
        for ext in extensions {
            let mut path = state.db_path.clone();
            let mut file_name: PathBuf = path.clone();
            file_name.set_extension(format!(
                "{}{}",
                path.extension().and_then(|e| e.to_str()).unwrap_or(""),
                ext
            ));
            let _ = std::fs::remove_file(file_name);
            path = state.db_path.clone();
            let _ = std::fs::remove_file(path.with_extension(format!("db{}", ext)));
        }
    }

    #[tokio::test]
    async fn signup_happy_path_returns_session() {
        let state = test_state_with_init();
        let router = fast_test_router(state.clone());
        let response = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("alice@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        let status = response.status();
        let body = read_json(response).await;
        assert_eq!(status, StatusCode::CREATED, "got body {body}");
        assert_eq!(body["account"]["primaryEmail"], "alice@example.com");
        assert!(body["session"]["token"]
            .as_str()
            .unwrap()
            .starts_with(SESSION_TOKEN_PREFIX));
        cleanup_state(&state);
    }

    #[tokio::test]
    async fn signup_with_duplicate_email_returns_409() {
        let state = test_state_with_init();
        let router = fast_test_router(state.clone());
        let _ = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("bob@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        let response = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("BOB@example.com", "different password"),
            ))
            .await
            .expect("oneshot");
        let status = response.status();
        let body = read_json(response).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["errorCode"], "email_in_use");
        cleanup_state(&state);
    }

    #[tokio::test]
    async fn signup_with_weak_password_returns_400() {
        let state = test_state_with_init();
        let router = fast_test_router(state.clone());
        let response = router
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("carol@example.com", "short"),
            ))
            .await
            .expect("oneshot");
        let status = response.status();
        let body = read_json(response).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["errorCode"], "weak_password");
        cleanup_state(&state);
    }

    #[tokio::test]
    async fn login_with_correct_password_returns_session() {
        let state = test_state_with_init();
        let router = fast_test_router(state.clone());
        let _ = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("dave@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        let response = router
            .oneshot(post(
                "/v1/cloud/auth/login",
                login_body("dave@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        let status = response.status();
        let body = read_json(response).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["session"]["token"].as_str().unwrap().starts_with(SESSION_TOKEN_PREFIX));
        cleanup_state(&state);
    }

    #[tokio::test]
    async fn login_with_wrong_password_returns_401_and_audits() {
        let state = test_state_with_init();
        let router = fast_test_router(state.clone());
        let _ = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("erin@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        let response = router
            .oneshot(post(
                "/v1/cloud/auth/login",
                login_body("erin@example.com", "WRONG"),
            ))
            .await
            .expect("oneshot");
        let status = response.status();
        let body = read_json(response).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["errorCode"], "invalid_credentials");

        let conn = state.open_connection().expect("conn");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cloud_audit_events WHERE event_type = 'auth.login.failure'",
                [],
                |row| row.get(0),
            )
            .expect("count");
        assert_eq!(count, 1);
        cleanup_state(&state);
    }

    #[tokio::test]
    async fn me_with_valid_token_returns_account() {
        let state = test_state_with_init();
        let router = fast_test_router(state.clone());
        let signup_resp = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("frank@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        let body = read_json(signup_resp).await;
        let token = body["session"]["token"].as_str().unwrap().to_string();

        let response = router
            .oneshot(get_with_token("/v1/cloud/auth/me", &token))
            .await
            .expect("oneshot");
        assert_eq!(response.status(), StatusCode::OK);
        let body = read_json(response).await;
        assert_eq!(body["primaryEmail"], "frank@example.com");
        cleanup_state(&state);
    }

    #[tokio::test]
    async fn me_without_token_returns_401() {
        let state = test_state_with_init();
        let router = fast_test_router(state.clone());
        let response = router
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/v1/cloud/auth/me")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("oneshot");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        cleanup_state(&state);
    }

    #[tokio::test]
    async fn logout_invalidates_token() {
        let state = test_state_with_init();
        let router = fast_test_router(state.clone());
        let signup_resp = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("grace@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        let body = read_json(signup_resp).await;
        let token = body["session"]["token"].as_str().unwrap().to_string();

        let logout_resp = router
            .clone()
            .oneshot(post_with_token("/v1/cloud/auth/logout", &token))
            .await
            .expect("oneshot");
        assert_eq!(logout_resp.status(), StatusCode::NO_CONTENT);

        let me_resp = router
            .oneshot(get_with_token("/v1/cloud/auth/me", &token))
            .await
            .expect("oneshot");
        assert_eq!(me_resp.status(), StatusCode::UNAUTHORIZED);
        cleanup_state(&state);
    }

    #[tokio::test]
    async fn login_rate_limit_locks_email_after_failures() {
        let state = test_state_with_init();
        let limiter_config = crate::auth::rate_limit::CloudRateLimitConfig {
            per_ip_limit: 1000,
            per_ip_window: std::time::Duration::from_secs(60),
            per_email_failure_limit: 3,
            per_email_lockout: std::time::Duration::from_secs(900),
        };
        let router = routes_with_config(
            state.clone(),
            PasswordHasherConfig::for_tests(),
            CloudRateLimiter::new(limiter_config),
        );
        let _ = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/signup",
                signup_body("hank@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        for _ in 0..3 {
            let resp = router
                .clone()
                .oneshot(post(
                    "/v1/cloud/auth/login",
                    login_body("hank@example.com", "WRONG"),
                ))
                .await
                .expect("oneshot");
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        }
        let resp = router
            .clone()
            .oneshot(post(
                "/v1/cloud/auth/login",
                login_body("hank@example.com", "correct horse"),
            ))
            .await
            .expect("oneshot");
        assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
        cleanup_state(&state);
    }

    #[test]
    fn hash_session_token_matches_session_module() {
        // Sanity that we're using the same hash function the session module stores.
        let plaintext = "kordi_cs_test";
        assert_eq!(hash_session_token(plaintext).len(), 64);
    }
}
