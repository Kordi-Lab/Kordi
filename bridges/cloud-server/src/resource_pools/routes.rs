//! Usage routes: the limits that apply to an organization or a conversation,
//! as [`super::snapshot::UsageSnapshot`]s. Owners and admins of the
//! organization see counts and spend; everyone else sees percentages and
//! reset times. Both routes run behind the cloud session middleware, and an
//! organization or conversation the caller does not belong to answers 404.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_core::query_scalar::query_scalar;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::notices;
use super::snapshot::{self, sees_amounts};
use super::{Feature, ResourcePools};
use crate::auth::routes::CloudSession;
use crate::organizations::{OrganizationRole, PERSONAL_KIND};
use crate::server::ServerState;

const MAX_ID_LEN: usize = 128;

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v1/cloud/organizations/:organization_id/usage",
            get(organization_usage),
        )
        .route(
            "/v1/cloud/conversations/:conversation_id/usage",
            get(conversation_usage),
        )
}

fn error(code: &'static str, message: &'static str, status: StatusCode) -> Response {
    (
        status,
        Json(json!({ "errorCode": code, "message": message })),
    )
        .into_response()
}

fn not_found() -> Response {
    error("not_found", "Not found.", StatusCode::NOT_FOUND)
}

fn server_error() -> Response {
    error(
        "server_error",
        "Could not load usage.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn pools(state: &ServerState) -> Option<&ResourcePools> {
    state
        .system_agent()
        .map(|service| service.config().resource_pools())
}

/// The caller's role in `organization_id`, or `None` outside it.
async fn role_in(
    db: &PgPool,
    account_id: &str,
    organization_id: &str,
) -> sqlx_core::Result<Option<OrganizationRole>> {
    let role: Option<String> = query_scalar(
        "SELECT role FROM cloud_organization_members
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(organization_id)
    .bind(account_id)
    .fetch_optional(db)
    .await?;
    Ok(role.as_deref().and_then(OrganizationRole::parse))
}

async fn organization_usage(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
) -> Response {
    if organization_id.is_empty() || organization_id.len() > MAX_ID_LEN {
        return not_found();
    }
    let db = state.db_pool();
    let row: Option<(String, String)> = match query_as(
        "SELECT o.kind, m.role FROM cloud_organizations o
         JOIN cloud_organization_members m ON m.organization_id = o.organization_id
         WHERE o.organization_id = $1 AND m.account_id = $2",
    )
    .bind(&organization_id)
    .bind(&session.account_id)
    .fetch_optional(db)
    .await
    {
        Ok(row) => row,
        Err(_) => return server_error(),
    };
    let Some((kind, role)) = row else {
        return not_found();
    };
    let role = OrganizationRole::parse(&role);
    let now = Utc::now();
    let mut snapshots = Vec::new();
    if let Some(pools) = pools(&state) {
        let pool = pools.resolve(Some(&organization_id));
        // Grounding is counted per person in their personal organization.
        let scope =
            (kind == PERSONAL_KIND).then_some((Feature::Grounding, session.account_id.as_str()));
        snapshots = match snapshot::load(db, pool, scope, now).await {
            Ok(snapshots) => snapshots,
            Err(_) => return server_error(),
        };
    }
    let notices = if sees_amounts(role) {
        match notices::thresholds_on(db, &organization_id, now.date_naive()).await {
            Ok(notices) => notices,
            Err(_) => return server_error(),
        }
    } else {
        Vec::new()
    };
    Json(json!({
        "organizationId": organization_id,
        "role": role,
        "snapshots": snapshot::for_role(snapshots, role),
        "notices": notices,
    }))
    .into_response()
}

async fn conversation_usage(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(conversation_id): Path<String>,
) -> Response {
    let Ok(conversation_id) = Uuid::parse_str(&conversation_id) else {
        return not_found();
    };
    let db = state.db_pool();
    let organization: Option<Option<String>> = match query_scalar(
        "SELECT c.organization_id FROM cloud_chat_conversations c
         JOIN cloud_chat_conversation_members m ON m.conversation_id = c.conversation_id
         WHERE c.conversation_id = $1 AND m.account_id = $2 AND m.membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(&session.account_id)
    .fetch_optional(db)
    .await
    {
        Ok(row) => row,
        Err(_) => return server_error(),
    };
    let Some(organization_id) = organization else {
        return not_found();
    };
    let role = match organization_id.as_deref() {
        Some(id) => match role_in(db, &session.account_id, id).await {
            Ok(role) => role,
            Err(_) => return server_error(),
        },
        None => None,
    };
    let now = Utc::now();
    let mut snapshots = Vec::new();
    if let Some(pools) = pools(&state) {
        let pool = pools.resolve(organization_id.as_deref());
        let scope = conversation_id.to_string();
        snapshots = match snapshot::load(db, pool, Some((Feature::SystemAgent, &scope)), now).await
        {
            Ok(snapshots) => snapshots,
            Err(_) => return server_error(),
        };
    }
    let paused = match notices::paused_on(db, conversation_id, now.date_naive()).await {
        Ok(paused) => paused,
        Err(_) => return server_error(),
    };
    Json(json!({
        "organizationId": organization_id,
        "role": role,
        "snapshots": snapshot::for_role(snapshots, role),
        "paused": paused,
    }))
    .into_response()
}
