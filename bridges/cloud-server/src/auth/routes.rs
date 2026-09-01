//! HTTP routes for the Cloud Edition email/password auth slice (Postgres).
//!
//! Mounted under `/v1/cloud/auth/*`, `/v1/cloud/accounts/:id/profile`, and
//! `/v1/cloud/contacts`. Talks to Postgres via the `sqlx::PgPool` owned by
//! `ServerState`. Every handler is straight-line async — no DbRunner
//! closures, no spawn_blocking — because sqlx is async-native.

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::extract::{ConnectInfo, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use tower::limit::ConcurrencyLimitLayer;

use crate::attachments::MULTIPART_CHUNK_SIZE;
use crate::auth::devices::{
    append_device_sync_event, authorize_device, legacy_device_registration,
    normalize_device_metadata, normalize_device_registration, DeviceRegistrationRequest,
    NormalizedDeviceRegistration,
};
use crate::auth::oauth::{
    clean_profile_avatar_url, clean_profile_display_name, encode_oauth_fragment,
    exchange_oauth_code, fetch_oauth_profile, is_allowed_oauth_redirect, oauth_config,
    oauth_provider_is_configured, pkce_challenge, random_url_token, redirect_with_oauth_error,
    OAuthProfile, OAuthProvider,
};
use crate::auth::password::{
    hash_password, validate_email, validate_password_strength, verify_password, EmailFormatError,
    PasswordHasherConfig, PasswordPolicyError, PASSWORD_ALGORITHM_ID,
};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::rows::{AccountRecordRow, ContactListRow, ContactRequestRow};
use crate::auth::session::{
    bump_expiry, issue_session, lookup_session, revoke_session, touch_device_activity,
    DEFAULT_SESSION_LIFETIME_DAYS, SESSION_TOKEN_PREFIX,
};
use crate::avatars::assets::AVATAR_SOURCE_MAX_BYTES;
use crate::avatars::{
    apply_avatar_mutation, descriptor_from_parts, is_valid_avatar_seed, new_avatar_seed,
    parse_generated_avatar_marker, preserve_avatar_render_key, AvatarDescriptor,
    AvatarMutationError, AvatarMutationRequest, StoredAvatar, StoredAvatarRow,
    AVATAR_RENDERER_VERSION, HUMAN_AVATAR_STYLE,
};
use crate::server::ServerState;

mod app_invitation_handlers;
mod contact_acceptance;
mod contact_handlers;
mod contact_request_handlers;
mod device_handlers;
mod device_operation_support;
mod device_query_handlers;
mod device_types;
mod expressive_media;
mod group_invitation_handlers;
mod identity_handlers;
mod middleware;
mod oauth_avatar;
mod password_handlers;
mod presence_handlers;
mod profile_handlers;
mod session_forks;
mod session_pins;
mod session_visibility;
mod support;
mod types;

use app_invitation_handlers::*;
use contact_acceptance::*;
use contact_handlers::*;
use contact_request_handlers::*;
use device_handlers::*;
use device_query_handlers::*;
use device_types::*;
use expressive_media::*;
use group_invitation_handlers::*;
use identity_handlers::*;
use oauth_avatar::*;
use password_handlers::*;
use presence_handlers::*;
use profile_handlers::*;
use session_forks::{create_cloud_session_fork, list_cloud_session_forks};
use session_pins::*;
use session_visibility::*;
use support::*;
use types::ErrorBody;

pub use middleware::cloud_session_middleware;
pub(crate) use session_forks::cloud_session_participants;
pub use types::*;

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
        .route("/v1/cloud/auth/capabilities", get(auth_capabilities))
        .route("/v1/cloud/auth/signup", post(signup))
        .route("/v1/cloud/auth/login", post(login))
        .route(
            "/v1/cloud/invitations/app/resolve/:token",
            get(get_app_invitation),
        )
        .route(
            "/v1/cloud/invitations/groups/resolve/:token",
            get(get_group_invitation),
        )
        .route("/i/:token", get(app_invitation_landing))
        .route("/g/:token", get(group_invitation_landing))
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
        .route("/v1/cloud/auth/devices", get(list_devices))
        .route(
            "/v1/cloud/auth/devices/current",
            put(update_current_device_metadata),
        )
        .route(
            "/v1/cloud/auth/devices/revoke-others",
            post(revoke_other_devices),
        )
        .route(
            "/v1/cloud/auth/devices/:device_id",
            delete(revoke_device).patch(rename_device),
        )
        .route(
            "/v1/cloud/auth/devices/:device_id/confirm",
            post(confirm_device),
        )
        .route("/v1/cloud/accounts/:account_id/profile", get(get_profile))
        .route("/v1/cloud/invitations/app", post(create_app_invitation))
        .route(
            "/v1/cloud/invitations/app/:invitation_id",
            delete(revoke_app_invitation),
        )
        .route(
            "/v1/cloud/invitations/groups",
            post(create_group_invitation),
        )
        .route(
            "/v1/cloud/invitations/groups/accept/:token",
            post(accept_group_invitation),
        )
        .route(
            "/v1/cloud/invitations/groups/active/:group_space_id",
            get(list_active_group_invitations),
        )
        .route(
            "/v1/cloud/invitations/groups/:invitation_id",
            delete(revoke_group_invitation),
        )
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
            "/v1/cloud/presence/online",
            post(publish_current_device_online),
        )
        .route(
            "/v1/cloud/presence/heartbeat",
            post(publish_current_device_heartbeat),
        )
        .route(
            "/v1/cloud/presence/offline",
            post(publish_current_device_offline),
        )
        .route("/v1/cloud/presence/contacts", get(list_contact_presence))
        .route(
            "/v1/cloud/sessions/visibility",
            get(list_cloud_session_visibility),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id/hidden",
            put(hide_cloud_session).delete(unhide_cloud_session),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id/pinned",
            put(pin_cloud_session).delete(unpin_cloud_session),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id/muted",
            put(mute_cloud_session).delete(unmute_cloud_session),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id/unread",
            put(mark_cloud_session_unread).delete(unmark_cloud_session_unread),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id/pin",
            get(get_cloud_session_pin).put(update_cloud_session_pin),
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
            "/v1/cloud/avatar-assets",
            post(crate::avatars::assets::upload_avatar_asset)
                .layer::<_, Infallible>(ConcurrencyLimitLayer::new(4))
                .layer(DefaultBodyLimit::max(AVATAR_SOURCE_MAX_BYTES)),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/upload",
            axum::routing::put(crate::attachments::routes::upload),
        )
        .route(
            "/v1/cloud/attachments/multipart/initiate",
            post(crate::attachments::routes::multipart::initiate_multipart),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/multipart",
            get(crate::attachments::routes::multipart::multipart_status)
                .post(crate::attachments::routes::multipart::complete_multipart)
                .delete(crate::attachments::routes::multipart::cancel_multipart),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/parts/:part_number",
            put(crate::attachments::routes::multipart::upload_multipart_part)
                .layer::<_, Infallible>(ConcurrencyLimitLayer::new(16))
                .layer(DefaultBodyLimit::max(MULTIPART_CHUNK_SIZE)),
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
            "/v1/cloud/attachments/:attachment_id/preview",
            post(crate::attachments::routes::update_preview),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/playback",
            post(crate::attachments::playback::create),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/content",
            get(crate::attachments::content::content),
        )
        .route(
            "/v1/cloud/attachments/:attachment_id/preview-content",
            get(crate::attachments::routes::preview_content),
        )
        .route(
            "/v1/cloud/expressive-media",
            get(list_expressive_media).post(save_expressive_media),
        )
        .route(
            "/v1/cloud/expressive-media/:media_id",
            delete(delete_expressive_media),
        )
        .route(
            "/v1/cloud/sessions/:source_session_id/forks",
            get(list_cloud_session_forks).post(create_cloud_session_fork),
        )
        .layer(Extension(rate_limiter.clone()))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state);

    public.merge(protected)
}
