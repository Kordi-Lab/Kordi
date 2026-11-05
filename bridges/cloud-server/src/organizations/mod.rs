//! Organizations (docs/development/organizations.md), the foundation for team
//! workspaces. Every account has one personal organization, where it is the
//! only member and the owner; a team organization can have many members.
//!
//! Database triggers create each account's personal organization
//! (migration 0162), stamp new owned records with it (0163), refuse an
//! organization the content owner does not belong to, and apply the
//! member-owned-content rule (0166). This module serves reads, invitations,
//! leaving, settings, content transfers, and the owner/admin membership
//! changes. Every handler runs behind the cloud session middleware, and an
//! organization the caller does not belong to answers 404, as if it did not
//! exist.

use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Serialize;

use crate::server::ServerState;

pub mod admission;
mod handlers;
mod invitations;
mod policy;
pub mod selection;
mod settings;
#[cfg(test)]
mod tests;
mod transfers;

pub use policy::{MembershipChange, OrganizationRole, PolicyError};

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/v1/cloud/organizations", get(handlers::list_organizations))
        .route(
            "/v1/cloud/organizations/:organization_id",
            get(handlers::get_organization).patch(settings::update_organization),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/members",
            get(handlers::list_members),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/members/:account_id",
            axum::routing::patch(handlers::update_member).delete(handlers::remove_member),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/leave",
            post(settings::leave),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/invitations",
            get(invitations::list_for_organization).post(invitations::invite),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/invitations/:invitation_id",
            delete(invitations::revoke),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/transfers",
            post(transfers::transfer),
        )
        .route(
            "/v1/cloud/organization-invitations",
            get(invitations::list_mine),
        )
        .route(
            "/v1/cloud/organization-invitations/:invitation_id/accept",
            post(invitations::accept),
        )
        .route(
            "/v1/cloud/organization-invitations/:invitation_id/decline",
            post(invitations::decline),
        )
        .merge(admission::routes())
}

pub const PERSONAL_KIND: &str = "personal";
pub const TEAM_KIND: &str = "team";

/// One organization as the caller sees it, with the caller's role.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationSummary {
    pub organization_id: String,
    pub name: String,
    pub kind: String,
    pub role: OrganizationRole,
    pub member_count: i64,
    pub created_at: String,
    /// Content here must be owned by a member (the owner-eligibility rule).
    pub member_owned_content: bool,
    /// When the caller's own membership ends; `None` for a lasting one.
    pub membership_expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationMember {
    pub account_id: String,
    pub display_name: Option<String>,
    pub role: OrganizationRole,
    pub joined_at: String,
    pub membership_expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    error_code: &'static str,
    message: &'static str,
}

/// An error response, kept small so helpers can return it by value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApiError {
    pub code: &'static str,
    pub message: &'static str,
    pub status: StatusCode,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = ErrorBody {
            error_code: self.code,
            message: self.message,
        };
        (self.status, Json(body)).into_response()
    }
}

fn err(code: &'static str, message: &'static str, status: StatusCode) -> ApiError {
    ApiError {
        code,
        message,
        status,
    }
}

fn not_found() -> ApiError {
    err(
        "organization_not_found",
        "Organization not found.",
        StatusCode::NOT_FOUND,
    )
}

fn bad_request(code: &'static str, message: &'static str) -> ApiError {
    err(code, message, StatusCode::BAD_REQUEST)
}

fn server_error() -> ApiError {
    err(
        "server_error",
        "Could not complete the organization request.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

impl From<PolicyError> for ApiError {
    fn from(error: PolicyError) -> Self {
        match error {
            PolicyError::NotManager => err(
                "organization_forbidden",
                "Only owners and admins can change members.",
                StatusCode::FORBIDDEN,
            ),
            PolicyError::PersonalOrganization => err(
                "personal_organization",
                "A personal organization has only its owner.",
                StatusCode::CONFLICT,
            ),
            PolicyError::OwnerRequired => err(
                "organization_owner_required",
                "Only an owner can add, change, or remove an owner.",
                StatusCode::FORBIDDEN,
            ),
            PolicyError::LastOwner => err(
                "last_owner",
                "An organization needs at least one owner.",
                StatusCode::CONFLICT,
            ),
        }
    }
}
