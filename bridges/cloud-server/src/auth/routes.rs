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

#[derive(Debug, Serialize, Clone)]
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

#[derive(Debug, Deserialize)]
pub struct SendContactRequestBody {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ContactRequestSummary {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "fromAccountId")]
    pub from_account_id: String,
    #[serde(rename = "toAccountId")]
    pub to_account_id: String,
    pub status: String,
    pub direction: String, // "incoming" | "outgoing", relative to the caller
    pub message: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "decidedAt")]
    pub decided_at: Option<String>,
    /// Counterpart profile (the from-account for incoming, the
    /// to-account for outgoing). Empty when the row predates the
    /// account being looked up (shouldn't happen with FK + cascade
    /// but defensive nonetheless).
    pub counterpart: Option<ContactSummary>,
}

#[derive(Debug, Serialize)]
pub struct ContactRequestListResponse {
    pub requests: Vec<ContactRequestSummary>,
}

#[derive(Debug, Serialize)]
pub struct ContactRequestResponse {
    pub request: ContactRequestSummary,
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
        .route(
            "/v1/cloud/contacts/requests",
            get(list_contact_requests).post(send_contact_request),
        )
        .route(
            "/v1/cloud/contacts/requests/:request_id/accept",
            post(accept_contact_request),
        )
        .route(
            "/v1/cloud/contacts/requests/:request_id/reject",
            post(reject_contact_request),
        )
        .route(
            "/v1/cloud/attachments/initiate",
            post(crate::attachments::routes::initiate),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/finalize",
            post(crate::attachments::routes::finalize),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/download-url",
            get(crate::attachments::routes::download_url),
        )
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
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip).await {
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
    if let RateLimitDecision::Limited { retry_after } = rate_limiter.observe_ip(peer_ip).await {
        return limited_response(retry_after);
    }

    let normalized_email = match validate_email(&req.email) {
        Ok(value) => value,
        Err(err_value) => return map_email_format(err_value),
    };

    if let RateLimitDecision::Limited { retry_after } =
        rate_limiter.check_email_lockout(&normalized_email).await
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
        rate_limiter.record_email_failure(&normalized_email).await;
        return err(
            "invalid_credentials",
            "Email or password is incorrect.",
            StatusCode::UNAUTHORIZED,
        );
    };
    let Some(password_hash) = password_hash else {
        rate_limiter.record_email_failure(&normalized_email).await;
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
        rate_limiter.record_email_failure(&normalized_email).await;
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
    rate_limiter.clear_email_failures(&normalized_email).await;

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

    // Notify the peer's open WebSocket(s). Fire-and-forget for the same
    // reasons as signup: the HTTP caller shouldn't pay NATS latency or
    // fail the request if the bus blips.
    {
        let events = state.events().clone();
        let actor = session.account_id.clone();
        let peer = peer.clone();
        tokio::spawn(async move {
            events.publish_contact_added(&actor, &peer).await;
        });
    }

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

// ---------- Contact request flow ----------

/// `POST /v1/cloud/contacts/requests` — send a contact request.
///
/// If there's already an *incoming* pending request from the same peer
/// (i.e. they asked us first), this short-circuits to acceptance and
/// makes the relationship mutual — useful when both sides reach out
/// concurrently. Otherwise we insert a fresh pending request and fire
/// the corresponding NATS event so the recipient's open WebSocket
/// learns about it live.
async fn send_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<SendContactRequestBody>,
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
            "You cannot send a contact request to yourself.",
            StatusCode::BAD_REQUEST,
        );
    }
    let message = req
        .message
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(280).collect::<String>());

    let pool = state.db_pool();

    // Peer must exist.
    let peer_account = match account_response_row(pool, &peer).await {
        Ok(Some(account)) => account,
        Ok(None) => {
            return err(
                "account_missing",
                "No account found with that id.",
                StatusCode::NOT_FOUND,
            )
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    // Already-accepted contact? Idempotent — just echo the existing
    // (or last) request row if there is one, otherwise a synthetic
    // "already accepted" placeholder.
    let already_contact: Option<(i32,)> = match query_as(
        "SELECT 1 FROM cloud_contacts \
         WHERE account_id = $1 AND peer_account_id = $2",
    )
    .bind(&session.account_id)
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
    if already_contact.is_some() {
        return err(
            "already_contact",
            "You are already contacts.",
            StatusCode::CONFLICT,
        );
    }

    // If they already asked us — auto-accept.
    let inbound_pending: Option<(String, Option<String>, String)> = match query_as(
        "SELECT request_id, message, created_at \
         FROM cloud_contact_requests \
         WHERE from_account_id = $1 AND to_account_id = $2 AND status = 'pending'",
    )
    .bind(&peer)
    .bind(&session.account_id)
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
    if let Some((request_id, _msg, _created_at)) = inbound_pending {
        return finalize_request_acceptance(
            &state,
            &session,
            pool,
            &request_id,
            &peer,
            &session.account_id,
        )
        .await;
    }

    // Outbound pending already? Idempotent — return it.
    let outbound_existing: Option<(String, String, Option<String>)> = match query_as(
        "SELECT request_id, created_at, message \
         FROM cloud_contact_requests \
         WHERE from_account_id = $1 AND to_account_id = $2 AND status = 'pending'",
    )
    .bind(&session.account_id)
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
    if let Some((existing_id, created_at, existing_message)) = outbound_existing {
        let summary = ContactRequestSummary {
            request_id: existing_id,
            from_account_id: session.account_id.clone(),
            to_account_id: peer.clone(),
            status: "pending".into(),
            direction: "outgoing".into(),
            message: existing_message,
            created_at,
            decided_at: None,
            counterpart: Some(account_to_summary(peer_account)),
        };
        return (StatusCode::OK, Json(ContactRequestResponse { request: summary })).into_response();
    }

    // Insert a fresh request.
    let request_id = format!("req_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_contact_requests \
         (request_id, from_account_id, to_account_id, status, message, created_at) \
         VALUES ($1, $2, $3, 'pending', $4, $5)",
    )
    .bind(&request_id)
    .bind(&session.account_id)
    .bind(&peer)
    .bind(message.as_deref())
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record request.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.request.sent",
        serde_json::json!({ "request_id": request_id, "peer": peer }),
    )
    .await;

    // Notify the peer's open WS via NATS.
    {
        let events = state.events().clone();
        let request_id = request_id.clone();
        let from = session.account_id.clone();
        let to = peer.clone();
        tokio::spawn(async move {
            events
                .publish_contact_request_event(
                    crate::events::ContactRequestEventKind::Created,
                    &request_id,
                    &from,
                    &to,
                )
                .await;
        });
    }

    let summary = ContactRequestSummary {
        request_id,
        from_account_id: session.account_id.clone(),
        to_account_id: peer.clone(),
        status: "pending".into(),
        direction: "outgoing".into(),
        message,
        created_at: now,
        decided_at: None,
        counterpart: Some(account_to_summary(peer_account)),
    };
    (StatusCode::CREATED, Json(ContactRequestResponse { request: summary })).into_response()
}

