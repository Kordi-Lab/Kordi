//! Join requests: a signed-in account asks to join a configured organization
//! with the fields the admission file defines, and the organization's owners
//! and admins approve or reject. Rows are deleted after the retention period.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;

use super::config::{ApprovedMembershipExpiry, ConfiguredOrganization, JoinRequestField};
use super::store::add_member;
use super::{error, not_configured};
use crate::auth::routes::CloudSession;
use crate::organizations::{
    handlers::member_summary, not_found, server_error, ApiError, OrganizationRole,
};
use crate::server::ServerState;

const PAGE_SIZE: i64 = 200;
/// The longest expiry an approver may set.
const MAX_APPROVED_DAYS: i64 = 3650;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubmitRequest {
    fields: BTreeMap<String, String>,
}

/// Checks submitted values against the configured fields. Returns the
/// trimmed values to store, or the error to show.
pub fn validate_fields(
    configured: &[JoinRequestField],
    submitted: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, ApiError> {
    let invalid =
        |message: &'static str| error("invalid_join_request", message, StatusCode::BAD_REQUEST);
    if submitted
        .keys()
        .any(|key| !configured.iter().any(|f| &f.key == key))
    {
        return Err(invalid(
            "The request has a field this organization does not ask for.",
        ));
    }
    let mut values = BTreeMap::new();
    for field in configured {
        let value = submitted
            .get(&field.key)
            .map(|v| v.trim())
            .unwrap_or_default();
        if value.is_empty() {
            if field.required {
                return Err(invalid("Fill in every required field."));
            }
            continue;
        }
        if value.chars().count() > field.max_length as usize || value.contains('\0') {
            return Err(invalid("A field is longer than this organization allows."));
        }
        values.insert(field.key.clone(), value.to_string());
    }
    Ok(values)
}

/// `POST /v1/cloud/account/organizations/:config_id/join-requests`
pub(super) async fn submit(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(config_id): Path<String>,
    Json(req): Json<SubmitRequest>,
) -> Response {
    let Some(org) = state.organization_admission().by_config_id(&config_id) else {
        return not_configured().into_response();
    };
    let Some(policy) = org.join_requests.as_ref().filter(|_| org.state.admits()) else {
        return requests_closed().into_response();
    };
    let values = match validate_fields(&policy.fields, &req.fields) {
        Ok(values) => values,
        Err(error) => return error.into_response(),
    };
    let pool = state.db_pool();
    match member_summary(pool, &session.account_id, &org.organization_id).await {
        Ok(Some(_)) => {
            return error(
                "already_member",
                "You are already a member.",
                StatusCode::CONFLICT,
            )
            .into_response()
        }
        Ok(None) => {}
        Err(error) => return error.into_response(),
    }
    let request_id = format!("ojr_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now();
    // The partial unique index allows one open (pending or rejected)
    // request per account until it is purged.
    let inserted = query(
        "INSERT INTO cloud_organization_join_requests \
         (request_id, organization_id, account_id, fields_json, status, created_at) \
         VALUES ($1, $2, $3, $4, 'pending', $5) ON CONFLICT DO NOTHING",
    )
    .bind(&request_id)
    .bind(&org.organization_id)
    .bind(&session.account_id)
    .bind(json!(values))
    .bind(now)
    .execute(pool)
    .await;
    match inserted {
        Ok(result) if result.rows_affected() == 1 => (
            StatusCode::CREATED,
            Json(json!({ "joinRequest": {
                "requestId": request_id, "status": "pending", "createdAt": now.to_rfc3339(),
            }})),
        )
            .into_response(),
        Ok(_) => error(
            "join_request_exists",
            "You already have a join request for this organization.",
            StatusCode::CONFLICT,
        )
        .into_response(),
        Err(_) => server_error().into_response(),
    }
}

fn requests_closed() -> ApiError {
    error(
        "join_requests_closed",
        "This organization is not accepting join requests.",
        StatusCode::CONFLICT,
    )
}

/// The configured organization when the caller is one of its owners or
/// admins. Anyone else gets 404, or 403 when they are a plain member.
async fn managed<'a>(
    state: &'a ServerState,
    session: &CloudSession,
    organization_id: &str,
) -> Result<&'a ConfiguredOrganization, ApiError> {
    let summary = member_summary(state.db_pool(), &session.account_id, organization_id)
        .await?
        .ok_or_else(not_found)?;
    let org = state
        .organization_admission()
        .by_organization_id(organization_id)
        .ok_or_else(not_found)?;
    if summary.role == OrganizationRole::Member {
        return Err(error(
            "organization_forbidden",
            "Only owners and admins can review join requests.",
            StatusCode::FORBIDDEN,
        ));
    }
    Ok(org)
}

