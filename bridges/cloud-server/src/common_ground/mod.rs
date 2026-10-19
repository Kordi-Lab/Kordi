//! Common ground (#1847): interest cards, event rooms joined with a 4-digit
//! code, and one-to-one pairings.
//!
//! A card is built by a background run on the Kordi-operated key (PiP's
//! service credential) from the sources the owner turns on. Every topic
//! cites redacted, dated evidence that only the owner sees. Others see a
//! card's topics, minus hidden ones, only while they share an open room or a
//! pairing with its owner and the owner shares the card.

mod build;
mod card;
mod pairing;
mod people;
mod profile;
mod prompt;
mod redact;
mod rooms;

#[cfg(test)]
mod tests;

use std::sync::Arc;
use std::time::Duration;

use axum::{
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use serde_json::{json, Value};
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

use crate::auth::rate_limit::{AccountActionLimit, CloudRateLimiter};
use crate::{auth::routes::cloud_session_middleware, server::ServerState};

pub use build::{complete, fail};

/// Advertised as `commonGroundVersion` in the auth capabilities.
pub const COMMON_GROUND_VERSION: u32 = 1;
/// Card build runs.
pub const RUN_PREFIX: &str = "cgcard_";

/// A room is open until 24 hours after its last join.
pub(super) const ROOM_OPEN_SQL: &str =
    "room.closed_at IS NULL AND room.last_join_at > now() - interval '24 hours'";

pub(super) const BUILD_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "common-ground-card-build",
    limit: 6,
    window: Duration::from_secs(60 * 60),
};
pub(super) const ROOM_JOIN_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "common-ground-room-join",
    limit: 10,
    window: Duration::from_secs(60),
};
pub(super) const ROOM_IP_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "common-ground-room-join-address",
    limit: 60,
    window: Duration::from_secs(60),
};
pub(super) const PAIR_CODE_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "common-ground-pair-code",
    limit: 20,
    window: Duration::from_secs(60),
};
pub(super) const PAIR_REDEEM_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "common-ground-pair-redeem",
    limit: 10,
    window: Duration::from_secs(60),
};
pub(super) const PAIR_IP_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "common-ground-pair-redeem-address",
    limit: 60,
    window: Duration::from_secs(60),
};

/// Common ground needs the Kordi-operated credential for card builds.
pub fn available(state: &ServerState) -> bool {
    state.pip().is_some()
}

pub fn routes(state: Arc<ServerState>, rate_limiter: Arc<CloudRateLimiter>) -> Router {
    Router::new()
        .route(
            "/v1/cloud/common-ground/card",
            get(card::read)
                .put(card::update_topics)
                .delete(card::delete),
        )
        .route("/v1/cloud/common-ground/card/build", post(build::start))
        .route(
            "/v1/cloud/common-ground/card/hidden",
            put(card::update_hidden),
        )
        .route(
            "/v1/cloud/common-ground/settings",
            put(card::update_settings),
        )
        .route("/v1/cloud/common-ground/rooms/:code", get(rooms::read))
        .route(
            "/v1/cloud/common-ground/rooms/:code/join",
            post(rooms::join),
        )
        .route(
            "/v1/cloud/common-ground/rooms/:code/leave",
            post(rooms::leave),
        )
        .route("/v1/cloud/common-ground/pairings", get(pairing::list))
        .route(
            "/v1/cloud/common-ground/pairings/code",
            post(pairing::create),
        )
        .route(
            "/v1/cloud/common-ground/pairings/redeem",
            post(pairing::redeem),
        )
        .route(
            "/v1/cloud/common-ground/people/:account_id",
            get(people::read),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .layer(Extension(rate_limiter))
        .with_state(state)
}

pub(super) fn err(code: &str, message: &str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({ "errorCode": code, "message": message })),
    )
        .into_response()
}

pub(super) fn db_error(error: sqlx_core::Error) -> Response {
    eprintln!("[common-ground] Database error: {error}");
    err(
        "common_ground_failed",
        "Something went wrong. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

pub(super) fn unavailable() -> Response {
    err(
        "common_ground_unavailable",
        "Common ground isn't available on this server.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

pub(super) fn sharing_off() -> Response {
    err(
        "common_ground_sharing_off",
        "Turn on sharing to meet people.",
        StatusCode::CONFLICT,
    )
}

pub(super) fn limited(retry_after: Duration) -> Response {
    let mut response = err(
        "rate_limited",
        "Try again in a minute.",
        StatusCode::TOO_MANY_REQUESTS,
    );
    if let Ok(value) = retry_after.as_secs().max(1).to_string().parse() {
        response.headers_mut().insert("Retry-After", value);
    }
    response
}

/// An account-private refresh hint over the realtime connection.
pub(super) async fn hint(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
    event_type: &str,
    payload: Value,
) -> sqlx_core::Result<()> {
    crate::chat_sync::store::append_account_hint(tx, account, event_type, &payload)
        .await
        .map_err(|_| sqlx_core::Error::Protocol("Could not publish a Common ground update.".into()))
}
