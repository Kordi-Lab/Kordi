//! HTTP routes for the Cloud Edition email/password auth slice (Postgres).
//!
//! Mounted under `/v1/cloud/auth/*`, `/v1/cloud/accounts/:id/profile`, and
//! `/v1/cloud/contacts`. Talks to Postgres via the `sqlx::PgPool` owned by
//! `ServerState`. Every handler is straight-line async — no DbRunner
//! closures, no spawn_blocking — because sqlx is async-native.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::auth::password::{
    hash_password, validate_email, validate_password_strength, verify_password,
    EmailFormatError, PasswordHasherConfig, PasswordPolicyError, PASSWORD_ALGORITHM_ID,
};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::session::{
    bump_expiry, issue_session, lookup_session, revoke_session,
    DEFAULT_SESSION_LIFETIME_DAYS, SESSION_TOKEN_PREFIX,
};
use crate::server::ServerState;

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
    let mut response = err(
        "rate_limited",
        "Too many attempts. Try again shortly.",
        StatusCode::TOO_MANY_REQUESTS,
    );
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

async fn account_response_row(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<AccountResponse>, sqlx_core::Error> {
    let row: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)> =
        query_as(
            "SELECT account_id, display_name, primary_email, avatar_url, password_hash \
             FROM cloud_accounts WHERE account_id = $1",
        )
        .bind(account_id)
        .fetch_optional(pool)
        .await?;

    Ok(row.map(
        |(account_id, display_name, primary_email, avatar_url, password_hash)| AccountResponse {
            account_id,
            display_name,
            primary_email,
            avatar_url,
            // Bridges-node lookup belonged to the local-first server; cloud
            // server doesn't own registered_nodes, so this stays None.
            node_id: None,
            password_set: password_hash.is_some(),
        },
    ))
}

