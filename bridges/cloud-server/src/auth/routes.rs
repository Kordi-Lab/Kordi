//! HTTP routes for the Cloud Edition email/password auth slice (Postgres).
//!
//! Mounted under `/v1/cloud/auth/*`, `/v1/cloud/accounts/:id/profile`, and
//! `/v1/cloud/contacts`. Talks to Postgres via the `sqlx::PgPool` owned by
//! `ServerState`. Every handler is straight-line async — no DbRunner
//! closures, no spawn_blocking — because sqlx is async-native.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::{ConnectInfo, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::auth::oauth::{
    clean_profile_avatar_url, clean_profile_display_name, encode_oauth_fragment,
    exchange_oauth_code, fetch_oauth_profile, is_allowed_oauth_redirect, oauth_config,
    pkce_challenge, random_url_token, redirect_with_oauth_error, OAuthProfile, OAuthProvider,
};
use crate::auth::password::{
    hash_password, validate_email, validate_password_strength, verify_password, EmailFormatError,
    PasswordHasherConfig, PasswordPolicyError, PASSWORD_ALGORITHM_ID,
};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::session::{
    bump_expiry, issue_session, lookup_session, revoke_session, DEFAULT_SESSION_LIFETIME_DAYS,
    SESSION_TOKEN_PREFIX,
};
use crate::server::ServerState;

const AVATAR_SEED_PREFIX: &str = "kordi-pixel-avatar://";
const AVATAR_UPLOAD_MAX_BYTES: usize = 200 * 1024;
const SIGNUP_DEFAULT_DEVICE_NAME: &str = "cloud-email-password-device";

#[cfg(test)]
mod oauth_avatar_policy_tests {
    use super::{clean_required_signup_avatar_url, oauth_account_avatar_url};
    use axum::http::StatusCode;

    #[test]
    fn signup_avatar_requires_uploaded_image_not_seed() {
        let missing =
            clean_required_signup_avatar_url(None).expect_err("missing avatar should be rejected");
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);

        let seeded =
            clean_required_signup_avatar_url(Some("kordi-pixel-avatar://cloud-signup:abc"))
                .expect_err("generated avatars should be rejected");
        assert_eq!(seeded.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn signup_avatar_accepts_small_png_jpeg_or_webp_data_urls() {
        for prefix in [
            "data:image/png;base64,",
            "data:image/jpeg;base64,",
            "data:image/webp;base64,",
        ] {
            let value = format!("{}AAAA", prefix);
            assert_eq!(
                clean_required_signup_avatar_url(Some(&value)).unwrap(),
                value
            );
        }
    }

    #[test]
    fn oauth_provider_avatar_replaces_generated_signup_avatar() {
        assert_eq!(
            oauth_account_avatar_url(
                Some("kordi-pixel-avatar://cloud-signup:stable"),
                Some("https://avatars.example/provider.png"),
            ),
            Some("https://avatars.example/provider.png".to_string()),
        );
    }

    #[test]
    fn oauth_provider_avatar_preserves_custom_uploaded_avatar() {
        assert_eq!(
            oauth_account_avatar_url(
                Some("data:image/png;base64,custom"),
                Some("https://avatars.example/provider.png"),
            ),
            Some("data:image/png;base64,custom".to_string()),
        );
    }

    #[test]
    fn oauth_provider_avatar_refreshes_existing_provider_avatar() {
        assert_eq!(
            oauth_account_avatar_url(
                Some("https://avatars.example/old-provider.png"),
                Some("https://avatars.example/new-provider.png"),
            ),
            Some("https://avatars.example/new-provider.png".to_string()),
        );
    }
}

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
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct OAuthStartQuery {
    #[serde(rename = "redirectAfter")]
    pub redirect_after: String,
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OAuthStartResponse {
    #[serde(rename = "authUrl")]
    pub auth_url: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
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
    #[serde(rename = "helloMessage", skip_serializing_if = "Option::is_none")]
    pub hello_message: Option<MessageSummary>,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageAttachmentRequest {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    pub name: String,
    pub kind: String,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
    pub body: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "clientCreatedAt")]
    pub client_created_at: Option<String>,
    #[serde(default)]
    pub attachments: Vec<SendMessageAttachmentRequest>,
}

#[derive(Debug, Deserialize)]
pub struct MarkMessagesReadRequest {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct MessageAttachmentSummary {
    #[serde(rename = "attachmentId")]
    pub attachment_id: String,
    pub name: String,
    pub kind: String,
    #[serde(rename = "mimeType")]
    pub mime_type: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<i64>,
    #[serde(rename = "downloadUrl")]
    pub download_url: Option<String>,
    #[serde(rename = "previewUrl")]
    pub preview_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MessageSummary {
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "fromAccountId")]
    pub from_account_id: String,
    #[serde(rename = "toAccountId")]
    pub to_account_id: String,
    pub body: String,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "deliveredAt")]
    pub delivered_at: Option<String>,
    #[serde(rename = "readAt")]
    pub read_at: Option<String>,
    /// Direction relative to the caller — "outgoing" if the caller sent
    /// the message, "incoming" otherwise. Saves the client a comparison.
    pub direction: String,
    pub attachments: Vec<MessageAttachmentSummary>,
}

#[derive(Debug, Serialize)]
pub struct MessageListResponse {
    pub messages: Vec<MessageSummary>,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub message: MessageSummary,
}

#[derive(Debug, Deserialize)]
pub struct MessagesQuery {
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: String,
    /// Optional cap, default 200, max 500.
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct CloudSyncQuery {
    /// Last successfully applied sync event id. `0` means from the beginning.
    pub cursor: Option<i64>,
    /// Optional cap, default 500, max 1000.
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CloudSyncEventSummary {
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "eventType")]
    pub event_type: String,
    #[serde(rename = "peerAccountId")]
    pub peer_account_id: Option<String>,
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    pub payload: serde_json::Value,
    #[serde(rename = "occurredAt")]
    pub occurred_at: String,
}

#[derive(Debug, Serialize)]
pub struct CloudSyncResponse {
    pub cursor: String,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    pub events: Vec<CloudSyncEventSummary>,
}

