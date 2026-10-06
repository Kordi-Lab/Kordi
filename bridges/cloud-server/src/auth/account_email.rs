//! Verifying the signed-in account's primary email with an inbox code. This
//! lets accounts created before signup verification prove email ownership, so
//! provider sign-in may later link to them by email. Codes follow the signup
//! rules in [`crate::auth::signup_email`].

use chrono::Utc;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use crate::auth::signup_email::{
    consume_account_email_code, request_account_email_code, SignupCodeChallenge, SignupCodeError,
    SignupEmailService,
};

pub(crate) enum AccountEmailError {
    /// The account has no primary email to verify.
    Missing,
    AlreadyVerified,
    Code(SignupCodeError),
}

impl From<sqlx_core::Error> for AccountEmailError {
    fn from(_: sqlx_core::Error) -> Self {
        Self::Code(SignupCodeError::Database)
    }
}

impl From<SignupCodeError> for AccountEmailError {
    fn from(error: SignupCodeError) -> Self {
        match error {
            SignupCodeError::AlreadyVerified => Self::AlreadyVerified,
            error => Self::Code(error),
        }
    }
}

/// The normalized primary email that still needs verification.
fn unverified_email(row: Option<(Option<String>, bool)>) -> Result<String, AccountEmailError> {
    match row {
        Some((_, true)) => Err(AccountEmailError::AlreadyVerified),
        Some((Some(email), false)) if !email.trim().is_empty() => {
            Ok(email.trim().to_ascii_lowercase())
        }
        _ => Err(AccountEmailError::Missing),
    }
}

/// The account's normalized primary email when it still needs verification.
/// This is an unlocked read for cheap request checks; sending and verifying
/// re-check the account under a row lock.
pub(crate) async fn account_email_to_verify(
    pool: &PgPool,
    account_id: &str,
) -> Result<String, AccountEmailError> {
    let row: Option<(Option<String>, bool)> = query_as(
        "SELECT primary_email, primary_email_verified_at IS NOT NULL \
         FROM cloud_accounts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    unverified_email(row)
}

/// Sends a code to `email`, the account's primary email as returned by
/// [`account_email_to_verify`]. Fails with `AlreadyVerified` when the account
/// was verified in the meantime.
pub(crate) async fn send_account_email_code(
    pool: &PgPool,
    service: &SignupEmailService,
    account_id: &str,
    email: &str,
) -> Result<SignupCodeChallenge, AccountEmailError> {
    Ok(request_account_email_code(pool, service, account_id, email).await?)
}

/// Consumes the code and marks the primary email verified in one transaction.
/// Failed guesses are committed so they count against the code.
pub(crate) async fn verify_account_email(
    pool: &PgPool,
    service: &SignupEmailService,
    account_id: &str,
    verification_id: &str,
    verification_code: &str,
) -> Result<(), AccountEmailError> {
    let mut tx = pool.begin().await?;
    // The account row lock serializes concurrent confirmations, code sends,
    // and primary email changes against this one.
    let row: Option<(Option<String>, bool)> = query_as(
        "SELECT primary_email, primary_email_verified_at IS NOT NULL \
         FROM cloud_accounts WHERE account_id = $1 FOR UPDATE",
    )
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await?;
    let email = unverified_email(row)?;
    if let Err(error) = consume_account_email_code(
        &mut tx,
        service,
        account_id,
        &email,
        verification_id,
        verification_code,
    )
    .await
    {
        tx.commit().await?;
        return Err(error.into());
    }
    query(
        "UPDATE cloud_accounts SET primary_email_verified_at = $2 \
         WHERE account_id = $1 AND primary_email_verified_at IS NULL",
    )
    .bind(account_id)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
