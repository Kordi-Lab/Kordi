//! Entry points the sign-in paths call after the server has verified an
//! identity. They never fail a sign-in: an error is logged and admission is
//! simply not granted, so a fault cannot admit anyone.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::claim::SignInEvidence;
use super::config::{OrganizationAdmission, SignInMethod};
use super::store::{apply_evidence, ensure_configured_admin};

/// Evaluates every configured organization for a completed sign-in.
pub async fn record_sign_in(
    pool: &PgPool,
    admission: &OrganizationAdmission,
    account_id: &str,
    evidence: SignInEvidence<'_>,
) {
    for org in &admission.organizations {
        let verified_email = evidence.email.filter(|_| evidence.email_verified);
        if let Err(error) = ensure_configured_admin(pool, org, account_id, verified_email).await {
            eprintln!(
                "[organization admission] admin check for {}: {error}",
                org.id
            );
        }
        if let Err(error) = apply_evidence(pool, org, account_id, &evidence).await {
            eprintln!("[organization admission] sign-in for {}: {error}", org.id);
        }
    }
}

/// After an inbox code verified the account's primary email: at sign-up
/// with a code or when an existing account verifies its email.
pub async fn record_verified_primary_email(
    pool: &PgPool,
    admission: &OrganizationAdmission,
    account_id: &str,
) {
    if admission.is_empty() {
        return;
    }
    let row: Result<Option<(String,)>, _> = query_as(
        "SELECT lower(primary_email) FROM cloud_accounts \
         WHERE account_id = $1 AND primary_email IS NOT NULL \
           AND primary_email_verified_at IS NOT NULL",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await;
    let email = match row {
        Ok(Some((email,))) => email,
        Ok(None) => return,
        Err(error) => {
            eprintln!("[organization admission] load verified email: {error}");
            return;
        }
    };
    let evidence = SignInEvidence {
        method: SignInMethod::EmailCode,
        email: Some(&email),
        email_verified: true,
        hosted_domain: None,
    };
    record_sign_in(pool, admission, account_id, evidence).await;
}
