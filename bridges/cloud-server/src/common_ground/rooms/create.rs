//! Create a code: the server picks a four-digit code with no open room and
//! opens the room there, so nobody walks into someone else's room by
//! guessing a code.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use rand::Rng;

use super::{
    check_limits, enter, joining_profile, room_full, room_name, room_request, view::view, Entered,
    JoinRequest,
};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::{db_error, err};
use crate::{auth::routes::CloudSession, server::ServerState};

/// Random codes tried before giving up.
const ATTEMPTS: usize = 8;

fn random_code() -> String {
    format!("{:04}", rand::thread_rng().gen_range(0..10_000))
}

/// `POST /v1/cloud/common-ground/rooms`: opens a room on a free code, named
/// by the creator, who shares the chosen profile there. Answers `201` with
/// the lobby, which carries the code.
pub(in crate::common_ground) async fn create(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    body: Option<Json<JoinRequest>>,
) -> Response {
    let account = session.account_id.as_str();
    if let Some(response) = check_limits(&rate_limiter, account, connect_info, &headers).await {
        return response;
    }
    let pool = state.db_pool();
    let body = match room_request(body) {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let name = room_name(&body.name);
    if name.is_empty() {
        return err(
            "common_ground_room_name_required",
            "Name the meetup.",
            StatusCode::BAD_REQUEST,
        );
    }
    let profile = match joining_profile(pool, None, account, &body).await {
        Ok(profile) => profile,
        Err(response) => return *response,
    };
    for _ in 0..ATTEMPTS {
        let code = random_code();
        match enter(pool, &code, account, &body, &profile, &name, true).await {
            Ok(Entered::Room(room_id)) => {
                return match view(pool, room_id, account).await {
                    Ok(view) => (StatusCode::CREATED, Json(view)).into_response(),
                    Err(error) => db_error(error),
                };
            }
            Ok(Entered::Taken) => continue,
            // A new room has no other members.
            Ok(Entered::Full) => return room_full(),
            Err(error) => return db_error(error),
        }
    }
    err(
        "common_ground_no_free_code",
        "No free code right now. Try again.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}
