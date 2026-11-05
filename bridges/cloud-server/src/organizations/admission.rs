//! Organization admission from deployment configuration
//! (docs/development/organization-admission.md): domain claims, join
//! requests, and re-verification for the team organizations an admission
//! file defines. Without the file nothing here runs and every account keeps
//! only its personal organization.

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;

use super::{err, ApiError};
use crate::server::ServerState;

mod account;
pub mod claim;
pub mod config;
pub mod hooks;
pub mod join_requests;
pub mod store;
#[cfg(test)]
mod test_support;
pub mod view;

pub use claim::SignInEvidence;
pub use config::{OrganizationAdmission, SignInMethod};

const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

pub(super) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v1/cloud/account/organizations",
            get(account::account_organizations),
        )
        .route(
            "/v1/cloud/account/organizations/:config_id/email-code",
            post(account::send_email_code),
        )
        .route(
            "/v1/cloud/account/organizations/:config_id/email-code/verify",
            post(account::verify_email_code),
        )
        .route(
            "/v1/cloud/account/organizations/:config_id/join-requests",
            post(join_requests::submit),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/join-requests",
            get(join_requests::list),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/join-requests/:request_id/approve",
            post(join_requests::approve),
        )
        .route(
            "/v1/cloud/organizations/:organization_id/join-requests/:request_id/reject",
            post(join_requests::reject),
        )
}

/// Reads `KORDI_ORGANIZATIONS_FILE` and syncs its organizations to the
/// database. The error is a startup message that names the bad field and
/// never contains secrets; it is leaked because startup stops on it.
pub async fn load(pool: &sqlx_postgres::PgPool) -> Result<OrganizationAdmission, &'static str> {
    let leak = |message: String| -> &'static str { Box::leak(message.into_boxed_str()) };
    let admission = OrganizationAdmission::from_env().map_err(leak)?;
    let admission = admission
        .sync(pool)
        .await
        .map_err(|error| leak(format!("sync configured organizations: {error}")))?;
    println!(
        "Kordi configured organizations: {}",
        admission.organizations.len()
    );
    Ok(admission)
}

/// Expires lapsed memberships and purges old join requests every hour.
pub fn spawn(state: Arc<ServerState>) {
    if state.organization_admission().is_empty() {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            store::sweep(state.db_pool(), state.organization_admission()).await;
        }
    });
}

fn error(code: &'static str, message: &'static str, status: StatusCode) -> ApiError {
    err(code, message, status)
}

fn not_configured() -> ApiError {
    err(
        "organization_not_found",
        "Organization not found.",
        StatusCode::NOT_FOUND,
    )
}

#[cfg(test)]
mod tests;
