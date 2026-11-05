//! Organization routes. Mutations lock the organization row first, so
//! concurrent changes to one organization run one at a time and the owner
//! count they check cannot go stale.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::policy::{check_membership_change, MembershipChange, OrganizationRole};
use super::{err, not_found, server_error, ApiError, OrganizationMember, OrganizationSummary};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

const MAX_ID_LEN: usize = 128;
const MEMBER_PAGE_SIZE: i64 = 200;

type Tx<'a> = sqlx_core::transaction::Transaction<'a, Postgres>;
type SummaryRow = (String, String, String, String, i64, DateTime<Utc>);
type MemberRow = (String, Option<String>, String, DateTime<Utc>);

const SUMMARY_SELECT: &str = "SELECT o.organization_id, o.name, o.kind, m.role, \
        (SELECT count(*) FROM cloud_organization_members c \
         WHERE c.organization_id = o.organization_id), \
        o.created_at \
     FROM cloud_organization_members m \
     JOIN cloud_organizations o ON o.organization_id = m.organization_id \
     WHERE m.account_id = $1";

fn summary(row: SummaryRow) -> Option<OrganizationSummary> {
    let (organization_id, name, kind, role, member_count, created_at) = row;
    Some(OrganizationSummary {
        organization_id,
        name,
        kind,
        role: OrganizationRole::parse(&role)?,
        member_count,
        created_at: created_at.to_rfc3339(),
    })
}

fn member(row: MemberRow) -> Option<OrganizationMember> {
    let (account_id, display_name, role, joined_at) = row;
    Some(OrganizationMember {
        account_id,
        display_name,
        role: OrganizationRole::parse(&role)?,
        joined_at: joined_at.to_rfc3339(),
    })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_LEN
}

pub(super) async fn list_organizations(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match organizations_for(state.db_pool(), &session.account_id).await {
        Ok(organizations) => Json(json!({ "organizations": organizations })).into_response(),
        Err(error) => error.into_response(),
    }
}

