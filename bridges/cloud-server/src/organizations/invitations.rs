//! Joining a team takes the invitee's consent: an owner or admin invites an
//! account, and the account becomes a member only when it accepts.
//!
//! Inviting an account that does not exist, a server-managed account, or a
//! current member gets one generic answer, so the route cannot be used to
//! learn which accounts exist. An invitation may carry a membership end
//! date; owners never expire. Invitations lapse after [`INVITATION_DAYS`],
//! and one can be accepted only while its inviter could still send it.
//! Organizations from the admission file take no invitations.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::handlers::{
    check, configured_refusal, lock_for_change, member_summary, owner_count, parse_role, valid_id,
};
use super::policy::{manages_content, MembershipChange, OrganizationRole, PolicyError};
use super::{bad_request, err, server_error, ApiError};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

pub const INVITATION_DAYS: i64 = 14;

const INVITATION_SELECT: &str = "SELECT i.invitation_id, i.organization_id, o.name, \
        i.invitee_account_id, i.role, i.membership_expires_at, i.invited_by_account_id, \
        inviter.display_name, i.created_at, i.expires_at \
     FROM cloud_organization_invitations i \
     JOIN cloud_organizations o ON o.organization_id = i.organization_id \
     LEFT JOIN cloud_accounts inviter ON inviter.account_id = i.invited_by_account_id \
     WHERE i.status = 'pending' AND i.expires_at > now()";

type InvitationRow = (
    String,
    String,
    String,
    String,
    String,
    Option<DateTime<Utc>>,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
    DateTime<Utc>,
);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationInvitation {
    pub invitation_id: String,
    pub organization_id: String,
    pub organization_name: String,
    pub invitee_account_id: String,
    pub role: OrganizationRole,
    pub membership_expires_at: Option<String>,
    pub invited_by_account_id: Option<String>,
    pub invited_by_display_name: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}

fn invitation(row: InvitationRow) -> Option<OrganizationInvitation> {
    Some(OrganizationInvitation {
        invitation_id: row.0,
        organization_id: row.1,
        organization_name: row.2,
        invitee_account_id: row.3,
        role: OrganizationRole::parse(&row.4)?,
        membership_expires_at: row.5.map(|at| at.to_rfc3339()),
        invited_by_account_id: row.6,
        invited_by_display_name: row.7,
        created_at: row.8.to_rfc3339(),
        expires_at: row.9.to_rfc3339(),
    })
}

fn unavailable() -> ApiError {
    err(
        "invitee_unavailable",
        "That account cannot be invited.",
        StatusCode::NOT_FOUND,
    )
}