#[derive(Debug, Serialize)]
pub struct CloudSessionVisibilityResponse {
    #[serde(rename = "hiddenSessionIds")]
    pub hidden_session_ids: Vec<String>,
    #[serde(rename = "deletedSessionIds")]
    pub deleted_session_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct PresenceContactsResponse {
    pub accounts: Vec<crate::presence::AccountPresenceSummary>,
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

fn normalize_message_attachment(
    input: &SendMessageAttachmentRequest,
    attachment_id: &str,
    db_mime_type: Option<String>,
    db_size_bytes: Option<i64>,
    _download_url: Option<String>,
) -> Result<MessageAttachmentSummary, Response> {
    let name = input.name.trim().chars().take(255).collect::<String>();
    if name.is_empty() {
        return Err(err(
            "invalid_attachment",
            "Attachment name is required.",
            StatusCode::BAD_REQUEST,
        ));
    }
    let kind = match input.kind.trim() {
        "image" => "image".to_string(),
        "file" => "file".to_string(),
        _ => {
            return Err(err(
                "invalid_attachment",
                "Attachment kind must be image or file.",
                StatusCode::BAD_REQUEST,
            ))
        }
    };
    let mime_type = input
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(255).collect::<String>())
        .or(db_mime_type);
    let size_bytes = input
        .size_bytes
        .filter(|value| *value >= 0)
        .or(db_size_bytes);
    Ok(MessageAttachmentSummary {
        attachment_id: attachment_id.to_string(),
        name,
        kind,
        mime_type,
        size_bytes,
        preview_url: None,
        download_url: None,
    })
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
    err(
        "weak_password",
        err_value.to_string(),
        StatusCode::BAD_REQUEST,
    )
}

fn map_email_format(err_value: EmailFormatError) -> Response {
    err(
        "invalid_email",
        err_value.to_string(),
        StatusCode::BAD_REQUEST,
    )
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
    let row: Option<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = query_as(
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
        .route("/v1/cloud/auth/oauth/:provider/start", get(oauth_start))
        .route(
            "/v1/cloud/auth/oauth/:provider/callback",
            get(oauth_callback),
        )
        .layer(Extension(rate_limiter.clone()))
        .layer(Extension(hasher_config.clone()))
        .with_state(state.clone());

    let protected = Router::new()
        .route("/v1/cloud/auth/me", get(me).patch(update_me))
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
        .route("/v1/cloud/messages", get(list_messages).post(send_message))
        .route("/v1/cloud/messages/read", post(mark_messages_read))
        .route("/v1/cloud/sessions/:source_session_id/read", post(mark_session_messages_read))
        .route("/v1/cloud/presence/online", post(publish_current_device_online))
        .route("/v1/cloud/presence/heartbeat", post(publish_current_device_heartbeat))
        .route("/v1/cloud/presence/offline", post(publish_current_device_offline))
        .route("/v1/cloud/presence/contacts", get(list_contact_presence))
        .route("/v1/cloud/sync", get(sync_cloud_events))
        .route(
            "/v1/cloud/sessions/visibility",
            get(list_cloud_session_visibility),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id/hidden",
            put(hide_cloud_session).delete(unhide_cloud_session),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id",
            delete(delete_cloud_session),
        )
        .merge(crate::auth::session_activity::routes())
        .route(
            "/v1/cloud/attachments/initiate",
            post(crate::attachments::routes::initiate),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/upload",
            axum::routing::put(crate::attachments::routes::upload),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/finalize",
            post(crate::attachments::routes::finalize),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/download-url",
            get(crate::attachments::routes::download_url),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/content",
            get(crate::attachments::routes::content),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id/forks",
            get(list_cloud_session_forks).post(create_cloud_session_fork),
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
            );
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

async fn oauth_start(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider): axum::extract::Path<String>,
    Query(start_query): Query<OAuthStartQuery>,
) -> Response {
    let Some(provider) = OAuthProvider::parse(&provider) else {
        return err(
            "unknown_provider",
            "Unknown OAuth provider.",
            StatusCode::BAD_REQUEST,
        );
    };
    if !is_allowed_oauth_redirect(&start_query.redirect_after) {
        return err(
            "invalid_redirect",
            "OAuth redirect target is not allowed.",
            StatusCode::BAD_REQUEST,
        );
    }
    let config = match oauth_config(provider) {
        Ok(config) => config,
        Err(message) => {
            return err(
                "oauth_not_configured",
                message,
                StatusCode::SERVICE_UNAVAILABLE,
            );
        }
    };

    let state_id = random_url_token("oauth_state");
    let code_verifier = random_url_token("oauth_verifier");
    let now = Utc::now();
    let expires = now + ChronoDuration::minutes(10);
    if query(
        "INSERT INTO cloud_oauth_states (state_id, provider, redirect_after, code_verifier, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&state_id)
    .bind(provider.id())
    .bind(start_query.redirect_after.trim())
    .bind(&code_verifier)
    .bind(now.to_rfc3339())
    .bind(expires.to_rfc3339())
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err("server_error", "Could not create OAuth state.", StatusCode::INTERNAL_SERVER_ERROR);
    }

    let mut auth_url = url::Url::parse(provider.auth_url()).expect("valid OAuth provider auth url");
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &config.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", provider.scope())
        .append_pair("state", &state_id)
        .append_pair("code_challenge", &pkce_challenge(&code_verifier))
        .append_pair("code_challenge_method", "S256");
    if provider == OAuthProvider::Google {
        auth_url
            .query_pairs_mut()
            .append_pair("access_type", "online");
    }

    Json(OAuthStartResponse {
        auth_url: auth_url.to_string(),
    })
    .into_response()
}

async fn oauth_callback(
    State(state): State<Arc<ServerState>>,
    axum::extract::Path(provider_path): axum::extract::Path<String>,
    Query(query_params): Query<OAuthCallbackQuery>,
) -> Response {
    let Some(provider) = OAuthProvider::parse(&provider_path) else {
        return err(
            "unknown_provider",
            "Unknown OAuth provider.",
            StatusCode::BAD_REQUEST,
        );
    };
    let Some(state_id) = query_params
        .state
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return err(
            "invalid_oauth_state",
            "Missing OAuth state.",
            StatusCode::BAD_REQUEST,
        );
    };

    let pool = state.db_pool();
    let state_row: Option<(String, String, Option<String>, String)> = match query_as(
        "DELETE FROM cloud_oauth_states WHERE state_id = $1 RETURNING provider, redirect_after, code_verifier, expires_at",
    )
    .bind(state_id)
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row,
        Err(_) => return err("server_error", "Could not load OAuth state.", StatusCode::INTERNAL_SERVER_ERROR),
    };
    let Some((stored_provider, redirect_after, code_verifier, expires_at)) = state_row else {
        return err(
            "invalid_oauth_state",
            "OAuth state expired or was already used.",
            StatusCode::BAD_REQUEST,
        );
    };
    if stored_provider != provider.id() || !is_allowed_oauth_redirect(&redirect_after) {
        return err(
            "invalid_oauth_state",
            "OAuth state is invalid.",
            StatusCode::BAD_REQUEST,
        );
    }
    if chrono::DateTime::parse_from_rfc3339(&expires_at)
        .map(|value| value < Utc::now())
        .unwrap_or(true)
    {
        return redirect_with_oauth_error(&redirect_after, "OAuth state expired.");
    }
    if let Some(provider_error) = query_params.error.as_deref() {
        return redirect_with_oauth_error(&redirect_after, provider_error);
    }
    let Some(code) = query_params
        .code
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return redirect_with_oauth_error(&redirect_after, "Missing OAuth code.");
    };
    let config = match oauth_config(provider) {
        Ok(config) => config,
        Err(message) => return redirect_with_oauth_error(&redirect_after, &message),
    };
    let http = reqwest::Client::new();
    let access_token = match exchange_oauth_code(&http, &config, code, code_verifier.as_deref())
        .await
    {
        Ok(token) => token,
        Err(_) => {
            return redirect_with_oauth_error(&redirect_after, "Could not exchange OAuth code.");
        }
    };
    let profile = match fetch_oauth_profile(&http, provider, &access_token).await {
        Ok(profile) if !profile.provider_subject.trim().is_empty() => profile,
        _ => return redirect_with_oauth_error(&redirect_after, "Could not load OAuth profile."),
    };

    match complete_oauth_login(pool, provider, profile).await {
        Ok(body) => {
            let mut url = redirect_after;
            let separator = if url.contains('#') { '&' } else { '#' };
            url.push(separator);
            url.push_str("kordi_cloud_oauth=");
            url.push_str(&encode_oauth_fragment(&body));
            Redirect::to(&url).into_response()
        }
        Err(_) => redirect_with_oauth_error(&redirect_after, "Could not finish OAuth login."),
    }
}

fn oauth_account_avatar_url(
    existing_avatar_url: Option<&str>,
    provider_avatar_url: Option<&str>,
) -> Option<String> {
    let existing = existing_avatar_url.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    });
    let provider = provider_avatar_url.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    });

    if provider.is_some()
        && existing.as_deref().is_none_or(|value| {
            value.starts_with(AVATAR_SEED_PREFIX) || !value.starts_with("data:")
        })
    {
        return provider;
    }

    existing.or(provider)
}

