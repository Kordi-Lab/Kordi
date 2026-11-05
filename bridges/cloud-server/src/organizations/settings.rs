//! Team settings and leaving a team.
//!
//! `memberOwnedContent` is the owner-eligibility rule: content in the team
//! must be owned by a member. Turning it on moves content whose owner is not
//! a member to that owner's personal organization right away; the 0166
//! triggers keep applying it when members leave, are removed, or expire.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;
use sqlx_core::query::query;

use super::handlers::{configured_refusal, lock_for_change, member_summary, owner_count};
use super::policy::{check_leave, manages_content, PolicyError};
use super::{bad_request, server_error, ApiError, TEAM_KIND};
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

const MAX_NAME_CHARS: usize = 120;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct UpdateOrganizationRequest {
    name: Option<String>,
    member_owned_content: Option<bool>,
}

fn clean_name(value: &str) -> Result<String, ApiError> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(bad_request(
            "invalid_name",
            "name must be 1 to 120 characters.",
        ));
    }
    Ok(name.to_string())
}

pub(super) async fn update_organization(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
    Json(request): Json<UpdateOrganizationRequest>,
) -> Response {
    let result: Result<(), ApiError> = async {
        let name = request.name.as_deref().map(clean_name).transpose()?;
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let (kind, actor, configured) =
            lock_for_change(&mut tx, &organization_id, &session.account_id).await?;
        if !manages_content(actor) {
            return Err(PolicyError::NotManager.into());
        }
        if kind != TEAM_KIND {
            return Err(PolicyError::PersonalOrganization.into());
        }
        // The admission file sets the name and the rule of its organizations.
        if configured {
            return Err(configured_refusal());
        }
        query(
            "UPDATE cloud_organizations SET \
                 name = COALESCE($2, name), \
                 member_owned_content = COALESCE($3, member_owned_content) \
             WHERE organization_id = $1",
        )
        .bind(&organization_id)
        .bind(name)
        .bind(request.member_owned_content)
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        if request.member_owned_content == Some(true) {
            query("SELECT cloud_reassign_ineligible_content($1, NULL)")
                .bind(&organization_id)
                .execute(&mut *tx)
                .await
                .map_err(|_| server_error())?;
        }
        tx.commit().await.map_err(|_| server_error())?;
        Ok(())
    }
    .await;
    if let Err(error) = result {
        return error.into_response();
    }
    match member_summary(state.db_pool(), &session.account_id, &organization_id).await {
        Ok(Some(organization)) => Json(json!({ "organization": organization })).into_response(),
        Ok(None) => super::not_found().into_response(),
        Err(error) => error.into_response(),
    }
}

/// The caller leaves a team. Their content follows the team's rule: it stays
/// unless the team requires member owners.
pub(super) async fn leave(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
) -> Response {
    let result: Result<(), ApiError> = async {
        let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
        let (kind, role, configured) =
            lock_for_change(&mut tx, &organization_id, &session.account_id).await?;
        let owners = owner_count(&mut tx, &organization_id).await?;
        check_leave(&kind, role, owners)?;
        if configured {
            // Admission records the end; configured admins cannot leave.
            super::admission::store::remove_admitted_member(
                &mut tx,
                &organization_id,
                &session.account_id,
            )
            .await?;
            tx.commit().await.map_err(|_| server_error())?;
            return Ok(());
        }
        query(
            "DELETE FROM cloud_organization_members \
             WHERE organization_id = $1 AND account_id = $2",
        )
        .bind(&organization_id)
        .bind(&session.account_id)
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