#[derive(Deserialize)]
pub(super) struct ListQuery {
    status: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestView {
    request_id: String,
    account_id: String,
    display_name: Option<String>,
    verified_email: Option<String>,
    fields: Value,
    status: String,
    created_at: String,
    decided_at: Option<String>,
}

type RequestRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Value,
    String,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
);

/// `GET /v1/cloud/organizations/:organization_id/join-requests?status=`
pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(organization_id): Path<String>,
    Query(params): Query<ListQuery>,
) -> Response {
    let org = match managed(&state, &session, &organization_id).await {
        Ok(org) => org,
        Err(error) => return error.into_response(),
    };
    let status = params.status.unwrap_or_else(|| "pending".to_string());
    if !["pending", "approved", "rejected"].contains(&status.as_str()) {
        return error(
            "invalid_status",
            "Unknown request status.",
            StatusCode::BAD_REQUEST,
        )
        .into_response();
    }
    let rows: Vec<RequestRow> = match query_as(
        "SELECT r.request_id, r.account_id, a.display_name, \
                CASE WHEN a.primary_email_verified_at IS NOT NULL THEN a.primary_email END, \
                r.fields_json, r.status, r.created_at, r.decided_at \
         FROM cloud_organization_join_requests r \
         JOIN cloud_accounts a ON a.account_id = r.account_id \
         WHERE r.organization_id = $1 AND r.status = $2 \
         ORDER BY r.created_at, r.request_id LIMIT $3",
    )
    .bind(&org.organization_id)
    .bind(&status)
    .bind(PAGE_SIZE)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => return server_error().into_response(),
    };
    let requests: Vec<RequestView> = rows
        .into_iter()
        .map(
            |(
                request_id,
                account_id,
                display_name,
                verified_email,
                fields,
                status,
                created_at,
                decided_at,
            )| RequestView {
                request_id,
                account_id,
                display_name,
                verified_email,
                fields,
                status,
                created_at: created_at.to_rfc3339(),
                decided_at: decided_at.map(|at| at.to_rfc3339()),
            },
        )
        .collect();
    let fields = org
        .join_requests
        .as_ref()
        .map(|p| p.fields.as_slice())
        .unwrap_or_default();
    Json(json!({ "joinRequests": requests, "fields": fields })).into_response()
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ApproveRequest {
    expires_at: Option<String>,
}