async fn complete_oauth_login(
    pool: &PgPool,
    provider: OAuthProvider,
    profile: OAuthProfile,
) -> Result<AuthResponse, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let normalized_email = profile
        .email
        .as_deref()
        .and_then(|email| validate_email(email).ok());
    let existing_identity: Option<(String,)> = query_as(
        "SELECT account_id FROM cloud_account_identities WHERE provider = $1 AND provider_subject = $2",
    )
    .bind(provider.id())
    .bind(&profile.provider_subject)
    .fetch_optional(pool)
    .await?;
    let linked_email_account: Option<(String,)> =
        if existing_identity.is_none() && profile.email_verified {
            if let Some(email) = normalized_email.as_deref() {
                query_as("SELECT account_id FROM cloud_accounts WHERE LOWER(primary_email) = $1")
                    .bind(email)
                    .fetch_optional(pool)
                    .await?
            } else {
                None
            }
        } else {
            None
        };
    let account_id = existing_identity
        .or(linked_email_account)
        .map(|row| row.0)
        .unwrap_or_else(|| format!("acct_{}", uuid::Uuid::new_v4().simple()));
    let display_name = clean_profile_display_name(profile.display_name.as_deref())
        .or_else(|| profile.username.clone());
    let provider_avatar_url = clean_profile_avatar_url(profile.avatar_url.as_deref());
    let existing_account_avatar_url: Option<(Option<String>,)> =
        query_as("SELECT avatar_url FROM cloud_accounts WHERE account_id = $1")
            .bind(&account_id)
            .fetch_optional(pool)
            .await?;
    let avatar_url = oauth_account_avatar_url(
        existing_account_avatar_url
            .as_ref()
            .and_then(|row| row.0.as_deref()),
        provider_avatar_url.as_deref(),
    );

    let mut tx = pool.begin().await?;
    query(
        "INSERT INTO cloud_accounts (account_id, display_name, primary_email, avatar_url, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $5) \
         ON CONFLICT (account_id) DO UPDATE SET \
           display_name = COALESCE(cloud_accounts.display_name, excluded.display_name), \
           primary_email = COALESCE(cloud_accounts.primary_email, excluded.primary_email), \
           avatar_url = excluded.avatar_url, \
           updated_at = excluded.updated_at",
    )
    .bind(&account_id)
    .bind(display_name.as_deref())
    .bind(normalized_email.as_deref())
    .bind(avatar_url.as_deref())
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let identity_id = format!("oauth_{}_{}", provider.id(), uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_account_identities \
         (identity_id, account_id, provider, provider_subject, provider_username, \
          email, email_verified, avatar_url, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) \
         ON CONFLICT (provider, provider_subject) DO UPDATE SET \
           account_id = excluded.account_id, \
           provider_username = excluded.provider_username, \
           email = excluded.email, \
           email_verified = excluded.email_verified, \
           avatar_url = excluded.avatar_url, \
           updated_at = excluded.updated_at",
    )
    .bind(&identity_id)
    .bind(&account_id)
    .bind(provider.id())
    .bind(&profile.provider_subject)
    .bind(profile.username.as_deref())
    .bind(normalized_email.as_deref())
    .bind(profile.email_verified)
    .bind(avatar_url.as_deref())
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());
    let device_public_key = format!("placeholder-{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("oauth-{}-device", provider.id()))
    .bind(&device_public_key)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    let issued = issue_session(
        &mut *tx,
        &account_id,
        &device_id,
        DEFAULT_SESSION_LIFETIME_DAYS,
    )
    .await
    .map_err(|_| sqlx_core::Error::Protocol("Could not issue OAuth session.".into()))?;
    tx.commit().await?;

    let account = account_response_row(pool, &account_id)
        .await?
        .ok_or(sqlx_core::Error::RowNotFound)?;
    Ok(AuthResponse {
        account,
        session: SessionResponse {
            token: issued.plaintext_token,
            expires_at: issued.expires_at.to_rfc3339(),
        },
    })
}

async fn publish_presence_change_if_needed(
    state: &Arc<ServerState>,
    account_id: &str,
    before: crate::presence::AccountPresenceStatus,
    after: crate::presence::AccountPresenceStatus,
) {
    if before == after {
        return;
    }
    let _ = crate::presence::publish_presence_to_observers(
        state.db_pool(),
        state.events(),
        account_id,
        after,
    )
    .await;
}