fn invitation_not_found() -> ApiError {
    err(
        "invitation_not_found",
        "Invitation not found.",
        StatusCode::NOT_FOUND,
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InviteRequest {
    account_id: String,
    role: String,
    membership_expires_at: Option<DateTime<Utc>>,
}

pub(super) async fn invite(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
    Json(request): Json<InviteRequest>,
) -> Response {
    let result: Result<OrganizationInvitation, ApiError> = async {
        let role = parse_role(&request.role)?;
        let ends = request.membership_expires_at;
        if ends.is_some_and(|at| at <= Utc::now()) {
            return Err(bad_request(
                "invalid_expiry",
                "membershipExpiresAt must be in the future.",
            ));
        }
        if ends.is_some() && role == OrganizationRole::Owner {
            return Err(bad_request(
                "invalid_expiry",
                "An owner's membership cannot expire.",
            ));
        }
        let invitee = request.account_id.trim();
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let (kind, actor, configured) =
            lock_for_change(&mut tx, &organization_id, &session.account_id).await?;
        let owners = owner_count(&mut tx, &organization_id).await?;
        check(&kind, actor, MembershipChange::Add { role }, owners)?;
        if configured {
            return Err(configured_refusal());
        }
        if !valid_id(invitee) || crate::system_account::is_service_account(invitee) {
            return Err(unavailable());
        }
        let (exists, member): (bool, bool) = query_as(
            "SELECT EXISTS (SELECT 1 FROM cloud_accounts WHERE account_id = $2), \
                    cloud_is_organization_member($1, $2)",
        )
        .bind(&organization_id)
        .bind(invitee)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        if !exists || member {
            return Err(unavailable());
        }
        let expires_at = Utc::now() + Duration::days(INVITATION_DAYS);
        let (invitation_id,): (String,) = query_as(
            "INSERT INTO cloud_organization_invitations \
                 (invitation_id, organization_id, invitee_account_id, invited_by_account_id, \
                  role, membership_expires_at, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             ON CONFLICT (organization_id, invitee_account_id) WHERE status = 'pending' \
             DO UPDATE SET invited_by_account_id = EXCLUDED.invited_by_account_id, \
                 role = EXCLUDED.role, membership_expires_at = EXCLUDED.membership_expires_at, \
                 expires_at = EXCLUDED.expires_at \
             RETURNING invitation_id",
        )
        .bind(format!("oinv_{}", Uuid::new_v4().simple()))
        .bind(&organization_id)
        .bind(invitee)
        .bind(&session.account_id)
        .bind(role.as_str())
        .bind(ends)
        .bind(expires_at)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        let sql = format!("{INVITATION_SELECT} AND i.invitation_id = $1");
        let row: InvitationRow = query_as(&sql)
            .bind(&invitation_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(|_| server_error())?;
        tx.commit().await.map_err(|_| server_error())?;
        invitation(row).ok_or_else(server_error)
    }
    .await;
    match result {
        Ok(invitation) => (
            StatusCode::CREATED,
            Json(json!({ "invitation": invitation })),
        )
            .into_response(),
        Err(error) => error.into_response(),
    }
}

async fn pending(
    state: &ServerState,
    filter: &str,
    id: &str,
) -> Result<Vec<OrganizationInvitation>, ApiError> {
    let sql =
        format!("{INVITATION_SELECT} AND {filter} = $1 ORDER BY i.created_at, i.invitation_id");
    let rows: Vec<InvitationRow> = query_as(&sql)
        .bind(id)
        .fetch_all(state.db_pool())
        .await
        .map_err(|_| server_error())?;
    Ok(rows.into_iter().filter_map(invitation).collect())
}

/// Pending invitations of one team, for its owners and admins.
pub(super) async fn list_for_organization(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
) -> Response {
    let result: Result<Vec<OrganizationInvitation>, ApiError> = async {
        let summary = member_summary(state.db_pool(), &session.account_id, &organization_id)
            .await?
            .ok_or_else(super::not_found)?;
        if !manages_content(summary.role) {
            return Err(PolicyError::NotManager.into());
        }
        pending(&state, "i.organization_id", &organization_id).await
    }
    .await;
    match result {
        Ok(invitations) => Json(json!({ "invitations": invitations })).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn revoke(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((organization_id, invitation_id)): Path<(String, String)>,
) -> Response {
    let result: Result<(), ApiError> = async {
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let (_, actor, _) = lock_for_change(&mut tx, &organization_id, &session.account_id).await?;
        if !manages_content(actor) {
            return Err(PolicyError::NotManager.into());
        }
        let revoked = query(
            "UPDATE cloud_organization_invitations \
             SET status = 'revoked', responded_at = now() \
             WHERE invitation_id = $1 AND organization_id = $2 AND status = 'pending'",
        )
        .bind(&invitation_id)
        .bind(&organization_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        if revoked.rows_affected() == 0 {
            return Err(invitation_not_found());
        }
        tx.commit().await.map_err(|_| server_error())?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.into_response(),
    }
}

/// The caller's own pending invitations.
pub(super) async fn list_mine(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match pending(&state, "i.invitee_account_id", &session.account_id).await {
        Ok(invitations) => Json(json!({ "invitations": invitations })).into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn accept(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(invitation_id): Path<String>,
) -> Response {
    let result: Result<String, ApiError> = async {
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let row: Option<(String, String, Option<DateTime<Utc>>)> = query_as(
            "SELECT i.organization_id, i.role, i.membership_expires_at \
             FROM cloud_organization_invitations i \
             JOIN cloud_organizations o ON o.organization_id = i.organization_id \
             WHERE i.invitation_id = $1 AND i.invitee_account_id = $2 \
               AND i.status = 'pending' AND i.expires_at > now() AND o.kind = 'team' \
               AND o.config_id IS NULL \
               AND (i.membership_expires_at IS NULL OR i.membership_expires_at > now()) \
               AND EXISTS ( \
                 SELECT 1 FROM cloud_organization_members inviter \
                 WHERE inviter.organization_id = i.organization_id \
                   AND inviter.account_id = i.invited_by_account_id \
                   AND (inviter.expires_at IS NULL OR inviter.expires_at > now()) \
                   AND (inviter.role = 'owner' \
                        OR (inviter.role = 'admin' AND i.role <> 'owner'))) \
             FOR UPDATE OF o, i",
        )
        .bind(&invitation_id)
        .bind(&session.account_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        let (organization_id, role, ends) = row.ok_or_else(invitation_not_found)?;
        query(
            "INSERT INTO cloud_organization_members \
                 (organization_id, account_id, role, expires_at) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (organization_id, account_id) DO UPDATE SET \
                 role = EXCLUDED.role, expires_at = EXCLUDED.expires_at, joined_at = now() \
             WHERE cloud_organization_members.expires_at IS NOT NULL \
               AND cloud_organization_members.expires_at <= now()",
        )
        .bind(&organization_id)
        .bind(&session.account_id)
        .bind(&role)
        .bind(ends)
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        query(
            "UPDATE cloud_organization_invitations \
             SET status = 'accepted', responded_at = now() WHERE invitation_id = $1",
        )
        .bind(&invitation_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        tx.commit().await.map_err(|_| server_error())?;
        Ok(organization_id)
    }
    .await;
    let organization_id = match result {
        Ok(id) => id,
        Err(error) => return error.into_response(),
    };
    match member_summary(state.db_pool(), &session.account_id, &organization_id).await {
        Ok(Some(organization)) => Json(json!({ "organization": organization })).into_response(),
        Ok(None) => server_error().into_response(),
        Err(error) => error.into_response(),
    }
}

pub(super) async fn decline(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(invitation_id): Path<String>,
) -> Response {
    let declined = query(
        "UPDATE cloud_organization_invitations \
         SET status = 'declined', responded_at = now() \
         WHERE invitation_id = $1 AND invitee_account_id = $2 AND status = 'pending'",
    )
    .bind(&invitation_id)
    .bind(&session.account_id)
    .execute(state.db_pool())
    .await;
    match declined {
        Ok(result) if result.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => invitation_not_found().into_response(),
        Err(_) => server_error().into_response(),
    }
}
