//! Usage routes for Settings: the limits that apply to the signed-in account
//! across its organizations, or to one organization, as
//! [`super::snapshot::UsageSnapshot`]s. Owners and admins of an organization
//! see counts and spend; everyone else sees percentages and reset times.
//! Pool-wide rows (`pool.runs`, `pool.spend`) and their pause times are shown
//! only to organizations that have their pool to themselves (see
//! [`has_pool_to_itself`]), so nobody sees another organization's usage.
//! Both routes run behind the cloud session middleware, and an organization
//! the caller does not belong to answers 404.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::snapshot::{self, Counter, Scoped, UsageSnapshot};
use super::{pauses, Feature, ResourcePool, ResourcePools};
use crate::auth::routes::CloudSession;
use crate::organizations::{OrganizationRole, PERSONAL_KIND};
use crate::server::ServerState;

const MAX_ID_LEN: usize = 128;

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/v1/cloud/account/usage", get(account_usage))
        .route(
            "/v1/cloud/organizations/:organization_id/usage",
            get(organization_usage),
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
    error(
        "organization_not_found",
        "Organization not found.",
        StatusCode::NOT_FOUND,
    )
}

fn server_error() -> Response {
    error(
        "server_error",
        "Could not load usage.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn pools(state: &ServerState) -> Option<Arc<ResourcePools>> {
    state
        .system_agent()
        .map(|service| service.config().resource_pools())
}

/// One organization the caller belongs to, as Settings lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationUsage {
    pub organization_id: String,
    pub name: String,
    pub kind: String,
    pub role: Option<OrganizationRole>,
    pub snapshots: Vec<UsageSnapshot>,
}

type MembershipRow = (String, String, String, String);

const MEMBERSHIP_SELECT: &str = "SELECT o.organization_id, o.name, o.kind, m.role
     FROM cloud_organization_members m
     JOIN cloud_organizations o ON o.organization_id = m.organization_id
     WHERE m.account_id = $1 AND (m.expires_at IS NULL OR m.expires_at > now())";

/// Whether `organization_id` is the only organization whose work its pool
/// counts: it is bound to the pool explicitly, no other organization is, and
/// the pool is not the default pool that every unbound organization (every
/// personal organization among them) falls back to. Only then are the pool's
/// runs, spend and pause times its own.
pub fn has_pool_to_itself(pools: &ResourcePools, organization_id: &str) -> bool {
    let Some(&index) = pools.bindings.get(organization_id) else {
        return false;
    };
    index != pools.default_index
        && pools
            .bindings
            .iter()
            .all(|(other, &bound)| bound != index || other == organization_id)
}

/// Every snapshot that applies to `account_id` in one organization: the
/// pool's caps (pool-wide rows only when it has the pool to itself), the
/// busiest of the caller's conversations against the per-conversation cap,
/// and in a personal organization the caller's Grounding cap. Filtered for
/// the caller's role.
pub async fn organization_snapshots(
    db: &PgPool,
    pools: &ResourcePools,
    account_id: &str,
    organization_id: &str,
    kind: &str,
    role: Option<OrganizationRole>,
    now: DateTime<Utc>,
) -> sqlx_core::Result<Vec<UsageSnapshot>> {
    let pool = pools.resolve(Some(organization_id));
    let day = now.date_naive();
    let limits = pool.limits();
    let mut scoped = Vec::new();
    if limits.system_agent_runs_per_conversation.is_some() {
        let busiest =
            snapshot::busiest_conversation(db, pool.id(), day, organization_id, account_id).await?;
        let (conversation_id, counter) = match busiest {
            Some((id, counter)) => (Some(id), counter),
            None => (None, Counter::default()),
        };
        scoped.push(Scoped {
            feature: Feature::SystemAgent,
            counter,
            conversation_id,
        });
    }
    if kind == PERSONAL_KIND && limits.grounding_runs_per_person.is_some() {
        let counter =
            snapshot::counter(db, pool.id(), day, Some(Feature::Grounding), account_id).await?;
        scoped.push(Scoped {
            feature: Feature::Grounding,
            counter,
            conversation_id: None,
        });
    }
    let pool_wide = has_pool_to_itself(pools, organization_id);
    let mut snapshots = build(db, pool, &scoped, pool_wide, now).await?;
    pauses::attach(db, pool.id(), day, pool_wide, &mut snapshots).await?;
    Ok(snapshot::for_role(snapshots, role))
}

async fn build(
    db: &PgPool,
    pool: &ResourcePool,
    scoped: &[Scoped],
    pool_wide: bool,
    now: DateTime<Utc>,
) -> sqlx_core::Result<Vec<UsageSnapshot>> {
    if !pool_wide {
        return Ok(snapshot::build_without_pool(pool, scoped, now));
    }
    let pool_counter = snapshot::counter(db, pool.id(), now.date_naive(), None, "").await?;
    Ok(snapshot::build(pool, scoped, pool_counter, now))
}

async fn account_usage(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let db = state.db_pool();
    let sql = format!(
        "{MEMBERSHIP_SELECT} ORDER BY (o.kind = 'personal') DESC, o.created_at, o.organization_id"
    );
    let rows: Vec<MembershipRow> =
        match query_as(&sql).bind(&session.account_id).fetch_all(db).await {
            Ok(rows) => rows,
            Err(_) => return server_error(),
        };
    let now = Utc::now();
    let mut organizations = Vec::with_capacity(rows.len());
    for (organization_id, name, kind, role) in rows {
        let role = OrganizationRole::parse(&role);
        let snapshots = match pools(&state) {
            Some(pools) => match organization_snapshots(
                db,
                &pools,
                &session.account_id,
                &organization_id,
                &kind,
                role,
                now,
            )
            .await
            {
                Ok(snapshots) => snapshots,
                Err(_) => return server_error(),
            },
            None => Vec::new(),
        };
        organizations.push(OrganizationUsage {
            organization_id,
            name,
            kind,
            role,
            snapshots,
        });
    }
    Json(json!({ "organizations": organizations })).into_response()
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
    let sql = format!("{MEMBERSHIP_SELECT} AND o.organization_id = $2");
    let row: Option<MembershipRow> = match query_as(&sql)
        .bind(&session.account_id)
        .bind(&organization_id)
        .fetch_optional(db)
        .await
    {
        Ok(row) => row,
        Err(_) => return server_error(),
    };
    let Some((organization_id, _, kind, role)) = row else {
        return not_found();
    };
    let role = OrganizationRole::parse(&role);
    let snapshots = match pools(&state) {
        Some(pools) => match organization_snapshots(
            db,
            &pools,
            &session.account_id,
            &organization_id,
            &kind,
            role,
            Utc::now(),
        )
        .await
        {
            Ok(snapshots) => snapshots,
            Err(_) => return server_error(),
        },
        None => Vec::new(),
    };
    Json(json!({
        "organizationId": organization_id,
        "role": role,
        "snapshots": snapshots,
    }))
    .into_response()
}

#[cfg(test)]
#[path = "routes_tests.rs"]
mod tests;