async fn write_audit(
    pool: &PgPool,
    account_id: Option<&str>,
    device_id: Option<&str>,
    event_type: &str,
    metadata_json: serde_json::Value,
) -> Result<(), sqlx_core::Error> {
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&event_id)
    .bind(account_id)
    .bind(device_id)
    .bind(event_type)
    .bind(metadata_json.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

pub fn routes(state: Arc<ServerState>) -> Router {
    routes_with_config(
        state,
        PasswordHasherConfig::production(),
        CloudRateLimiter::default(),
    )
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
        _ => {
            return err(
                "invalid_session",
                "Missing or malformed session token.",
                StatusCode::UNAUTHORIZED,
            )
        }
    };

    let pool = state.db_pool();
    match lookup_session(pool, &token).await {
        Ok(Some(row)) => {
            let _ = bump_expiry(pool, &row.token_id, DEFAULT_SESSION_LIFETIME_DAYS).await;
            req.extensions_mut().insert(CloudSession {
                token_id: row.token_id,
                account_id: row.account_id,
                device_id: row.device_id,
            });
            next.run(req).await
        }
        Ok(None) => err(
            "invalid_session",
            "Session is expired or revoked.",
            StatusCode::UNAUTHORIZED,
        ),
        Err(_) => err(
            "server_error",
            "Could not validate session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
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

    let pool = state.db_pool();

    // Email uniqueness precheck — cleaner error code than mapping a UNIQUE
    // violation. The partial unique index on LOWER(primary_email) is the
    // ground-truth backstop.
    let existing: Option<(String,)> = match query_as(
        "SELECT account_id FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(&normalized_email)
    .fetch_optional(pool)
    .await
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
    if existing.is_some() {
        return err(
            "email_in_use",
            "An account with this email already exists.",
            StatusCode::CONFLICT,
        );
    }

    let password_hash = match tokio::task::spawn_blocking({
        let plaintext = req.password.clone();
        let config = *hasher_config.as_ref();
        move || hash_password(&plaintext, config)
    })
    .await
    {
        Ok(Ok(hash)) => hash,
        _ => {
            return err(
                "server_error",
                "Could not hash password.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let now = Utc::now().to_rfc3339();
    let account_id = format!("acct_{}", uuid::Uuid::new_v4().simple());
    let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());
    let device_public_key = format!("placeholder-{}", uuid::Uuid::new_v4().simple());

    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return err(
                "server_error",
                "Could not start transaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    if query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, avatar_url, created_at, updated_at, \
          password_hash, password_algorithm, password_updated_at) \
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $5)",
    )
    .bind(&account_id)
    .bind(display_name.as_deref())
    .bind(&normalized_email)
    .bind(avatar_url.as_deref())
    .bind(&now)
    .bind(&password_hash)
    .bind(PASSWORD_ALGORITHM_ID)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not create account.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if query(
        "INSERT INTO cloud_devices \
         (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(SIGNUP_DEFAULT_DEVICE_NAME)
    .bind(&device_public_key)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not create device.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let issued = match issue_session(&mut *tx, &account_id, &device_id, DEFAULT_SESSION_LIFETIME_DAYS).await {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not issue session.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    // Audit row inside the same tx so signup is atomic.
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    let _ = query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&event_id)
    .bind(&account_id)
    .bind(&device_id)
    .bind("account.created")
    .bind(serde_json::json!({"ip": peer_ip.map(|ip| ip.to_string())}).to_string())
    .bind(&now)
    .execute(&mut *tx)
    .await;

    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not commit signup.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    // Fire-and-forget event publish. We don't want NATS hiccups to slow
    // down or fail signup; the bus is a no-op when NATS isn't wired.
    // Durable delivery via an outbox lands when sync workers need it.
    {
        let events = state.events().clone();
        let account_id = account_id.clone();
        let primary_email = normalized_email.clone();
        tokio::spawn(async move {
            events.publish_signup(&account_id, &primary_email).await;
        });
    }

    let account = AccountResponse {
        account_id,
        display_name,
        primary_email: Some(normalized_email),
        avatar_url,
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

    let pool = state.db_pool();

    let row: Option<(String, Option<String>, Option<String>, Option<String>, Option<String>)> =
        match query_as(
            "SELECT account_id, display_name, primary_email, avatar_url, password_hash \
             FROM cloud_accounts WHERE LOWER(primary_email) = $1",
        )
        .bind(&normalized_email)
        .fetch_optional(pool)
        .await
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

    let Some((account_id, display_name, primary_email, avatar_url, password_hash)) = row else {
        rate_limiter.record_email_failure(&normalized_email);
        return err(
            "invalid_credentials",
            "Email or password is incorrect.",
            StatusCode::UNAUTHORIZED,
        );
    };
    let Some(password_hash) = password_hash else {
        rate_limiter.record_email_failure(&normalized_email);
        return err(
            "invalid_credentials",
            "Email or password is incorrect.",
            StatusCode::UNAUTHORIZED,
        );
    };

    let verified = match tokio::task::spawn_blocking({
        let hash = password_hash.clone();
        let plaintext = req.password.clone();
        move || verify_password(&hash, &plaintext)
    })
    .await
    {
        Ok(Ok(value)) => value,
        _ => {
            return err(
                "server_error",
                "Could not verify password.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    if !verified {
        rate_limiter.record_email_failure(&normalized_email);
        let _ = write_audit(
            pool,
            Some(&account_id),
            None,
            "auth.login.failure",
            serde_json::json!({"ip": peer_ip.map(|ip| ip.to_string())}),
        )
        .await;
        return err(
            "invalid_credentials",
            "Email or password is incorrect.",
            StatusCode::UNAUTHORIZED,
        );
    }
    rate_limiter.clear_email_failures(&normalized_email);

    let now = Utc::now().to_rfc3339();
    let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());
    let device_public_key = format!("placeholder-{}", uuid::Uuid::new_v4().simple());

    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return err(
                "server_error",
                "Could not start transaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    if query(
        "INSERT INTO cloud_devices \
         (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(SIGNUP_DEFAULT_DEVICE_NAME)
    .bind(&device_public_key)
    .bind(&now)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not register device.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let issued = match issue_session(&mut *tx, &account_id, &device_id, DEFAULT_SESSION_LIFETIME_DAYS).await {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not issue session.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    let _ = query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&event_id)
    .bind(&account_id)
    .bind(&device_id)
    .bind("auth.login.success")
    .bind(serde_json::json!({"ip": peer_ip.map(|ip| ip.to_string())}).to_string())
    .bind(&now)
    .execute(&mut *tx)
    .await;

    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not commit login.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let body = AuthResponse {
        account: AccountResponse {
            account_id,
            display_name,
            primary_email,
            avatar_url,
            node_id: None,
            password_set: true,
        },
        session: SessionResponse {
            token: issued.plaintext_token,
            expires_at: issued.expires_at.to_rfc3339(),
        },
    };
    (StatusCode::OK, Json(body)).into_response()
}

async fn me(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    match account_response_row(pool, &session.account_id).await {
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
    let pool = state.db_pool();
    if revoke_session(pool, &session.token_id).await.is_err() {
        return err(
            "server_error",
            "Could not revoke session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "auth.logout",
        serde_json::json!({}),
    )
    .await;
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

    let pool = state.db_pool();

    let row: Option<(String, Option<String>, Option<String>)> = match query_as(
        "SELECT account_id, display_name, avatar_url FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(&target)
    .fetch_optional(pool)
    .await
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
    let is_contact = if is_self {
        false
    } else {
        let contact_row: Option<(i32,)> = query_as(
            "SELECT 1 FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2",
        )
        .bind(&session.account_id)
        .bind(&account_id)
        .fetch_optional(pool)
        .await
        .unwrap_or(None);
        contact_row.is_some()
    };

    Json(PublicProfileResponse {
        account_id,
        display_name,
        avatar_url,
        node_id: None,
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

    let pool = state.db_pool();

    let peer_exists: Option<(i32,)> = match query_as(
        "SELECT 1 FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(&peer)
    .fetch_optional(pool)
    .await
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
    if query(
        "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) VALUES ($1, $2, $3) \
         ON CONFLICT (account_id, peer_account_id) DO NOTHING",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not add contact.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.added",
        serde_json::json!({"peer": peer}),
    )
    .await;

    StatusCode::NO_CONTENT.into_response()
}

async fn list_contacts(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();

    let rows: Vec<(String, Option<String>, Option<String>, String)> = match query_as(
        "SELECT a.account_id, a.display_name, a.avatar_url, c.created_at \
         FROM cloud_contacts c \
         JOIN cloud_accounts a ON a.account_id = c.peer_account_id \
         WHERE c.account_id = $1 \
         ORDER BY c.created_at ASC",
    )
    .bind(&session.account_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    let contacts = rows
        .into_iter()
        .map(|(account_id, display_name, avatar_url, created_at)| ContactSummary {
            account_id,
            display_name,
            avatar_url,
            node_id: None,
            created_at,
        })
        .collect();

    Json(ContactsListResponse { contacts }).into_response()
}