async fn publish_current_device_online(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let before = crate::presence::account_presence_status(
        state.db_pool(),
        &session.account_id,
        Utc::now(),
        crate::presence::presence_timeout(),
    )
    .await
    .map(|summary| summary.status)
    .unwrap_or(crate::presence::AccountPresenceStatus::Offline);
    match crate::presence::mark_device_online(
        state.db_pool(),
        &session.account_id,
        &session.device_id,
    )
    .await
    {
        Ok(summary) => {
            publish_presence_change_if_needed(&state, &session.account_id, before, summary.status).await;
            Json(summary).into_response()
        }
        Err(_) => err(
            "server_error",
            "Could not update presence.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

async fn publish_current_device_heartbeat(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    publish_current_device_online(State(state), Extension(session)).await
}

async fn publish_current_device_offline(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let before = crate::presence::account_presence_status(
        state.db_pool(),
        &session.account_id,
        Utc::now(),
        crate::presence::presence_timeout(),
    )
    .await
    .map(|summary| summary.status)
    .unwrap_or(crate::presence::AccountPresenceStatus::Offline);
    match crate::presence::mark_device_offline(
        state.db_pool(),
        &session.account_id,
        &session.device_id,
    )
    .await
    {
        Ok(summary) => {
            publish_presence_change_if_needed(&state, &session.account_id, before, summary.status).await;
            Json(summary).into_response()
        }
        Err(_) => err(
            "server_error",
            "Could not update presence.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

async fn list_contact_presence(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match crate::presence::contact_presence_summaries(state.db_pool(), &session.account_id).await {
        Ok(accounts) => Json(PresenceContactsResponse { accounts }).into_response(),
        Err(_) => err(
            "server_error",
            "Could not load presence.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

async fn update_me(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<UpdateProfileRequest>,
) -> Response {
    let display_name = clean_profile_display_name(req.display_name.as_deref());
    let avatar_url = match clean_optional_uploaded_avatar_url(req.avatar_url.as_deref()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let now = Utc::now().to_rfc3339();
    if query(
        "UPDATE cloud_accounts \
         SET display_name = COALESCE($1, display_name), \
             avatar_url = COALESCE($2, avatar_url), \
             updated_at = $3 \
         WHERE account_id = $4",
    )
    .bind(display_name.as_deref())
    .bind(avatar_url.as_deref())
    .bind(&now)
    .bind(&session.account_id)
    .execute(state.db_pool())
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not update profile.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    match account_response_row(state.db_pool(), &session.account_id).await {
        Ok(Some(account)) => {
            let observers: Vec<(String,)> = query_as(
                "SELECT account_id FROM cloud_contacts WHERE peer_account_id = $1",
            )
            .bind(&session.account_id)
            .fetch_all(state.db_pool())
            .await
            .unwrap_or_default();
            let mut observer_account_ids: HashSet<String> = observers
                .into_iter()
                .map(|(observer_account_id,)| observer_account_id)
                .collect();
            observer_account_ids.insert(session.account_id.clone());
            if !observer_account_ids.is_empty() {
                let events = state.events().clone();
                let account_id = account.account_id.clone();
                let display_name = account.display_name.clone();
                let avatar_url = account.avatar_url.clone();
                tokio::spawn(async move {
                    for observer_account_id in observer_account_ids {
                        events
                            .publish_profile_updated(
                                &account_id,
                                &observer_account_id,
                                display_name.as_deref(),
                                avatar_url.as_deref(),
                            )
                            .await;
                    }
                });
            }
            Json(account).into_response()
        }
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

fn decoded_base64_len(encoded: &str) -> usize {
    let trimmed = encoded.trim_end_matches('=');
    (trimmed.len() * 3) / 4
}

fn clean_optional_uploaded_avatar_url(value: Option<&str>) -> Result<Option<String>, Response> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.starts_with(AVATAR_SEED_PREFIX) {
        return Err(err(
            "invalid_avatar",
            "Avatar must be an uploaded image.",
            StatusCode::BAD_REQUEST,
        ));
    }
    if let Some(payload) = raw
        .strip_prefix("data:image/png;base64,")
        .or_else(|| raw.strip_prefix("data:image/jpeg;base64,"))
        .or_else(|| raw.strip_prefix("data:image/webp;base64,"))
    {
        if decoded_base64_len(payload) <= AVATAR_UPLOAD_MAX_BYTES {
            return Ok(Some(raw.to_string()));
        }
        return Err(err(
            "invalid_avatar",
            "Avatar payload is too large after processing.",
            StatusCode::BAD_REQUEST,
        ));
    }
    Err(err(
        "invalid_avatar",
        "Avatar must be a PNG, JPEG, or WebP image.",
        StatusCode::BAD_REQUEST,
    ))
}

fn clean_required_signup_avatar_url(value: Option<&str>) -> Result<String, Response> {
    match clean_optional_uploaded_avatar_url(value) {
        Ok(Some(value)) => Ok(value),
        Ok(None) => Err(err(
            "missing_avatar",
            "Upload an avatar to sign up.",
            StatusCode::BAD_REQUEST,
        )),
        Err(response) => Err(response),
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

    let avatar_url = match clean_required_signup_avatar_url(req.avatar_url.as_deref()) {
        Ok(value) => value,
        Err(response) => return response,
    };

    let pool = state.db_pool();

    // Email uniqueness precheck — cleaner error code than mapping a UNIQUE
    // violation. The partial unique index on LOWER(primary_email) is the
    // ground-truth backstop.
    let existing: Option<(String,)> =
        match query_as("SELECT account_id FROM cloud_accounts WHERE LOWER(primary_email) = $1")
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
                );
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
            );
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
            );
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
    .bind(&avatar_url)
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

    let issued = match issue_session(
        &mut *tx,
        &account_id,
        &device_id,
        DEFAULT_SESSION_LIFETIME_DAYS,
    )
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not issue session.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
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
        avatar_url: Some(avatar_url),
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

    let row: Option<(
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = match query_as(
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
            );
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
            );
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
            );
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

    let issued = match issue_session(
        &mut *tx,
        &account_id,
        &device_id,
        DEFAULT_SESSION_LIFETIME_DAYS,
    )
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not issue session.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
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
            );
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
        let contact_row: Option<(i32,)> =
            query_as("SELECT 1 FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2")
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

    let peer_exists: Option<(i32,)> =
        match query_as("SELECT 1 FROM cloud_accounts WHERE account_id = $1")
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
                );
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
            );
        }
    };

    let contacts = rows
        .into_iter()
        .map(
            |(account_id, display_name, avatar_url, created_at)| ContactSummary {
                account_id,
                display_name,
                avatar_url,
                node_id: None,
                created_at,
            },
        )
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
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
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
            );
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
            );
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
            );
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
        return (
            StatusCode::OK,
            Json(ContactRequestResponse {
                request: summary,
                hello_message: None,
            }),
        )
            .into_response();
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
    (
        StatusCode::CREATED,
        Json(ContactRequestResponse {
            request: summary,
            hello_message: None,
        }),
    )
        .into_response()
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
            );
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
            );
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
            );
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
            );
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

    // Auto-hello: the acceptor (to_id) greets the original requester
    // (from_id) so a freshly accepted contact pair has at least one
    // message in their conversation history. We capture the id +
    // body so we can fire a message.arrived NATS event after commit.
    let hello_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let hello_body = "👋 Hi! Thanks for adding me — happy to connect.";
    let hello_session_id = cloud_direct_person_session_id(from_id, to_id);
    if query(
        "INSERT INTO cloud_messages \
         (message_id, from_account_id, to_account_id, body, created_at, session_id) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&hello_id)
    .bind(to_id)
    .bind(from_id)
    .bind(hello_body)
    .bind(&now)
    .bind(&hello_session_id)
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record hello message.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let (acceptor_hello, requester_hello) =
        contact_acceptance_hello_sync_summaries(&hello_id, from_id, to_id, hello_body, &now);
    for (account_id, peer_account_id, summary) in [
        (to_id, from_id, &acceptor_hello),
        (from_id, to_id, &requester_hello),
    ] {
        if query(
            "INSERT INTO cloud_sync_events \
             (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(account_id)
        .bind("message.upsert")
        .bind(peer_account_id)
        .bind(&summary.message_id)
        .bind(message_sync_payload(summary))
        .bind(&now)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record hello sync event.",
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
    // open WS on either account refreshes its contacts list, plus
    // the auto-hello message.arrived so the chat surface lights up.
    {
        let events = state.events().clone();
        let request_id = request_id.to_string();
        let from = from_id.to_string();
        let to = to_id.to_string();
        let hello_id = hello_id.clone();
        let hello_body = hello_body.to_string();
        let now = now.clone();
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
            // Hello message: from = acceptor (to_id in request terms),
            // recipient = requester (from_id). The recipient is the
            // one who needs the live WS frame.
            events
                .publish_message_arrived(
                    &hello_id,
                    &to,
                    &from,
                    &hello_body,
                    &now,
                    Some(&hello_session_id),
                    serde_json::json!([]),
                )
                .await;
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
    let direction = if from_id == session.account_id {
        "outgoing"
    } else {
        "incoming"
    };
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
    let hello_message = if session.account_id == to_id {
        Some(acceptor_hello)
    } else if session.account_id == from_id {
        Some(requester_hello)
    } else {
        None
    };
    (
        StatusCode::OK,
        Json(ContactRequestResponse {
            request: summary,
            hello_message,
        }),
    )
        .into_response()
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

// ---------- Cloud messages (1:1 peer chat) ----------

const MESSAGE_BODY_MAX_CHARS: usize = 4_000;
const MESSAGE_LIST_DEFAULT_LIMIT: i64 = 200;
const MESSAGE_LIST_MAX_LIMIT: i64 = 500;
const CLOUD_GROUP_CONTROL_PREFIX: &str = "kordi-cloud-group:";
const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";
const CLOUD_AGENT_CANCEL_PREFIX: &str = "kordi-cloud-agent-cancel:";
const CLOUD_MESSAGE_CLIENT_CREATED_AT_FUTURE_SKEW_SECONDS: i64 = 300;

fn cloud_direct_person_session_id(left_account_id: &str, right_account_id: &str) -> String {
    let mut account_ids = [left_account_id.trim(), right_account_id.trim()];
    account_ids.sort_unstable();
    format!(
        "session:direct-person:{}:{}",
        account_ids[0], account_ids[1]
    )
}

fn is_cloud_account_id(value: &str) -> bool {
    value.trim().starts_with("acct_")
}

fn syncable_cloud_avatar_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 {
        return None;
    }
    if value.starts_with("https://")
        || value.starts_with("http://")
        || value.starts_with("data:image/png;base64,")
        || value.starts_with("data:image/jpeg;base64,")
        || value.starts_with("data:image/webp;base64,")
    {
        return Some(value.to_string());
    }
    None
}

fn sanitize_cloud_group_participant(value: &mut Value) -> bool {
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    let account_id = object
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if !is_cloud_account_id(&account_id) {
        return false;
    }
    object.insert("accountId".to_string(), Value::String(account_id.clone()));
    let display_name = object
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&account_id)
        .to_string();
    object.insert("displayName".to_string(), Value::String(display_name));
    let avatar_url = object
        .get("avatarUrl")
        .and_then(Value::as_str)
        .and_then(syncable_cloud_avatar_url);
    object.insert(
        "avatarUrl".to_string(),
        avatar_url.map(Value::String).unwrap_or(Value::Null),
    );
    if !object.get("role").is_some_and(Value::is_string) {
        object.insert("role".to_string(), Value::String("person".to_string()));
    }
    true
}

fn is_cloud_agent_control_body(body: &str) -> bool {
    let body = body.trim_start();
    body.starts_with(CLOUD_AGENT_RESPONSE_PREFIX) || body.starts_with(CLOUD_AGENT_CANCEL_PREFIX)
}

fn sanitized_cloud_group_control_body(body: &str) -> Option<String> {
    let encoded = body.trim().strip_prefix(CLOUD_GROUP_CONTROL_PREFIX)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let mut value: Value = serde_json::from_slice(&decoded).ok()?;
    let object = value.as_object_mut()?;
    sanitize_cloud_group_participant(object.get_mut("actor")?).then_some(())?;
    let participants = object.get_mut("participants")?.as_array_mut()?;
    participants.retain_mut(sanitize_cloud_group_participant);
    if participants.is_empty() {
        return None;
    }
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).ok()?);
    Some(format!("{CLOUD_GROUP_CONTROL_PREFIX}{encoded}"))
}

fn normalize_cloud_message_body(body: &str) -> Result<String, &'static str> {
    let body = body.trim();
    if body.starts_with(CLOUD_GROUP_CONTROL_PREFIX) {
        let Some(sanitized) = sanitized_cloud_group_control_body(body) else {
            return Err("invalid_group_control");
        };
        if sanitized.chars().count() > MESSAGE_BODY_MAX_CHARS {
            return Err("message_too_large");
        }
        return Ok(sanitized);
    }
    if is_cloud_agent_control_body(body) {
        return Ok(body.to_string());
    }
    Ok(body
        .chars()
        .take(MESSAGE_BODY_MAX_CHARS)
        .collect::<String>())
}

fn cloud_message_session_id(
    requested_session_id: Option<&str>,
    from_account_id: &str,
    to_account_id: &str,
    body: &str,
) -> Option<String> {
    if let Some(value) = requested_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(value.chars().take(256).collect::<String>());
    }
    if from_account_id != to_account_id && cloud_message_requires_accepted_contact(body) {
        return Some(cloud_direct_person_session_id(
            from_account_id,
            to_account_id,
        ));
    }
    None
}

fn cloud_message_effective_created_at(
    client_created_at: Option<&str>,
    now: DateTime<Utc>,
) -> String {
    let Some(raw) = client_created_at
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return now.to_rfc3339();
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(raw) else {
        return now.to_rfc3339();
    };
    let parsed_utc = parsed.with_timezone(&Utc);
    if parsed_utc
        > now + ChronoDuration::seconds(CLOUD_MESSAGE_CLIENT_CREATED_AT_FUTURE_SKEW_SECONDS)
    {
        return now.to_rfc3339();
    }
    parsed_utc.to_rfc3339()
}

fn cloud_message_requires_accepted_contact(body: &str) -> bool {
    !body.trim_start().starts_with(CLOUD_GROUP_CONTROL_PREFIX)
}

