//! Routes the owner's Mac uses to claim, run, and end agent runs. They sit
//! behind the session middleware of the routes that merge them.

use std::sync::Arc;

use axum::routing::post;
use axum::Router;

use crate::cloud_agent_runtime::desktop;
use crate::server::ServerState;

pub(super) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v1/cloud/agent-runs/desktop/:run_id/cancel",
            post(desktop::cancel),
        )
        .route(
            "/v1/cloud/agent-runs/desktop/read-context",
            post(desktop::read_member_context),
        )
        .route("/v1/cloud/agent-runs/desktop/ready", post(desktop::ready))
        .route(
            "/v1/cloud/agent-runs/desktop/interrupted",
            post(desktop::interrupted),
        )
        .route("/v1/cloud/agent-runs/desktop/claim", post(desktop::claim))
        .route(
            "/v1/cloud/agent-runs/desktop/:run_id/renew",
            post(desktop::renew),
        )
        .route(
            "/v1/cloud/agent-runs/desktop/:run_id/admit",
            post(desktop::admit),
        )
        .route(
            "/v1/cloud/agent-runs/desktop/:run_id/release",
            post(desktop::release),
        )
        .route(
            "/v1/cloud/agent-runs/desktop/:run_id/progress",
            post(desktop::progress),
        )
        .route(
            "/v1/cloud/agent-runs/desktop/:run_id/context",
            post(desktop::read_context),
        )
        .route(
            "/v1/cloud/agent-runs/:run_id/desktop/provider-auth",
            post(desktop::provider_auth),
        )
}