/// `GET /v1/cloud/contacts/requests` — list pending requests touching
/// the caller, both incoming and outgoing. Decided requests are not
/// returned (they would clutter the UI inbox; querying history is a
/// separate concern).
async fn list_contact_requests(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();

    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
    )> = match query_as(
        "SELECT r.request_id, r.from_account_id, r.to_account_id, r.status, \
                r.message, r.created_at, r.decided_at \
         FROM cloud_contact_requests r \
         WHERE r.status = 'pending' \
           AND (r.from_account_id = $1 OR r.to_account_id = $1) \
         ORDER BY r.created_at DESC",
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

    let mut requests: Vec<ContactRequestSummary> = Vec::with_capacity(rows.len());
    for (request_id, from_id, to_id, status, message, created_at, decided_at) in rows {
        let (direction, counterpart_id) = if from_id == session.account_id {
            ("outgoing", to_id.clone())
        } else {
            ("incoming", from_id.clone())
        };
        let counterpart = account_response_row(pool, &counterpart_id)
            .await
            .ok()
            .flatten()
            .map(account_to_summary);
        requests.push(ContactRequestSummary {
            request_id,
            from_account_id: from_id,
            to_account_id: to_id,
            status,
            direction: direction.into(),
            message,
            created_at,
            decided_at,
            counterpart,
        });
    }

    Json(ContactRequestListResponse { requests }).into_response()
}

/// `POST /v1/cloud/contacts/requests/:id/accept` — only the recipient
/// (`to_account_id`) can accept.
async fn accept_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(request_id): axum::extract::Path<String>,
) -> Response {
    let pool = state.db_pool();

    let row: Option<(String, String, String)> = match query_as(
        "SELECT from_account_id, to_account_id, status \
         FROM cloud_contact_requests WHERE request_id = $1",
    )
    .bind(&request_id)
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
    let Some((from_id, to_id, status)) = row else {
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    };
    if to_id != session.account_id {
        // Don't leak existence to non-recipients.
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    }
    if status != "pending" {
        return err(
            "request_decided",
            "Contact request has already been decided.",
            StatusCode::CONFLICT,
        );
    }

    finalize_request_acceptance(&state, &session, pool, &request_id, &from_id, &to_id).await
}

