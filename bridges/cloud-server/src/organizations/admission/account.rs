//! Account routes: the caller's organizations with each configured
//! organization's admission state and entry-page copy, and joining or
//! re-verifying with an organization email code.

use std::sync::Arc;

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::claim::SignInEvidence;
use super::config::{
    ConfiguredOrganization, EntryPage, JoinRequestField, OrganizationState, SignInMethod,
};
use super::store::{apply_evidence, expire_due, VerifyOutcome};
use super::view::{caller_state, is_due, AdmissionState, CallerFacts, JoinOptions};
use super::{error, not_configured};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision, EMAIL_VERIFICATION_LIMIT};
use crate::auth::routes::CloudSession;
use crate::auth::signup_email::{
    consume_organization_email_code, request_organization_email_code, SignupCodeError,
};
use crate::organizations::{handlers::organizations_for, server_error, ApiError};
use crate::server::ServerState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpenRequest {
    request_id: String,
    status: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfiguredView<'a> {
    id: &'a str,
    organization_id: &'a str,
    display_name: &'a str,
    state: OrganizationState,
    admission: AdmissionState,
    join_options: JoinOptions,
    claimed_domains: &'a [String],
    join_request_fields: &'a [JoinRequestField],
    join_request: Option<OpenRequest>,
    verified_at: Option<String>,
    reverify_by: Option<String>,
    expires_at: Option<String>,
    entry_page: &'a EntryPage,
}

type FactsRow = (
    Option<String>,
    Option<String>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<DateTime<Utc>>,
);

async fn load_facts(
    pool: &PgPool,
    org: &ConfiguredOrganization,
    account_id: &str,
) -> Result<(CallerFacts, Option<OpenRequest>), sqlx_core::Error> {
    let row: FactsRow = query_as(
        "SELECT m.role, a.source, a.verified_at, a.expires_at, a.lapsed_at, a.lapse_reason, \
                r.request_id, r.status, r.created_at \
         FROM (SELECT 1) one \
         LEFT JOIN cloud_organization_members m \
           ON m.organization_id = $1 AND m.account_id = $2 \
         LEFT JOIN cloud_organization_admissions a \
           ON a.organization_id = $1 AND a.account_id = $2 \
         LEFT JOIN cloud_organization_join_requests r \
           ON r.organization_id = $1 AND r.account_id = $2 AND r.status <> 'approved'",
    )
    .bind(&org.organization_id)
    .bind(account_id)
    .fetch_one(pool)
    .await?;
    let (
        role,
        source,
        verified_at,
        expires_at,
        lapsed_at,
        lapse_reason,
        request_id,
        status,
        created_at,
    ) = row;
    let facts = CallerFacts {
        is_member: role.is_some(),
        source,
        verified_at,
        expires_at,
        lapsed_at,
        lapse_reason,
        request_status: status.clone(),
    };
    let join_request = match (request_id, status, created_at) {
        (Some(request_id), Some(status), Some(created_at)) => Some(OpenRequest {
            request_id,
            status,
            created_at: created_at.to_rfc3339(),
        }),
        _ => None,
    };
    Ok((facts, join_request))
}

/// The caller's current facts. A membership past its verification ends
/// before it is shown; reads write only then, and the hourly sweep handles
/// everyone else.
pub(super) async fn current_facts(
    pool: &PgPool,
    org: &ConfiguredOrganization,
    account_id: &str,
    now: DateTime<Utc>,
) -> Result<(CallerFacts, Option<OpenRequest>), sqlx_core::Error> {
    let (facts, join_request) = load_facts(pool, org, account_id).await?;
    if !is_due(org, &facts, now) {
        return Ok((facts, join_request));
    }
    expire_due(pool, org, Some(account_id)).await?;
    load_facts(pool, org, account_id).await
}