#[cfg(test)]
mod cloud_message_policy_tests {
    use super::{
        cloud_direct_person_session_id, cloud_message_effective_created_at,
        cloud_message_requires_accepted_contact, contact_acceptance_hello_sync_summaries,
        normalize_cloud_message_body, sanitized_cloud_group_control_body,
        CLOUD_AGENT_RESPONSE_PREFIX, CLOUD_GROUP_CONTROL_PREFIX,
    };
    use base64::Engine as _;
    use chrono::{TimeZone, Utc};

    #[test]
    fn cloud_agent_response_has_no_app_level_character_limit() {
        let body = format!("{CLOUD_AGENT_RESPONSE_PREFIX}{}", "a".repeat(200_000));

        assert_eq!(normalize_cloud_message_body(&body).unwrap(), body);
    }

    #[test]
    fn cloud_group_control_messages_do_not_require_direct_contacts() {
        assert!(!cloud_message_requires_accepted_contact(
            "kordi-cloud-group:abc"
        ));
        assert!(cloud_message_requires_accepted_contact("hello"));
    }

    #[test]
    fn cloud_message_effective_created_at_preserves_valid_client_instant_with_offset() {
        let now = Utc.with_ymd_and_hms(2026, 5, 14, 12, 0, 0).unwrap();
        assert_eq!(
            cloud_message_effective_created_at(Some("2026-05-14T03:30:00-07:00"), now),
            "2026-05-14T10:30:00+00:00"
        );
    }

    #[test]
    fn cloud_message_effective_created_at_rejects_invalid_or_too_future_client_time() {
        let now = Utc.with_ymd_and_hms(2026, 5, 14, 12, 0, 0).unwrap();
        assert_eq!(
            cloud_message_effective_created_at(Some("bad timestamp"), now),
            "2026-05-14T12:00:00+00:00"
        );
        assert_eq!(
            cloud_message_effective_created_at(Some("2026-05-14T12:10:01Z"), now),
            "2026-05-14T12:00:00+00:00"
        );
    }

    #[test]
    fn cloud_group_control_sanitizer_removes_local_ids_and_data_avatars() {
        let envelope = serde_json::json!({
            "kind": "group-message",
            "groupId": "session:group:1",
            "groupSpaceId": "session:group:1",
            "groupTitle": null,
            "createdByAccountId": "acct_a",
            "actor": { "accountId": "acct_a", "displayName": "Alice", "avatarUrl": "data:image/jpeg;base64,".to_string() + &"x".repeat(5000), "role": "person" },
            "participants": [
                { "accountId": "acct_a", "displayName": "Alice", "avatarUrl": "data:image/jpeg;base64,".to_string() + &"x".repeat(5000), "role": "admin" },
                { "accountId": "kh_local", "displayName": "Local", "avatarUrl": null, "role": "self" },
                { "accountId": "acct_b", "displayName": "Bob", "avatarUrl": "https://images.test/bob.png", "role": "person" }
            ],
            "message": { "id": "msg_1", "senderAccountId": "acct_a", "text": "@BobKordi hi", "createdAtMs": 1 }
        });
        let body = format!(
            "{CLOUD_GROUP_CONTROL_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&envelope).unwrap())
        );

        let sanitized = sanitized_cloud_group_control_body(&body).expect("sanitize group control");
        assert!(sanitized.len() < 4_000);
        let encoded = sanitized.strip_prefix(CLOUD_GROUP_CONTROL_PREFIX).unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(encoded)
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&decoded).unwrap();

        assert_eq!(parsed["actor"]["avatarUrl"], serde_json::Value::Null);
        assert_eq!(parsed["participants"].as_array().unwrap().len(), 2);
        assert_eq!(
            parsed["participants"][0]["avatarUrl"],
            serde_json::Value::Null
        );
        assert_eq!(parsed["participants"][1]["accountId"], "acct_b");
    }

    #[test]
    fn cloud_direct_person_session_id_is_stable_for_account_order() {
        assert_eq!(
            cloud_direct_person_session_id("acct_me", "acct_peer"),
            "session:direct-person:acct_me:acct_peer"
        );
        assert_eq!(
            cloud_direct_person_session_id("acct_peer", "acct_me"),
            "session:direct-person:acct_me:acct_peer"
        );
    }

    #[test]
    fn contact_acceptance_hello_sync_events_cover_both_participants() {
        let (acceptor, requester) = contact_acceptance_hello_sync_summaries(
            "msg_hello",
            "acct_requester",
            "acct_acceptor",
            "hello",
            "2026-05-15T08:54:12Z",
        );

        assert_eq!(acceptor.from_account_id, "acct_acceptor");
        assert_eq!(acceptor.to_account_id, "acct_requester");
        assert_eq!(
            acceptor.session_id.as_deref(),
            Some("session:direct-person:acct_acceptor:acct_requester")
        );
        assert_eq!(acceptor.direction, "outgoing");
        assert_eq!(requester.from_account_id, "acct_acceptor");
        assert_eq!(requester.to_account_id, "acct_requester");
        assert_eq!(
            requester.session_id.as_deref(),
            Some("session:direct-person:acct_acceptor:acct_requester")
        );
        assert_eq!(requester.direction, "incoming");
        assert_eq!(
            acceptor.delivered_at.as_deref(),
            Some("2026-05-15T08:54:12Z")
        );
        assert_eq!(
            requester.delivered_at.as_deref(),
            Some("2026-05-15T08:54:12Z")
        );
    }
}

fn message_sync_payload(message: &MessageSummary) -> serde_json::Value {
    serde_json::json!({ "message": message })
}

fn contact_acceptance_hello_sync_summaries(
    message_id: &str,
    request_from_account_id: &str,
    request_to_account_id: &str,
    body: &str,
    created_at: &str,
) -> (MessageSummary, MessageSummary) {
    let session_id = Some(cloud_direct_person_session_id(
        request_from_account_id,
        request_to_account_id,
    ));
    let acceptor_summary = MessageSummary {
        message_id: message_id.to_string(),
        from_account_id: request_to_account_id.to_string(),
        to_account_id: request_from_account_id.to_string(),
        body: body.to_string(),
        session_id,
        created_at: created_at.to_string(),
        delivered_at: Some(created_at.to_string()),
        read_at: None,
        direction: "outgoing".into(),
        attachments: vec![],
    };
    let requester_summary = MessageSummary {
        direction: "incoming".into(),
        ..acceptor_summary.clone()
    };
    (acceptor_summary, requester_summary)
}