/// The organizations `account_id` belongs to, personal first.
pub(super) async fn organizations_for(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<OrganizationSummary>, ApiError> {
    let sql = format!(
        "{SUMMARY_SELECT} ORDER BY (o.kind = 'personal') DESC, o.created_at, o.organization_id"
    );
    let rows: Vec<SummaryRow> = query_as(&sql)
        .bind(account_id)
        .fetch_all(pool)
        .await
        .map_err(|_| server_error())?;
    Ok(rows.into_iter().filter_map(summary).collect())
}

pub(super) async fn get_organization(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
) -> Response {
    match member_summary(state.db_pool(), &session.account_id, &organization_id).await {
        Ok(Some(organization)) => Json(json!({ "organization": organization })).into_response(),
        Ok(None) => not_found().into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn member_summary(
    pool: &PgPool,
    account_id: &str,
    organization_id: &str,
) -> Result<Option<OrganizationSummary>, ApiError> {
    if !valid_id(organization_id) {
        return Ok(None);
    }
    let sql = format!("{SUMMARY_SELECT} AND o.organization_id = $2");
    let row: Option<SummaryRow> = query_as(&sql)
        .bind(account_id)
        .bind(organization_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| server_error())?;
    Ok(row.and_then(summary))
}

#[derive(Debug, Deserialize)]
pub(super) struct MemberPageQuery {
    after: Option<String>,
}

pub(super) async fn list_members(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
    Query(page): Query<MemberPageQuery>,
) -> Response {
    let pool = state.db_pool();
    match member_summary(pool, &session.account_id, &organization_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return not_found().into_response(),
        Err(error) => return error.into_response(),
    }
    let rows: Vec<MemberRow> = match query_as(
        "SELECT m.account_id, a.display_name, m.role, m.joined_at \
         FROM cloud_organization_members m \
         JOIN cloud_accounts a ON a.account_id = m.account_id \
         WHERE m.organization_id = $1 AND ($2::text IS NULL OR m.account_id > $2) \
         ORDER BY m.account_id LIMIT $3",
    )
    .bind(&organization_id)
    .bind(page.after.as_deref())
    .bind(MEMBER_PAGE_SIZE + 1)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(_) => return server_error().into_response(),
    };
    let mut members: Vec<_> = rows.into_iter().filter_map(member).collect();
    let next_after = if members.len() as i64 > MEMBER_PAGE_SIZE {
        members.truncate(MEMBER_PAGE_SIZE as usize);
        members.last().map(|m| m.account_id.clone())
    } else {
        None
    };
    Json(json!({ "members": members, "nextAfter": next_after })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AddMemberRequest {
    account_id: String,
    role: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateMemberRequest {
    role: String,
}

fn parse_role(value: &str) -> Result<OrganizationRole, ApiError> {
    OrganizationRole::parse(value).ok_or_else(|| {
        err(
            "invalid_role",
            "role must be owner, admin, or member.",
            StatusCode::BAD_REQUEST,
        )
    })
}

/// Locks the organization and returns its kind, the caller's role, and
/// whether the admission file defines it. Organizations the caller does not
/// belong to are not found.
async fn lock_for_change(
    tx: &mut Tx<'_>,
    organization_id: &str,
    actor_account_id: &str,
) -> Result<(String, OrganizationRole, bool), ApiError> {
    if !valid_id(organization_id) {
        return Err(not_found());
    }
    let row: Option<(String, Option<String>, bool)> = query_as(
        "SELECT o.kind, m.role, o.config_id IS NOT NULL FROM cloud_organizations o \
         LEFT JOIN cloud_organization_members m \
           ON m.organization_id = o.organization_id AND m.account_id = $2 \
         WHERE o.organization_id = $1 FOR UPDATE OF o",
    )
    .bind(organization_id)
    .bind(actor_account_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| server_error())?;
    match row {
        Some((kind, Some(role), configured)) => Ok((
            kind,
            OrganizationRole::parse(&role).ok_or_else(server_error)?,
            configured,
        )),
        _ => Err(not_found()),
    }
}

/// Members of an organization from the admission file join through its
/// admission rules, so the generic API cannot add them or change roles.
fn configured_refusal() -> ApiError {
    err(
        "configured_organization",
        "Members of this organization join through its admission rules.",
        StatusCode::CONFLICT,
    )
}

async fn owner_count(tx: &mut Tx<'_>, organization_id: &str) -> Result<i64, ApiError> {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_organization_members \
         WHERE organization_id = $1 AND role = 'owner'",
    )
    .bind(organization_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| server_error())?;
    Ok(count)
}

async fn target_role(
    tx: &mut Tx<'_>,
    organization_id: &str,
    account_id: &str,
) -> Result<OrganizationRole, ApiError> {
    let row: Option<(String,)> = query_as(
        "SELECT role FROM cloud_organization_members \
         WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(organization_id)
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| server_error())?;
    match row {
        Some((role,)) => OrganizationRole::parse(&role).ok_or_else(server_error),
        None => Err(err(
            "member_not_found",
            "That account is not a member of this organization.",
            StatusCode::NOT_FOUND,
        )),
    }
}

async fn fetch_member(
    tx: &mut Tx<'_>,
    organization_id: &str,
    account_id: &str,
) -> Result<OrganizationMember, ApiError> {
    let row: MemberRow = query_as(
        "SELECT m.account_id, a.display_name, m.role, m.joined_at \
         FROM cloud_organization_members m \
         JOIN cloud_accounts a ON a.account_id = m.account_id \
         WHERE m.organization_id = $1 AND m.account_id = $2",
    )
    .bind(organization_id)
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| server_error())?;
    member(row).ok_or_else(server_error)
}

fn check(
    kind: &str,
    actor: OrganizationRole,
    change: MembershipChange,
    owners: i64,
) -> Result<(), ApiError> {
    check_membership_change(kind, actor, change, owners).map_err(ApiError::from)
}

pub(super) async fn add_member(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
    Json(request): Json<AddMemberRequest>,
) -> Response {
    let result: Result<OrganizationMember, ApiError> = async {
        let role = parse_role(&request.role)?;
        let account_id = request.account_id.trim();
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let (kind, actor, configured) =
            lock_for_change(&mut tx, &organization_id, &session.account_id).await?;
        let owners = owner_count(&mut tx, &organization_id).await?;
        check(&kind, actor, MembershipChange::Add { role }, owners)?;
        if configured {
            return Err(configured_refusal());
        }
        let exists: Option<(String,)> =
            query_as("SELECT account_id FROM cloud_accounts WHERE account_id = $1")
                .bind(account_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|_| server_error())?;
        if !valid_id(account_id) || exists.is_none() {
            return Err(err(
                "account_not_found",
                "Account not found.",
                StatusCode::NOT_FOUND,
            ));
        }
        let inserted = query(
            "INSERT INTO cloud_organization_members (organization_id, account_id, role) \
             VALUES ($1, $2, $3) ON CONFLICT (organization_id, account_id) DO NOTHING",
        )
        .bind(&organization_id)
        .bind(account_id)
        .bind(role.as_str())
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        if inserted.rows_affected() == 0 {
            return Err(err(
                "already_member",
                "That account is already a member.",
                StatusCode::CONFLICT,
            ));
        }
        let member = fetch_member(&mut tx, &organization_id, account_id).await?;
        tx.commit().await.map_err(|_| server_error())?;
        Ok(member)
    }
    .await;
    match result {
        Ok(member) => (StatusCode::CREATED, Json(json!({ "member": member }))).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn update_member(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((organization_id, account_id)): Path<(String, String)>,
    Json(request): Json<UpdateMemberRequest>,
) -> Response {
    let result: Result<OrganizationMember, ApiError> = async {
        let to = parse_role(&request.role)?;
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let (kind, actor, configured) =
            lock_for_change(&mut tx, &organization_id, &session.account_id).await?;
        let from = target_role(&mut tx, &organization_id, &account_id).await?;
        let owners = owner_count(&mut tx, &organization_id).await?;
        check(
            &kind,
            actor,
            MembershipChange::ChangeRole { from, to },
            owners,
        )?;
        if configured {
            return Err(configured_refusal());
        }
        query(
            "UPDATE cloud_organization_members SET role = $3 \
             WHERE organization_id = $1 AND account_id = $2",
        )
        .bind(&organization_id)
        .bind(&account_id)
        .bind(to.as_str())
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        let member = fetch_member(&mut tx, &organization_id, &account_id).await?;
        tx.commit().await.map_err(|_| server_error())?;
        Ok(member)
    }
    .await;
    match result {
        Ok(member) => Json(json!({ "member": member })).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn remove_member(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((organization_id, account_id)): Path<(String, String)>,
) -> Response {
    let result: Result<(), ApiError> = async {
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let (kind, actor, configured) =
            lock_for_change(&mut tx, &organization_id, &session.account_id).await?;
        let role = target_role(&mut tx, &organization_id, &account_id).await?;
        let owners = owner_count(&mut tx, &organization_id).await?;
        check(&kind, actor, MembershipChange::Remove { role }, owners)?;
        if configured {
            super::admission::store::remove_admitted_member(&mut tx, &organization_id, &account_id)
                .await?;
            tx.commit().await.map_err(|_| server_error())?;
            return Ok(());
        }
        query(
            "DELETE FROM cloud_organization_members \
             WHERE organization_id = $1 AND account_id = $2",
        )
        .bind(&organization_id)
        .bind(&account_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        tx.commit().await.map_err(|_| server_error())?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.into_response(),
    }
}
