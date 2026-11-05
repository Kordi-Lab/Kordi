//! `/v1/cloud/account/security/*`: the account security page.
//!
//! Every route accepts either an app's bearer session or the web session
//! cookie; cookie writes also need the exact `Origin` and the CSRF header
//! (see [`super::web_session_handlers::cloud_or_web_session_middleware`]).
//! Changes are charged to a per-account budget and recorded as audit events.
//! Errors never say whether another account uses an email address.

use super::*;
use crate::auth::rate_limit::{ACCOUNT_SECURITY_CHANGE_LIMIT, ACCOUNT_SECURITY_PROOF_LIMIT};

mod email_change;
mod overview;
mod password;
mod proof;
mod providers;
mod sessions;
#[cfg(test)]
mod tests;

pub(super) fn routes() -> Router<Arc<ServerState>> {
    const BASE: &str = "/v1/cloud/account/security";
    Router::new()
        .route(BASE, get(overview::account_security))
        .route(
            &format!("{BASE}/sessions/revoke-others"),
            post(sessions::revoke_other_sessions),
        )
        .route(
            &format!("{BASE}/sessions/:session_id/revoke"),
            post(sessions::revoke_session_by_id),
        )
        .route(&format!("{BASE}/password"), post(password::set_password))
        .route(
            &format!("{BASE}/password/code"),
            post(proof::send_reauthentication_code),
        )
        .route(
            &format!("{BASE}/email/change"),
            post(email_change::start_email_change),
        )
        .route(
            &format!("{BASE}/email/change/verify"),
            post(email_change::verify_email_change),
        )
        .route(
            &format!("{BASE}/providers/:provider"),
            delete(providers::unlink_provider),
        )
}

/// The request context every change needs.
pub(super) struct Caller<'a> {
    pub(super) state: &'a ServerState,
    pub(super) rate_limiter: &'a CloudRateLimiter,
    pub(super) session: &'a CloudSession,
}

impl Caller<'_> {
    /// Charges the client address and the account's change budget.
    pub(super) async fn charge_change(
        &self,
        headers: &HeaderMap,
        connect_info: Option<&ConnectInfo<SocketAddr>>,
    ) -> Result<(), Box<Response>> {
        if let RateLimitDecision::Limited { retry_after } = self
            .rate_limiter
            .observe_ip(client_ip(headers, connect_info))
            .await
        {
            return Err(Box::new(limited_response(retry_after)));
        }
        self.charge(ACCOUNT_SECURITY_CHANGE_LIMIT).await
    }

    /// Charges one proof: a password check, a code sent, or a code guess.
    pub(super) async fn charge_proof(&self) -> Result<(), Box<Response>> {
        self.charge(ACCOUNT_SECURITY_PROOF_LIMIT).await
    }

    async fn charge(
        &self,
        limit: crate::auth::rate_limit::AccountActionLimit,
    ) -> Result<(), Box<Response>> {
        match self
            .rate_limiter
            .observe_account_limit(limit, &self.session.account_id)
            .await
        {
            RateLimitDecision::Limited { retry_after } => {
                Err(Box::new(limited_response(retry_after)))
            }
            RateLimitDecision::Allowed => Ok(()),
        }
    }

    pub(super) fn pool(&self) -> &PgPool {
        self.state.db_pool()
    }
}

/// The sign-in facts of an account that security changes depend on.
pub(super) struct SecurityAccount {
    pub(super) primary_email: Option<String>,
    pub(super) email_verified: bool,
    pub(super) password_hash: Option<String>,
    pub(super) password_updated_at: Option<String>,
}

impl SecurityAccount {
    /// The normalized primary email, if the account has one.
    pub(super) fn email(&self) -> Option<String> {
        self.primary_email
            .as_deref()
            .map(str::trim)
            .filter(|email| !email.is_empty())
            .map(str::to_ascii_lowercase)
    }
}

const SECURITY_ACCOUNT_COLUMNS: &str =
    "primary_email, primary_email_verified_at IS NOT NULL, password_hash, password_updated_at";

type SecurityAccountRow = (Option<String>, bool, Option<String>, Option<String>);

fn security_account(row: SecurityAccountRow) -> SecurityAccount {
    let (primary_email, email_verified, password_hash, password_updated_at) = row;
    SecurityAccount {
        primary_email,
        email_verified,
        password_hash,
        password_updated_at,
    }
}

pub(super) async fn load_account(
    pool: &PgPool,
    account_id: &str,
) -> Result<SecurityAccount, Box<Response>> {
    let row: Option<SecurityAccountRow> = query_as(&format!(
        "SELECT {SECURITY_ACCOUNT_COLUMNS} FROM cloud_accounts WHERE account_id = $1"
    ))
    .bind(account_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| server_error())?;
    row.map(security_account).ok_or_else(server_error)
}

/// The account row, locked for the rest of the transaction.
pub(super) async fn lock_account(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
) -> Result<SecurityAccount, Box<Response>> {
    let row: Option<SecurityAccountRow> = query_as(&format!(
        "SELECT {SECURITY_ACCOUNT_COLUMNS} FROM cloud_accounts WHERE account_id = $1 FOR UPDATE"
    ))
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| server_error())?;
    row.map(security_account).ok_or_else(server_error)
}

pub(super) fn server_error() -> Box<Response> {
    boxed_err(
        "server_error",
        "Something went wrong. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

pub(super) fn email_unavailable() -> Response {
    err(
        "email_delivery_unavailable",
        "Email codes are temporarily unavailable. Try again later.",
        StatusCode::SERVICE_UNAVAILABLE,
    )
}

/// Records an audit event inside the change's transaction.
pub(super) async fn audit_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    session: &CloudSession,
    event_type: &str,
    metadata: serde_json::Value,
) -> Result<(), Box<Response>> {
    super::device_operation_support::write_device_audit(
        tx,
        &session.account_id,
        &session.device_id,
        event_type,
        metadata,
    )
    .await
    .map_err(|_| server_error())
}

/// Commits a transaction that recorded a failed code guess, then returns
/// the code error.
pub(super) async fn commit_failed_code(
    tx: sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    error: crate::auth::signup_email::SignupCodeError,
) -> Response {
    if tx.commit().await.is_err() {
        return *server_error();
    }
    match error {
        crate::auth::signup_email::SignupCodeError::Unavailable => email_unavailable(),
        error => super::signup_email_handlers::signup_code_error(error),
    }
}
