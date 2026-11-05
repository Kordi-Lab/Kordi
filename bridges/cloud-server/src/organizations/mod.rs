//! Organizations (docs/development/organizations.md), the foundation for team
//! workspaces. Every account has one personal organization, where it is the
//! only member and the owner; a team organization can have many members.
//!
//! Database triggers create each account's personal organization
//! (migration 0162) and stamp new owned records with it (0163). This module
//! serves reads and the owner/admin membership changes. Every handler runs
//! behind the cloud session middleware, and an organization the caller does
//! not belong to answers 404, as if it did not exist.

use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::server::ServerState;

pub mod admission;
mod handlers;
mod policy;
#[cfg(test)]
mod tests;

pub use policy::{MembershipChange, OrganizationRole, PolicyError};

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/v1/cloud/organizations", get(handlers::list_organizations))
        .route(
            "/v1/cloud/organizations/:organization_id",
            get(handlers::get_organization),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/members",
            get(handlers::list_members).post(handlers::add_member),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/members/:account_id",
            axum::routing::patch(handlers::update_member).delete(handlers::remove_member),
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationMember {
    pub account_id: String,
    pub display_name: Option<String>,
    pub role: OrganizationRole,
    pub joined_at: String,
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
