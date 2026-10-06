//! Linking OAuth identities into existing accounts by email. An identity may
//! join an account by email only when both the provider and the account have
//! verified that email.

use super::*;

/// Stable code sent through the OAuth callback when the provider email belongs
/// to an existing account that must be signed in to directly.
pub(in crate::auth::routes) const OAUTH_EMAIL_REQUIRES_SIGN_IN: &str =
    "oauth_email_requires_sign_in";

#[derive(Debug)]
pub(in crate::auth::routes) enum OAuthLoginError {
    /// Another account already owns this email and the provider identity cannot
    /// be linked to it automatically: either that account's email ownership is
    /// unverified or the provider did not verify the email.
    ExistingEmailAccount {
        account_id: String,
        password_sign_in: bool,
    },
    Database(sqlx_core::Error),
}

impl From<sqlx_core::Error> for OAuthLoginError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Database(error)
    }
}

pub(in crate::auth::routes) fn existing_email_account_message(
    password_sign_in: bool,
) -> &'static str {
    if password_sign_in {
        "A Kordi account already uses this email. Sign in with your email and password."
    } else {
        "A Kordi account already uses this email. Sign in with the method you used to create it."
    }
}

/// Returns the account an OAuth identity may join by email, or refuses when
/// another account owns the email but its ownership has not been verified.
/// Only a provider-verified email may join an account whose own primary email
/// is verified; every other match must sign in to that account directly.
pub(super) async fn linkable_email_account(
    pool: &PgPool,
    email: &str,
    provider_email_verified: bool,
) -> Result<Option<String>, OAuthLoginError> {
    let row: Option<(String, Option<String>, bool)> = query_as(
        "SELECT account_id, primary_email_verified_at, password_hash IS NOT NULL \
         FROM cloud_accounts WHERE LOWER(primary_email) = $1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await?;
    match row {
        None => Ok(None),
        Some((account_id, Some(_), _)) if provider_email_verified => Ok(Some(account_id)),
        Some((account_id, _, password_sign_in)) => Err(OAuthLoginError::ExistingEmailAccount {
            account_id,
            password_sign_in,
        }),
    }
}

/// Records that the account's primary email was verified by an OAuth provider.
/// Only the matching primary email is marked; other accounts are untouched.
pub(super) async fn mark_primary_email_verified(
    transaction: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
    verified_email: &str,
    now: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_accounts SET primary_email_verified_at = $3 \
         WHERE account_id = $1 AND primary_email_verified_at IS NULL \
           AND primary_email IS NOT NULL AND LOWER(primary_email) = $2",
    )
    .bind(account_id)
    .bind(verified_email)
    .bind(now)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}