async fn configured_view<'a>(
    pool: &PgPool,
    org: &'a ConfiguredOrganization,
    account_id: &str,
) -> Result<ConfiguredView<'a>, sqlx_core::Error> {
    let now = Utc::now();
    let (facts, join_request) = current_facts(pool, org, account_id, now).await?;
    let caller = caller_state(org, &facts, now);
    Ok(ConfiguredView {
        id: &org.id,
        organization_id: &org.organization_id,
        display_name: &org.display_name,
        state: org.state,
        admission: caller.state,
        join_options: caller.options,
        claimed_domains: &org.claim.domains,
        join_request_fields: org
            .join_requests
            .as_ref()
            .map(|policy| policy.fields.as_slice())
            .unwrap_or_default(),
        join_request,
        verified_at: facts.verified_at.map(|at| at.to_rfc3339()),
        reverify_by: caller.reverify_by.map(|at| at.to_rfc3339()),
        expires_at: facts
            .expires_at
            .filter(|_| facts.lapsed_at.is_none())
            .map(|at| at.to_rfc3339()),
        entry_page: &org.entry_page,
    })
}

/// `GET /v1/cloud/account/organizations`
pub(super) async fn account_organizations(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    let admission = state.organization_admission();
    let mut configured = Vec::with_capacity(admission.organizations.len());
    for org in &admission.organizations {
        match configured_view(pool, org, &session.account_id).await {
            Ok(view) => configured.push(view),
            Err(_) => return server_error().into_response(),
        }
    }
    // Read after the expiry above so a lapsed membership is not listed.
    let organizations = match organizations_for(pool, &session.account_id).await {
        Ok(organizations) => organizations,
        Err(error) => return error.into_response(),
    };
    Json(json!({ "organizations": organizations, "configured": configured })).into_response()
}

/// The configured organization when it accepts organization email codes.
fn email_code_organization<'a>(
    state: &'a ServerState,
    config_id: &str,
) -> Result<&'a ConfiguredOrganization, ApiError> {
    let org = state
        .organization_admission()
        .by_config_id(config_id)
        .ok_or_else(not_configured)?;
    if !org.state.admits() {
        return Err(error(
            "organization_not_open",
            "This organization is not open yet.",
            StatusCode::CONFLICT,
        ));
    }
    if !org.auto_joins(SignInMethod::EmailCode) {
        return Err(error(
            "email_code_not_accepted",
            "This organization does not accept email codes.",
            StatusCode::FORBIDDEN,
        ));
    }
    Ok(org)
}

async fn charge(
    limiter: &CloudRateLimiter,
    session: &CloudSession,
    headers: &HeaderMap,
    connect_info: Option<&ConnectInfo<std::net::SocketAddr>>,
) -> Result<(), ApiError> {
    let ip = crate::client_ip::resolve_client_ip(headers, connect_info.map(|info| info.0.ip()));
    let ip_decision = limiter.observe_ip(ip).await;
    let account_decision = match ip_decision {
        RateLimitDecision::Allowed => {
            limiter
                .observe_account_limit(EMAIL_VERIFICATION_LIMIT, &session.account_id)
                .await
        }
        limited => limited,
    };
    match account_decision {
        RateLimitDecision::Allowed => Ok(()),
        RateLimitDecision::Limited { .. } => Err(error(
            "rate_limited",
            "Too many attempts. Try again shortly.",
            StatusCode::TOO_MANY_REQUESTS,
        )),
    }
}

fn code_error(code: SignupCodeError) -> ApiError {
    match code {
        SignupCodeError::Invalid => error(
            "invalid_verification_code",
            "The email code is invalid or expired. Request a new code and try again.",
            StatusCode::BAD_REQUEST,
        ),
        SignupCodeError::Limited(_) => error(
            "rate_limited",
            "Too many codes requested. Try again shortly.",
            StatusCode::TOO_MANY_REQUESTS,
        ),
        SignupCodeError::Unavailable => email_unavailable(),
        SignupCodeError::AlreadyVerified | SignupCodeError::Database => server_error(),
    }
}

