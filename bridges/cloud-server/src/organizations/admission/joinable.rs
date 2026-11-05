//! The configured organizations the caller can join by the domain of its
//! verified primary email, for the apps' "find your organization" list.
//! Joining itself uses the existing account routes: an organization email
//! code when `joinOptions.emailCode` is set, otherwise a join request.

use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::Utc;
use serde::Serialize;
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::account::current_facts;
use super::config::{ConfiguredOrganization, JoinRequestField};
use super::view::{caller_state, AdmissionState, JoinOptions};
use crate::auth::routes::CloudSession;
use crate::organizations::server_error;
use crate::server::ServerState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinableView<'a> {
    id: &'a str,
    organization_id: &'a str,
    name: &'a str,
    member_count: i64,
    join_options: JoinOptions,
    /// The caller already has an open join request.
    requested: bool,
    join_request_fields: &'a [JoinRequestField],
}

/// The caller's verified primary email, lowercase.
async fn verified_email(
    pool: &PgPool,
    account_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(
        "SELECT lower(primary_email) FROM cloud_accounts \
         WHERE account_id = $1 AND primary_email IS NOT NULL \
           AND primary_email_verified_at IS NOT NULL",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(email,)| email))
}

async fn member_count(pool: &PgPool, organization_id: &str) -> Result<i64, sqlx_core::Error> {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_organization_members \
         WHERE organization_id = $1 AND (expires_at IS NULL OR expires_at > now())",
    )
    .bind(organization_id)
    .fetch_one(pool)
    .await?;
    Ok(count)
}

/// The entry for `org`, or `None` when the caller is a member or has no
/// way in.
async fn joinable_view<'a>(
    pool: &PgPool,
    org: &'a ConfiguredOrganization,
    account_id: &str,
) -> Result<Option<JoinableView<'a>>, sqlx_core::Error> {
    let now = Utc::now();
    let (facts, _) = current_facts(pool, org, account_id, now).await?;
    let caller = caller_state(org, &facts, now);
    let listed = match caller.state {
        AdmissionState::Pending | AdmissionState::Rejected => true,
        AdmissionState::Join | AdmissionState::Lapsed => {
            caller.options.email_code || caller.options.join_request
        }
        _ => false,
    };
    if !listed {
        return Ok(None);
    }
    Ok(Some(JoinableView {
        id: &org.id,
        organization_id: &org.organization_id,
        name: &org.display_name,
        member_count: member_count(pool, &org.organization_id).await?,
        join_options: caller.options,
        requested: facts.request_status.is_some(),
        join_request_fields: org
            .join_requests
            .as_ref()
            .map(|policy| policy.fields.as_slice())
            .unwrap_or_default(),
    }))
}

/// `GET /v1/cloud/account/joinable-organizations`
pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    let email = match verified_email(pool, &session.account_id).await {
        Ok(email) => email,
        Err(_) => return server_error().into_response(),
    };
    let domain = email
        .as_deref()
        .and_then(|email| email.rsplit_once('@'))
        .map(|(_, domain)| domain.to_string());
    let mut organizations = Vec::new();
    let claimed = state
        .organization_admission()
        .organizations
        .iter()
        .filter(|org| org.state.admits())
        .filter(|org| {
            email
                .as_deref()
                .is_some_and(|email| org.claim.covers_email(email))
        });
    for org in claimed {
        match joinable_view(pool, org, &session.account_id).await {
            Ok(Some(view)) => organizations.push(view),
            Ok(None) => {}
            Err(_) => return server_error().into_response(),
        }
    }
    Json(json!({ "email": email, "emailDomain": domain, "organizations": organizations }))
        .into_response()
}