/// The membership expiry for an approval under `policy`, or the error.
pub fn approved_expiry(
    policy: ApprovedMembershipExpiry,
    requested: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, ApiError> {
    let invalid = |message: &'static str| error("invalid_expiry", message, StatusCode::BAD_REQUEST);
    match (policy, requested) {
        (ApprovedMembershipExpiry::Never, None) => Ok(None),
        (ApprovedMembershipExpiry::Days(days), None) => Ok(Some(now + Duration::days(days.into()))),
        (ApprovedMembershipExpiry::SetByApprover, None) => Ok(None),
        (ApprovedMembershipExpiry::SetByApprover, Some(value)) => {
            let at = DateTime::parse_from_rfc3339(value)
                .map_err(|_| invalid("expiresAt must be an RFC 3339 time."))?
                .with_timezone(&Utc);
            if at <= now || at > now + Duration::days(MAX_APPROVED_DAYS) {
                return Err(invalid(
                    "expiresAt must be in the future and within ten years.",
                ));
            }
            Ok(Some(at))
        }
        (_, Some(_)) => Err(invalid("This organization sets membership expiry itself.")),
    }
}

/// `POST /v1/cloud/organizations/:organization_id/join-requests/:request_id/approve`
pub(super) async fn approve(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((organization_id, request_id)): Path<(String, String)>,
    body: axum::body::Bytes,
) -> Response {
    // An empty body approves with the default expiry; anything else must
    // parse, so a malformed expiry is never ignored.
    let body = if body.iter().all(u8::is_ascii_whitespace) {
        ApproveRequest::default()
    } else {
        match serde_json::from_slice::<ApproveRequest>(&body) {
            Ok(body) => body,
            Err(_) => {
                return error(
                    "invalid_body",
                    "The request body is not valid.",
                    StatusCode::BAD_REQUEST,
                )
                .into_response()
            }
        }
    };
    match decide(&state, &session, &organization_id, &request_id, Some(body)).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

/// `POST /v1/cloud/organizations/:organization_id/join-requests/:request_id/reject`
pub(super) async fn reject(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((organization_id, request_id)): Path<(String, String)>,
) -> Response {
    match decide(&state, &session, &organization_id, &request_id, None).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}

/// Approves (`approval` set) or rejects one pending request under a row lock.
async fn decide(
    state: &ServerState,
    session: &CloudSession,
    organization_id: &str,
    request_id: &str,
    approval: Option<ApproveRequest>,
) -> Result<Response, ApiError> {
    let org = managed(state, session, organization_id).await?;
    let policy = org
        .join_requests
        .as_ref()
        .filter(|_| org.state.admits())
        .ok_or_else(requests_closed)?;
    let now = Utc::now();
    let expires_at = match &approval {
        Some(body) => approved_expiry(
            policy.approved_membership_expiry,
            body.expires_at.as_deref(),
            now,
        )?,
        None => None,
    };
    let mut tx = state.db_pool().begin().await.map_err(|_| server_error())?;
    let row: Option<(String,)> = query_as(
        "SELECT account_id FROM cloud_organization_join_requests \
         WHERE request_id = $1 AND organization_id = $2 AND status = 'pending' FOR UPDATE",
    )
    .bind(request_id)
    .bind(&org.organization_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| server_error())?;
    let Some((account_id,)) = row else {
        return Err(error(
            "join_request_not_found",
            "No pending join request with this id.",
            StatusCode::NOT_FOUND,
        ));
    };
    let status = if approval.is_some() {
        "approved"
    } else {
        "rejected"
    };
    query(
        "UPDATE cloud_organization_join_requests \
         SET status = $2, decided_at = $3, decided_by_account_id = $4 WHERE request_id = $1",
    )
    .bind(request_id)
    .bind(status)
    .bind(now)
    .bind(&session.account_id)
    .execute(&mut *tx)
    .await
    .map_err(|_| server_error())?;
    if approval.is_some() {
        // An active domain-claim admission stays: it is the stronger proof.
        query(
            "INSERT INTO cloud_organization_admissions \
             (organization_id, account_id, source, verified_email, verified_at, expires_at, \
              approved_by_account_id) \
             SELECT $1, $2, 'join_request', \
                    CASE WHEN primary_email_verified_at IS NOT NULL THEN lower(primary_email) END, \
                    $3, $4, $5 \
             FROM cloud_accounts WHERE account_id = $2 \
             ON CONFLICT (organization_id, account_id) DO UPDATE SET \
               source = 'join_request', verified_email = EXCLUDED.verified_email, \
               verification_method = NULL, verified_at = EXCLUDED.verified_at, \
               expires_at = EXCLUDED.expires_at, \
               approved_by_account_id = EXCLUDED.approved_by_account_id, \
               lapsed_at = NULL, lapse_reason = NULL \
             WHERE cloud_organization_admissions.source <> 'domain_claim' \
                OR cloud_organization_admissions.lapsed_at IS NOT NULL",
        )
        .bind(&org.organization_id)
        .bind(&account_id)
        .bind(now)
        .bind(expires_at)
        .bind(&session.account_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| server_error())?;
        add_member(&mut tx, &org.organization_id, &account_id)
            .await
            .map_err(|_| server_error())?;
    }
    tx.commit().await.map_err(|_| server_error())?;
    Ok(Json(json!({ "joinRequest": {
        "requestId": request_id,
        "accountId": account_id,
        "status": status,
        "decidedAt": now.to_rfc3339(),
        "membershipExpiresAt": expires_at.map(|at| at.to_rfc3339()),
    }}))
    .into_response())
}

#[cfg(test)]
#[path = "join_requests_tests.rs"]
mod tests;