fn email_unavailable() -> ApiError {
    error(
        "email_delivery_unavailable",
        "Email verification is temporarily unavailable. Try again later.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EmailCodeRequest {
    email: String,
}

/// `POST /v1/cloud/account/organizations/:config_id/email-code`
pub(super) async fn send_email_code(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<std::net::SocketAddr>>,
    headers: HeaderMap,
    Path(config_id): Path<String>,
    Json(req): Json<EmailCodeRequest>,
) -> Response {
    let org = match email_code_organization(&state, &config_id) {
        Ok(org) => org,
        Err(error) => return error.into_response(),
    };
    let Ok(email) = crate::auth::password::validate_email(&req.email) else {
        return error(
            "invalid_email",
            "Enter a valid email address.",
            StatusCode::BAD_REQUEST,
        )
        .into_response();
    };
    if !org.claim.covers_email(&email) {
        return email_not_claimed().into_response();
    }
    let Some(service) = state.signup_email() else {
        return email_unavailable().into_response();
    };
    if let Err(error) = charge(&limiter, &session, &headers, connect_info.as_ref()).await {
        return error.into_response();
    }
    match request_organization_email_code(state.db_pool(), service, &session.account_id, &email)
        .await
    {
        Ok(challenge) => (StatusCode::OK, Json(challenge)).into_response(),
        Err(code) => code_error(code).into_response(),
    }
}

fn email_not_claimed() -> ApiError {
    error(
        "email_not_claimed",
        "Use an email address in a domain this organization accepts.",
        StatusCode::FORBIDDEN,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EmailCodeVerification {
    verification_id: String,
    verification_code: String,
}

/// `POST /v1/cloud/account/organizations/:config_id/email-code/verify`
pub(super) async fn verify_email_code(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<std::net::SocketAddr>>,
    headers: HeaderMap,
    Path(config_id): Path<String>,
    Json(req): Json<EmailCodeVerification>,
) -> Response {
    let org = match email_code_organization(&state, &config_id) {
        Ok(org) => org,
        Err(error) => return error.into_response(),
    };
    let Some(service) = state.signup_email() else {
        return email_unavailable().into_response();
    };
    if let Err(error) = charge(&limiter, &session, &headers, connect_info.as_ref()).await {
        return error.into_response();
    }
    let pool = state.db_pool();
    let email = match consume(pool, service, &session.account_id, &req).await {
        Ok(email) => email,
        Err(error) => return error.into_response(),
    };
    let evidence = SignInEvidence {
        method: SignInMethod::EmailCode,
        email: Some(&email),
        email_verified: true,
        hosted_domain: None,
    };
    match apply_evidence(pool, org, &session.account_id, &evidence).await {
        Ok(VerifyOutcome::Joined | VerifyOutcome::Renewed) => {}
        Ok(VerifyOutcome::Ignored) => return email_not_claimed().into_response(),
        Ok(VerifyOutcome::Removed) => {
            return error(
                "membership_removed",
                "An admin removed you from this organization. Send a join request instead.",
                StatusCode::FORBIDDEN,
            )
            .into_response()
        }
        Ok(VerifyOutcome::EmailInUse) => {
            return error(
                "organization_email_in_use",
                "Another account already uses this email in this organization.",
                StatusCode::CONFLICT,
            )
            .into_response()
        }
        Err(_) => return server_error().into_response(),
    }
    match configured_view(pool, org, &session.account_id).await {
        Ok(view) => Json(json!({ "configured": view })).into_response(),
        Err(_) => server_error().into_response(),
    }
}

/// Consumes the code and returns the email it proved. Failed guesses are
/// committed so they count against the code.
async fn consume(
    pool: &PgPool,
    service: &crate::auth::signup_email::SignupEmailService,
    account_id: &str,
    req: &EmailCodeVerification,
) -> Result<String, ApiError> {
    let mut tx = pool.begin().await.map_err(|_| server_error())?;
    let row: Option<(String,)> = query_as(
        "SELECT email FROM cloud_organization_email_codes \
         WHERE account_id = $1 AND verification_id = $2",
    )
    .bind(account_id)
    .bind(req.verification_id.trim())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| server_error())?;
    let Some((email,)) = row else {
        return Err(code_error(SignupCodeError::Invalid));
    };
    let consumed = consume_organization_email_code(
        &mut tx,
        service,
        account_id,
        &email,
        req.verification_id.trim(),
        req.verification_code.trim(),
    )
    .await;
    if consumed.is_ok() {
        // A provider identity that reports this address may match by it again.
        crate::auth::identity_email::reverify_identity_emails(&mut tx, account_id, &email)
            .await
            .map_err(|_| server_error())?;
    }
    tx.commit().await.map_err(|_| server_error())?;
    consumed.map_err(code_error)?;
    Ok(email)
}
