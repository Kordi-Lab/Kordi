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
pub mod hints;
pub mod hooks;
pub mod join_requests;
pub mod narrowing;
pub mod reload;
pub mod signature;
pub mod store;
#[cfg(test)]
mod test_support;
pub mod view;

pub use claim::SignInEvidence;
pub use config::{OrganizationAdmission, SignInMethod};
pub use reload::LiveAdmission;

const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// Admin routes, behind the bearer cloud session like the other
/// organization routes.
pub(super) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
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

/// The caller's account routes. The kordi.ai pages call them with the web
/// session cookie and the apps with a bearer session; the auth router mounts
/// them behind a middleware that accepts either.
pub fn account_routes() -> Router<Arc<ServerState>> {
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
}

/// Reads `KORDI_ORGANIZATIONS_FILE` and syncs its organizations to the
/// database. The error is a startup message that names the bad field and
/// never contains secrets; it is leaked because startup stops on it.
pub async fn load(pool: &sqlx_postgres::PgPool) -> Result<LiveAdmission, &'static str> {
    let leak = |message: String| -> &'static str { Box::leak(message.into_boxed_str()) };
    let admission = OrganizationAdmission::from_env().map_err(leak)?;
    let admission = admission
        .sync(pool)
        .await
        .map_err(|error| leak(format!("sync configured organizations: {error}")))?;
    println!(
        "Kordi configured organizations: {} (removed from the file: {})",
        admission.organizations.len(),
        admission.orphaned.len()
    );
    for warning in &admission.warnings {
        eprintln!("[organization admission] warning: {warning}");
    }
    let path = std::env::var(config::FILE_ENV)
        .ok()
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty());
    Ok(LiveAdmission::with_path(admission, path))
}

/// Expires lapsed memberships and purges old join requests every hour, and
/// reloads the file when it changes.
pub fn spawn(state: Arc<ServerState>) {
    state
        .organization_admission()
        .spawn_watcher(state.db_pool().clone());
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            let admission = state.organization_admission().current();
            if admission.needs_sweep() {
                store::sweep(state.db_pool(), &admission).await;
            }
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