async fn append_cloud_sync_event(
    pool: &PgPool,
    account_id: &str,
    event_type: &str,
    peer_account_id: Option<&str>,
    message_id: Option<&str>,
    payload: serde_json::Value,
    occurred_at: &str,
) -> Result<(), sqlx_core::error::Error> {
    query(
        "INSERT INTO cloud_sync_events \
         (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(account_id)
    .bind(event_type)
    .bind(peer_account_id)
    .bind(message_id)
    .bind(payload)
    .bind(occurred_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// `GET /v1/cloud/sync?cursor=...&limit=...` — return account-scoped
/// ordered Cloud changes after the caller's last successfully applied cursor.
async fn sync_cloud_events(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Query(q): axum::extract::Query<CloudSyncQuery>,
) -> Response {
    let cursor = q.cursor.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(500).clamp(1, 1000);
    let fetch_limit = limit + 1;
    let rows: Vec<(
        i64,
        String,
        Option<String>,
        Option<String>,
        serde_json::Value,
        String,
    )> = match query_as(
        "SELECT event_id, event_type, peer_account_id, message_id, payload_json, occurred_at \
             FROM cloud_sync_events \
             WHERE account_id = $1 AND event_id > $2 \
             ORDER BY event_id ASC \
             LIMIT $3",
    )
    .bind(&session.account_id)
    .bind(cursor)
    .bind(fetch_limit)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let has_more = rows.len() as i64 > limit;
    let events: Vec<CloudSyncEventSummary> = rows
        .into_iter()
        .take(limit as usize)
        .map(
            |(event_id, event_type, peer_account_id, message_id, payload, occurred_at)| {
                CloudSyncEventSummary {
                    event_id: event_id.to_string(),
                    event_type,
                    peer_account_id,
                    message_id,
                    payload,
                    occurred_at,
                }
            },
        )
        .collect();
    let next_cursor = events
        .last()
        .map(|event| event.event_id.clone())
        .unwrap_or_else(|| cursor.to_string());

    Json(CloudSyncResponse {
        cursor: next_cursor,
        has_more,
        events,
    })
    .into_response()
}

/// `POST /v1/cloud/messages` — send a 1:1 message to a peer the caller
/// already has in their contacts. Body is plain UTF-8 for now; E2EE
/// is a later session (it'll migrate writes to `server_messages`).
async fn send_message(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<SendMessageRequest>,
) -> Response {
    let peer = req.peer_account_id.trim().to_string();
    if peer.is_empty() {
        return err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let is_self_message = peer == session.account_id;
    let body = req.body.trim();
    if body.is_empty() && req.attachments.is_empty() {
        return err(
            "empty_message",
            "Message body or attachment is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let body = match normalize_cloud_message_body(body) {
        Ok(body) => body,
        Err("invalid_group_control") => {
            return err(
                "invalid_group_control",
                "Cloud group control payload is invalid.",
                StatusCode::BAD_REQUEST,
            );
        }
        Err("message_too_large") => {
            return err(
                "message_too_large",
                "Cloud control payload is too large.",
                StatusCode::BAD_REQUEST,
            );
        }
        Err(_) => {
            return err(
                "invalid_message",
                "Cloud message payload is invalid.",
                StatusCode::BAD_REQUEST,
            );
        }
    };

    let pool = state.db_pool();

    let mut attachments = Vec::new();
    for input in &req.attachments {
        let attachment_id = input.attachment_id.trim();
        if attachment_id.is_empty() {
            return err(
                "invalid_attachment",
                "attachmentId is required.",
                StatusCode::BAD_REQUEST,
            );
        }
        let row: Option<(String, String, Option<String>, Option<i64>, Option<String>)> =
            match query_as(
                "SELECT owner_account_id, object_key, content_type, size_bytes, finalized_at \
             FROM cloud_attachments \
             WHERE attachment_id = $1",
            )
            .bind(attachment_id)
            .fetch_optional(pool)
            .await
            {
                Ok(value) => value,
                Err(_) => {
                    return err(
                        "server_error",
                        "Database error.",
                        StatusCode::INTERNAL_SERVER_ERROR,
                    );
                }
            };
        let Some((owner_account_id, _object_key, db_mime_type, db_size_bytes, finalized_at)) = row
        else {
            return err(
                "invalid_attachment",
                "Attachment not found.",
                StatusCode::BAD_REQUEST,
            );
        };
        if owner_account_id != session.account_id {
            return err(
                "invalid_attachment",
                "Attachment does not belong to the sender.",
                StatusCode::FORBIDDEN,
            );
        }
        if finalized_at.is_none() {
            return err(
                "invalid_attachment",
                "Attachment upload has not been finalized.",
                StatusCode::CONFLICT,
            );
        }
        let normalized = match normalize_message_attachment(
            input,
            attachment_id,
            db_mime_type,
            db_size_bytes,
            None,
        ) {
            Ok(value) => value,
            Err(resp) => return resp,
        };
        attachments.push(normalized);
    }

    // Both directions of the contact must exist. The peer must have
    // accepted you OR you must have accepted them — we enforce mutual
    // acceptance so an attacker who guesses an account id can't DM a
    // stranger. (Single-row check is fine because finalize_request_acceptance
    // always inserts both rows in the same tx.)
    let mutual: Option<(i32,)> = match query_as(
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
            );
        }
    };
    if !is_self_message && mutual.is_none() && cloud_message_requires_accepted_contact(&body) {
        return err(
            "not_a_contact",
            "You can only message accepted contacts.",
            StatusCode::FORBIDDEN,
        );
    }

    let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let cloud_session_id =
        cloud_message_session_id(req.session_id.as_deref(), &session.account_id, &peer, &body);
    let server_received_at = Utc::now();
    let created_at =
        cloud_message_effective_created_at(req.client_created_at.as_deref(), server_received_at);
    let delivered_at = server_received_at.to_rfc3339();
    if query(
        "INSERT INTO cloud_messages \
         (message_id, from_account_id, to_account_id, body, created_at, delivered_at, session_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&message_id)
    .bind(&session.account_id)
    .bind(&peer)
    .bind(&body)
    .bind(&created_at)
    .bind(&delivered_at)
    .bind(&cloud_session_id)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record message.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    for (position, attachment) in attachments.iter().enumerate() {
        if query(
            "INSERT INTO cloud_message_attachments \
             (message_id, attachment_id, name, kind, mime_type, size_bytes, position) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&message_id)
        .bind(&attachment.attachment_id)
        .bind(&attachment.name)
        .bind(&attachment.kind)
        .bind(attachment.mime_type.as_deref())
        .bind(attachment.size_bytes)
        .bind(position as i32)
        .execute(pool)
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record message attachment.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    // Live fanout to the recipient's open WS.
    {
        let events = state.events().clone();
        let message_id = message_id.clone();
        let from = session.account_id.clone();
        let to = peer.clone();
        let body_clone = body.clone();
        let created_at = created_at.clone();
        let session_id = cloud_session_id.clone();
        let event_attachments =
            serde_json::to_value(&attachments).unwrap_or_else(|_| serde_json::json!([]));
        tokio::spawn(async move {
            events
                .publish_message_arrived(
                    &message_id,
                    &from,
                    &to,
                    &body_clone,
                    &created_at,
                    session_id.as_deref(),
                    event_attachments,
                )
                .await;
        });
    }

    let summary = MessageSummary {
        message_id,
        from_account_id: session.account_id.clone(),
        to_account_id: peer.clone(),
        body,
        session_id: cloud_session_id,
        created_at: created_at.clone(),
        delivered_at: Some(delivered_at.clone()),
        read_at: None,
        direction: "outgoing".into(),
        attachments,
    };

    if let Some(session_id) = summary.session_id.as_deref() {
        if clear_cloud_session_visibility_for_update(pool, &session.account_id, session_id)
            .await
            .is_err()
        {
            return err(
                "server_error",
                "Could not restore updated session visibility.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
        if peer != session.account_id
            && clear_cloud_session_visibility_for_update(pool, &peer, session_id)
                .await
                .is_err()
        {
            return err(
                "server_error",
                "Could not restore updated session visibility.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    if append_cloud_sync_event(
        pool,
        &session.account_id,
        "message.upsert",
        Some(&peer),
        Some(&summary.message_id),
        message_sync_payload(&summary),
        &delivered_at,
    )
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if peer != session.account_id {
        let recipient_summary = MessageSummary {
            direction: "incoming".into(),
            ..summary.clone()
        };
        if append_cloud_sync_event(
            pool,
            &peer,
            "message.upsert",
            Some(&session.account_id),
            Some(&summary.message_id),
            message_sync_payload(&recipient_summary),
            &delivered_at,
        )
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record sync event.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    (
        StatusCode::CREATED,
        Json(MessageResponse { message: summary }),
    )
        .into_response()
}

/// `POST /v1/cloud/messages/read` — mark all messages from a peer to
/// the caller as read. This lets sender-side polling render WhatsApp-style
/// blue double-checks once the recipient has opened the conversation.
async fn mark_messages_read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<MarkMessagesReadRequest>,
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
        return StatusCode::NO_CONTENT.into_response();
    }

    let now = Utc::now().to_rfc3339();
    let pool = state.db_pool();
    let read_rows: Result<Vec<(String,)>, _> = query_as(
        "UPDATE cloud_messages \
         SET read_at = COALESCE(read_at, $1), \
             delivered_at = COALESCE(delivered_at, $1) \
         WHERE from_account_id = $2 AND to_account_id = $3 AND read_at IS NULL \
         RETURNING message_id",
    )
    .bind(&now)
    .bind(&peer)
    .bind(&session.account_id)
    .fetch_all(pool)
    .await;
    let Ok(read_rows) = read_rows else {
        return err(
            "server_error",
            "Could not mark messages read.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };

    let message_ids: Vec<String> = read_rows.into_iter().map(|row| row.0).collect();
    if !message_ids.is_empty() {
        if append_cloud_sync_event(
            pool,
            &peer,
            "message.read",
            Some(&session.account_id),
            None,
            serde_json::json!({
                "readerAccountId": &session.account_id,
                "messageIds": &message_ids,
                "readAt": &now,
            }),
            &now,
        )
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record sync event.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }

        let events = state.events().clone();
        let reader = session.account_id.clone();
        let sender = peer.clone();
        let occurred_at = now.clone();
        tokio::spawn(async move {
            events
                .publish_message_read(&reader, &sender, &occurred_at)
                .await;
        });
    }

    StatusCode::NO_CONTENT.into_response()
}

/// `POST /v1/cloud/sessions/:source_session_id/read` — mark all messages
/// delivered to the caller inside a Cloud/canonical session as read. Group
/// sessions are fanout into pairwise rows, so a session-level read cursor is
/// the durable source of truth for clearing grouped unread badges.
async fn mark_session_messages_read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let source_session_id = source_session_id.trim().to_string();
    if source_session_id.is_empty() {
        return err(
            "invalid_session_id",
            "Session id is required.",
            StatusCode::BAD_REQUEST,
        );
    }

    let now = Utc::now().to_rfc3339();
    let pool = state.db_pool();
    let read_rows: Result<Vec<(String, String)>, _> = query_as(
        "UPDATE cloud_messages \
         SET read_at = COALESCE(read_at, $1), \
             delivered_at = COALESCE(delivered_at, $1) \
         WHERE session_id = $2 AND to_account_id = $3 AND read_at IS NULL \
         RETURNING message_id, from_account_id",
    )
    .bind(&now)
    .bind(&source_session_id)
    .bind(&session.account_id)
    .fetch_all(pool)
    .await;
    let Ok(read_rows) = read_rows else {
        return err(
            "server_error",
            "Could not mark session messages read.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };

    let mut message_ids_by_peer = std::collections::BTreeMap::<String, Vec<String>>::new();
    for (message_id, peer_account_id) in read_rows {
        message_ids_by_peer
            .entry(peer_account_id)
            .or_default()
            .push(message_id);
    }

    for (peer, message_ids) in &message_ids_by_peer {
        if append_cloud_sync_event(
            pool,
            peer,
            "message.read",
            Some(&session.account_id),
            Some(&source_session_id),
            serde_json::json!({
                "readerAccountId": &session.account_id,
                "messageIds": message_ids,
                "readAt": &now,
                "sessionId": &source_session_id,
            }),
            &now,
        )
        .await
        .is_err()
        {
            return err(
                "server_error",
                "Could not record sync event.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }

        let events = state.events().clone();
        let reader = session.account_id.clone();
        let sender = peer.clone();
        let occurred_at = now.clone();
        tokio::spawn(async move {
            events
                .publish_message_read(&reader, &sender, &occurred_at)
                .await;
        });
    }

    StatusCode::NO_CONTENT.into_response()
}

/// `GET /v1/cloud/messages?peerAccountId=...&limit=...` — list the
/// caller's conversation with a single peer, oldest first.
async fn list_messages(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Query(q): axum::extract::Query<MessagesQuery>,
) -> Response {
    let peer = q.peer_account_id.trim().to_string();
    if peer.is_empty() {
        return err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let limit = q
        .limit
        .unwrap_or(MESSAGE_LIST_DEFAULT_LIMIT)
        .clamp(1, MESSAGE_LIST_MAX_LIMIT);

    let pool = state.db_pool();

    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    )> = match query_as(
        "SELECT message_id, from_account_id, to_account_id, body, session_id, created_at, \
                delivered_at, read_at \
         FROM ( \
             SELECT message_id, from_account_id, to_account_id, body, session_id, created_at, \
                    delivered_at, read_at \
             FROM cloud_messages \
             WHERE (from_account_id = $1 AND to_account_id = $2) \
                OR (from_account_id = $2 AND to_account_id = $1) \
             ORDER BY created_at DESC \
             LIMIT $3 \
         ) recent_messages \
         ORDER BY created_at ASC",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .bind(limit)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let message_ids: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
    let attachment_rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<i64>,
        String,
    )> = if message_ids.is_empty() {
        Vec::new()
    } else {
        match query_as(
            "SELECT cma.message_id, cma.attachment_id, cma.name, cma.kind, cma.mime_type, cma.size_bytes, ca.object_key \
             FROM cloud_message_attachments cma \
             JOIN cloud_attachments ca ON ca.attachment_id = cma.attachment_id \
             WHERE cma.message_id = ANY($1) \
             ORDER BY cma.position ASC",
        )
        .bind(&message_ids)
        .fetch_all(pool)
        .await
        {
            Ok(value) => value,
            Err(_) => {
                return err(
                    "server_error",
                    "Database error.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        }
    };
    let mut attachments_by_message_id: HashMap<String, Vec<MessageAttachmentSummary>> =
        HashMap::new();
    for (message_id, attachment_id, name, kind, mime_type, size_bytes, _object_key) in
        attachment_rows
    {
        attachments_by_message_id
            .entry(message_id)
            .or_default()
            .push(MessageAttachmentSummary {
                attachment_id,
                name,
                kind,
                mime_type,
                size_bytes,
                preview_url: None,
                download_url: None,
            });
    }

    let me = &session.account_id;
    let messages: Vec<MessageSummary> = rows
        .into_iter()
        .map(
            |(message_id, from_id, to_id, body, session_id, created_at, delivered_at, read_at)| {
                let direction = if from_id == *me {
                    "outgoing"
                } else {
                    "incoming"
                };
                let attachments = attachments_by_message_id
                    .remove(&message_id)
                    .unwrap_or_default();
                MessageSummary {
                    message_id,
                    from_account_id: from_id,
                    to_account_id: to_id,
                    body,
                    session_id,
                    created_at,
                    delivered_at,
                    read_at,
                    direction: direction.into(),
                    attachments,
                }
            },
        )
        .collect();

    Json(MessageListResponse { messages }).into_response()
}

fn normalized_source_session_id(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return None;
    }
    Some(trimmed.to_string())
}

async fn caller_can_access_cloud_session(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<bool, sqlx_core::error::Error> {
    let participants = cloud_session_participants(pool, session_id).await?;
    Ok(participants
        .iter()
        .any(|participant| participant == account_id))
}

async fn clear_cloud_session_visibility_for_update(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<(), sqlx_core::error::Error> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Ok(());
    }
    query(
        "DELETE FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND session_id = $2",
    )
    .bind(account_id)
    .bind(session_id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn list_cloud_session_visibility(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: Vec<(String, Option<String>, Option<String>)> = match query_as(
        "SELECT session_id, hidden_at, deleted_at \
         FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND (hidden_at IS NOT NULL OR deleted_at IS NOT NULL) \
         ORDER BY updated_at ASC",
    )
    .bind(&session.account_id)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let mut hidden_session_ids = Vec::new();
    let mut deleted_session_ids = Vec::new();
    for (session_id, hidden_at, deleted_at) in rows {
        if deleted_at.is_some() {
            deleted_session_ids.push(session_id);
        } else if hidden_at.is_some() {
            hidden_session_ids.push(session_id);
        }
    }

    Json(CloudSessionVisibilityResponse {
        hidden_session_ids,
        deleted_session_ids,
    })
    .into_response()
}

async fn hide_cloud_session(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    };

    let pool = state.db_pool();
    match caller_can_access_cloud_session(pool, &session.account_id, &session_id).await {
        Ok(true) => {}
        Ok(false) => {
            return err(
                "not_a_participant",
                "You can only hide sessions you participate in.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_account_session_visibility \
         (account_id, session_id, hidden_at, deleted_at, updated_at) \
         VALUES ($1, $2, $3, NULL, $3) \
         ON CONFLICT (account_id, session_id) DO UPDATE SET \
           hidden_at = EXCLUDED.hidden_at, \
           deleted_at = cloud_account_session_visibility.deleted_at, \
           updated_at = EXCLUDED.updated_at",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not hide cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if append_cloud_sync_event(
        pool,
        &session.account_id,
        "session.hidden",
        Some(&session_id),
        None,
        serde_json::json!({ "sessionId": &session_id, "hiddenAt": &now }),
        &now,
    )
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record hide sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    StatusCode::NO_CONTENT.into_response()
}

async fn unhide_cloud_session(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    };

    let pool = state.db_pool();
    match caller_can_access_cloud_session(pool, &session.account_id, &session_id).await {
        Ok(true) => {}
        Ok(false) => {
            return err(
                "not_a_participant",
                "You can only unhide sessions you participate in.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "DELETE FROM cloud_account_session_visibility \
         WHERE account_id = $1 AND session_id = $2 AND deleted_at IS NULL",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not unhide cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if query(
        "UPDATE cloud_account_session_visibility \
         SET hidden_at = NULL, updated_at = $3 \
         WHERE account_id = $1 AND session_id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not unhide cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if append_cloud_sync_event(
        pool,
        &session.account_id,
        "session.unhidden",
        Some(&session_id),
        None,
        serde_json::json!({ "sessionId": &session_id, "unhiddenAt": &now }),
        &now,
    )
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record unhide sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    StatusCode::NO_CONTENT.into_response()
}

async fn delete_cloud_session(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let Some(session_id) = normalized_source_session_id(&source_session_id) else {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    };

    let pool = state.db_pool();
    match caller_can_access_cloud_session(pool, &session.account_id, &session_id).await {
        Ok(true) => {}
        Ok(false) => {
            return err(
                "not_a_participant",
                "You can only remove sessions you participate in.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    let now = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_account_session_visibility \
         (account_id, session_id, hidden_at, deleted_at, updated_at) \
         VALUES ($1, $2, NULL, $3, $3) \
         ON CONFLICT (account_id, session_id) DO UPDATE SET \
           hidden_at = NULL, \
           deleted_at = EXCLUDED.deleted_at, \
           updated_at = EXCLUDED.updated_at",
    )
    .bind(&session.account_id)
    .bind(&session_id)
    .bind(&now)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not remove cloud session.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    if append_cloud_sync_event(
        pool,
        &session.account_id,
        "session.deleted",
        Some(&session_id),
        None,
        serde_json::json!({ "sessionId": &session_id, "deletedAt": &now }),
        &now,
    )
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not record remove sync event.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    StatusCode::NO_CONTENT.into_response()
}

// ============================================================================
// Cloud session forks
// ----------------------------------------------------------------------------
// Issue #353 / fork lineage for cloud-sync. The forker calls
// `POST /v1/cloud/sessions/:source_session_id/forks` with a client-generated
// `forkSessionId` and an optional `parentMessageId`. The server records the
// lineage in `cloud_session_forks` and emits a `session-forked` event into
// `cloud_sync_events` for every distinct participant of the source session
// (anyone who sent or received any message with `session_id == source`).
// Forker's own messages under the new fork session stay private to them; other
// participants only learn lineage, not content.
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct CreateCloudSessionForkRequest {
    #[serde(rename = "forkSessionId")]
    pub fork_session_id: String,
    #[serde(rename = "parentMessageId")]
    pub parent_message_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CloudSessionForkSummary {
    #[serde(rename = "forkSessionId")]
    pub fork_session_id: String,
    #[serde(rename = "parentSessionId")]
    pub parent_session_id: String,
    #[serde(rename = "parentMessageId", skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    #[serde(rename = "createdByAccountId")]
    pub created_by_account_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct CreateCloudSessionForkResponse {
    pub fork: CloudSessionForkSummary,
}

#[derive(Debug, Serialize)]
pub struct ListCloudSessionForksResponse {
    pub forks: Vec<CloudSessionForkSummary>,
}

#[derive(Debug, Deserialize)]
struct CloudGroupControlParticipantForAuth {
    #[serde(rename = "accountId")]
    account_id: String,
}

#[derive(Debug, Deserialize)]
struct CloudGroupControlForAuth {
    #[serde(rename = "groupId")]
    group_id: String,
    #[serde(rename = "groupSpaceId")]
    group_space_id: Option<String>,
    #[serde(rename = "createdByAccountId")]
    created_by_account_id: String,
    actor: CloudGroupControlParticipantForAuth,
    participants: Vec<CloudGroupControlParticipantForAuth>,
}

fn parse_cloud_group_control_for_auth(body: &str) -> Option<CloudGroupControlForAuth> {
    let encoded = body.strip_prefix(CLOUD_GROUP_CONTROL_PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice::<CloudGroupControlForAuth>(&bytes).ok()
}

async fn cloud_session_participants(
    pool: &PgPool,
    session_id: &str,
) -> Result<Vec<String>, sqlx_core::error::Error> {
    let mut participants: Vec<String> = query_as::<_, (String,)>(
        "SELECT DISTINCT account_id FROM (\
            SELECT from_account_id AS account_id FROM cloud_messages WHERE session_id = $1 \
            UNION \
            SELECT to_account_id AS account_id FROM cloud_messages WHERE session_id = $1 \
         ) AS participants",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(account_id,)| account_id)
    .collect();

    let group_rows: Vec<(String, String, String)> = query_as(
        "SELECT from_account_id, to_account_id, body FROM cloud_messages WHERE body LIKE $1",
    )
    .bind(format!("{}%", CLOUD_GROUP_CONTROL_PREFIX))
    .fetch_all(pool)
    .await?;
    for (from_account_id, to_account_id, body) in group_rows {
        let Some(control) = parse_cloud_group_control_for_auth(&body) else {
            continue;
        };
        let group_space_id = control.group_space_id.as_deref().unwrap_or_default().trim();
        if control.group_id.trim() != session_id && group_space_id != session_id {
            continue;
        }
        participants.push(from_account_id);
        participants.push(to_account_id);
        participants.push(control.created_by_account_id);
        participants.push(control.actor.account_id);
        participants.extend(
            control
                .participants
                .into_iter()
                .map(|participant| participant.account_id),
        );
    }
    participants.sort();
    participants.dedup();
    Ok(participants)
}

async fn create_cloud_session_fork(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
    Json(req): Json<CreateCloudSessionForkRequest>,
) -> Response {
    let parent_session_id = source_session_id.trim().to_string();
    let fork_session_id = req.fork_session_id.trim().to_string();
    let parent_message_id = req
        .parent_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);

    if parent_session_id.is_empty() {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if fork_session_id.is_empty() {
        return err(
            "invalid_fork",
            "forkSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if fork_session_id == parent_session_id {
        return err(
            "invalid_fork",
            "forkSessionId must differ from sourceSessionId.",
            StatusCode::BAD_REQUEST,
        );
    }

    let pool = state.db_pool();
    let participants = match cloud_session_participants(pool, &parent_session_id).await {
        Ok(participants) => participants,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    // The caller must be a participant of the source session — otherwise they
    // shouldn't even know it exists. (Authorization gate.)
    if !participants.iter().any(|id| id == &session.account_id) {
        return err(
            "not_a_participant",
            "You can only fork sessions you participate in.",
            StatusCode::FORBIDDEN,
        );
    }

    let created_at = Utc::now().to_rfc3339();
    if query(
        "INSERT INTO cloud_session_forks \
         (fork_session_id, parent_session_id, parent_message_id, created_by_account_id, created_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&fork_session_id)
    .bind(&parent_session_id)
    .bind(&parent_message_id)
    .bind(&session.account_id)
    .bind(&created_at)
    .execute(pool)
    .await
    .is_err()
    {
        return err(
            "fork_exists",
            "A fork with that id already exists.",
            StatusCode::CONFLICT,
        );
    }

    let fork = CloudSessionForkSummary {
        fork_session_id: fork_session_id.clone(),
        parent_session_id: parent_session_id.clone(),
        parent_message_id: parent_message_id.clone(),
        created_by_account_id: session.account_id.clone(),
        created_at: created_at.clone(),
    };

    let _ = crate::auth::session_activity::copy_cloud_session_activity_to_fork(
        pool,
        &parent_session_id,
        &fork_session_id,
        &created_at,
    )
    .await;

    // Fan out a `session-forked` event to every participant of the source
    // session, including the forker themselves. Failures on individual
    // recipients shouldn't roll back the fork — the canonical row is the
    // source of truth and clients can full-resync via the existing cursor
    // fallback in cloudDiffSync if they miss the event.
    let payload = serde_json::to_value(&fork).unwrap_or_else(|_| serde_json::json!({}));
    for participant in &participants {
        let _ = append_cloud_sync_event(
            pool,
            participant,
            "session-forked",
            Some(&parent_session_id),
            None,
            payload.clone(),
            &created_at,
        )
        .await;
    }

    (
        StatusCode::CREATED,
        Json(CreateCloudSessionForkResponse { fork }),
    )
        .into_response()
}

async fn list_cloud_session_forks(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(source_session_id): axum::extract::Path<String>,
) -> Response {
    let parent_session_id = source_session_id.trim().to_string();
    if parent_session_id.is_empty() {
        return err(
            "invalid_session",
            "sourceSessionId is required.",
            StatusCode::BAD_REQUEST,
        );
    }

    let pool = state.db_pool();
    let participants = match cloud_session_participants(pool, &parent_session_id).await {
        Ok(participants) => participants,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    // Only participants of the source session can list forks.
    if !participants.iter().any(|id| id == &session.account_id) {
        return err(
            "not_a_participant",
            "You can only list forks of sessions you participate in.",
            StatusCode::FORBIDDEN,
        );
    }

    let rows: Vec<(String, String, Option<String>, String, String)> = match query_as(
        "SELECT fork_session_id, parent_session_id, parent_message_id, created_by_account_id, created_at \
         FROM cloud_session_forks WHERE parent_session_id = $1 ORDER BY created_at ASC",
    )
    .bind(&parent_session_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let forks = rows
        .into_iter()
        .map(
            |(
                fork_session_id,
                parent_session_id,
                parent_message_id,
                created_by_account_id,
                created_at,
            )| {
                CloudSessionForkSummary {
                    fork_session_id,
                    parent_session_id,
                    parent_message_id,
                    created_by_account_id,
                    created_at,
                }
            },
        )
        .collect();

    Json(ListCloudSessionForksResponse { forks }).into_response()
}
