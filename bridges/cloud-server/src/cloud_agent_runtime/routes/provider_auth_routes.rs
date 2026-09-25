//! Session-authenticated provider-auth routes: saved snapshots, route tests,
//! key validation, and interactive provider logins. The public provider
//! catalog stays with the other unauthenticated routes.

use std::sync::Arc;

use axum::routing::{delete, get, post};
use axum::Router;

use super::auth_snapshots::{
    current_provider_auth_snapshot, list_provider_auth_snapshots, publish_provider_auth_snapshot,
    revoke_provider_auth_snapshot,
};
use super::test_route::{test_provider_route, validate_provider_key};
use crate::auth::routes::cloud_session_middleware;
use crate::cloud_agent_runtime::provider_login;
use crate::server::ServerState;

pub(super) fn routes(state: Arc<ServerState>) -> Router {
    provider_login::mount(Router::new())
        .route(
            "/v1/cloud/agent-provider-auth/snapshots",
            get(list_provider_auth_snapshots).post(publish_provider_auth_snapshot),
        )
        .route(
            "/v1/cloud/agent-provider-auth/snapshots/current",
            get(current_provider_auth_snapshot),
        )
        .route(
            "/v1/cloud/agent-provider-auth/snapshots/:snapshot_id",
            delete(revoke_provider_auth_snapshot),
        )
        .route(
            "/v1/cloud/agent-provider-auth/test-route",
            post(test_provider_route),
        )
        .route(
            "/v1/cloud/agent-provider-auth/validate-key",
            post(validate_provider_key),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}