/// `POST /v1/cloud/contacts/requests/:id/reject`
async fn reject_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(request_id): axum::extract::Path<String>,
) -> Response {
    let pool = state.db_pool();

    let row: Option<(String, String, String)> = match query_as(
        "SELECT from_account_id, to_account_id, status \
         FROM cloud_contact_requests WHERE request_id = $1",
    )
    .bind(&request_id)
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
    let Some((from_id, to_id, status)) = row else {
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    };
    if to_id != session.account_id {
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    }
    if status != "pending" {
        return err(
            "request_decided",
            "Contact request has already been decided.",
            StatusCode::CONFLICT,
        );
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "UPDATE cloud_contact_requests \
         SET status = 'rejected', decided_at = $1 \
         WHERE request_id = $2 AND status = 'pending'",
    )
    .bind(&now)
    .bind(&request_id)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not reject request.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.request.rejected",
        serde_json::json!({ "request_id": request_id, "from": from_id }),
    )
    .await;

    // Notify the original requester.
    {
        let events = state.events().clone();
        let request_id_clone = request_id.clone();
        let from = from_id.clone();
        let to = to_id.clone();
        tokio::spawn(async move {
            events
                .publish_contact_request_event(
                    crate::events::ContactRequestEventKind::Rejected,
                    &request_id_clone,
                    &from,
                    &to,
                )
                .await;
        });
    }

    StatusCode::NO_CONTENT.into_response()
}

// ---------- helpers ----------

/// Shared body of "accept this pending request" used by both the
/// explicit POST and the "mutual reachout" auto-accept inside
/// `send_contact_request`. `from_id` and `to_id` are the request's
/// from / to (NOT relative to the caller).
async fn finalize_request_acceptance(
    state: &Arc<ServerState>,
    session: &CloudSession,
    pool: &PgPool,
    request_id: &str,
    from_id: &str,
    to_id: &str,
) -> Response {
    let now = Utc::now().to_rfc3339();

    let mut tx = match pool.begin().await {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not start transaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    if query(
        "UPDATE cloud_contact_requests \
         SET status = 'accepted', decided_at = $1 \
         WHERE request_id = $2 AND status = 'pending'",
    )
    .bind(&now)
    .bind(request_id)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not accept request.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    // Symmetric contact rows. ON CONFLICT DO NOTHING keeps the
    // operation idempotent if either side somehow already had the row.
    for (owner, peer) in [(from_id, to_id), (to_id, from_id)] {
        if query(
            "INSERT INTO cloud_contacts (account_id, peer_account_id, created_at) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (account_id, peer_account_id) DO NOTHING",
        )
        .bind(owner)
        .bind(peer)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record contact.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not commit acceptance.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.request.accepted",
        serde_json::json!({ "request_id": request_id, "peer": from_id }),
    )
    .await;

    // Fire the lifecycle events: one accept-notification to the
    // original requester, plus contact.added on both sides so any
    // open WS on either account refreshes its contacts list.
    {
        let events = state.events().clone();
        let request_id = request_id.to_string();
        let from = from_id.to_string();
        let to = to_id.to_string();
        tokio::spawn(async move {
            events
                .publish_contact_request_event(
                    crate::events::ContactRequestEventKind::Accepted,
                    &request_id,
                    &from,
                    &to,
                )
                .await;
            events.publish_contact_added(&from, &to).await;
            events.publish_contact_added(&to, &from).await;
        });
    }

    // Build the response. The caller may be either the requester (in
    // the mutual-reachout path) or the recipient — figure out the
    // counterpart from `session.account_id`.
    let counterpart_id = if from_id == session.account_id {
        to_id.to_string()
    } else {
        from_id.to_string()
    };
    let direction = if from_id == session.account_id { "outgoing" } else { "incoming" };
    let counterpart = account_response_row(pool, &counterpart_id)
        .await
        .ok()
        .flatten()
        .map(account_to_summary);

    let summary = ContactRequestSummary {
        request_id: request_id.to_string(),
        from_account_id: from_id.to_string(),
        to_account_id: to_id.to_string(),
        status: "accepted".into(),
        direction: direction.into(),
        message: None,
        created_at: now.clone(),
        decided_at: Some(now),
        counterpart,
    };
    (StatusCode::OK, Json(ContactRequestResponse { request: summary })).into_response()
}

fn account_to_summary(account: AccountResponse) -> ContactSummary {
    ContactSummary {
        account_id: account.account_id,
        display_name: account.display_name,
        avatar_url: account.avatar_url,
        node_id: account.node_id,
        created_at: String::new(),
    }
}
