//! Which provider email a linked identity may be matched by.
//!
//! An identity is linked to an account once, by provider subject. Its email is
//! used as evidence (organization admission, proving the account's primary
//! email) only while it is the email the provider verified when the identity
//! was linked or last re-verified (`matching_email`). A provider email change
//! never moves the identity to another account: the link stays, the new email
//! is not used until the account proves it with a Kordi email code, and the
//! change is written to the account's security log.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_postgres::Postgres;

/// Security log event types written here.
pub(crate) const EMAIL_CHANGED_EVENT: &str = "auth.identity.email_changed";
pub(crate) const EMAIL_UNVERIFIED_EVENT: &str = "auth.identity.email_unverified";
pub(crate) const EMAIL_REVERIFIED_EVENT: &str = "auth.identity.email_reverified";

/// The identity row as stored before this sign-in. Emails are normalized
/// (trimmed, lowercase).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredIdentityEmail {
    pub email: Option<String>,
    pub email_verified: bool,
    pub matching_email: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct IdentityEmailUpdate {
    /// The email this identity may be matched by after this sign-in.
    pub matching_email: Option<String>,
    /// Whether this sign-in's provider email counts as verified evidence.
    pub evidence_verified: bool,
    /// Security log event for the account, if any.
    pub event: Option<&'static str>,
}

/// Decides what a sign-in's provider email means for an identity.
/// `stored` is `None` for an identity seen for the first time.
pub(crate) fn update_identity_email(
    stored: Option<&StoredIdentityEmail>,
    email: Option<&str>,
    email_verified: bool,
) -> IdentityEmailUpdate {
    let email = email.map(normalize).filter(|value| !value.is_empty());
    let verified = email_verified && email.is_some();
    let Some(stored) = stored else {
        return IdentityEmailUpdate {
            matching_email: email.clone().filter(|_| verified),
            evidence_verified: verified,
            event: None,
        };
    };
    let was_usable = stored.matching_email.is_some();
    if stored.email == email {
        if !verified {
            return IdentityEmailUpdate {
                matching_email: None,
                evidence_verified: false,
                event: (was_usable || stored.email_verified).then_some(EMAIL_UNVERIFIED_EVENT),
            };
        }
        // The same address, now verified: a pending re-verification (a
        // different matching email) stays pending; otherwise this address
        // becomes the one it is matched by.
        let matching_email = stored.matching_email.clone().or_else(|| email.clone());
        return IdentityEmailUpdate {
            evidence_verified: matching_email == email,
            matching_email,
            event: None,
        };
    }
    // The provider now reports another address (or none).
    let matching_email = stored.matching_email.clone().filter(|_| verified);
    IdentityEmailUpdate {
        evidence_verified: verified && matching_email == email,
        matching_email,
        event: Some(if verified || email.is_some() {
            EMAIL_CHANGED_EVENT
        } else {
            EMAIL_UNVERIFIED_EVENT
        }),
    }
}

pub(crate) fn normalize(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

/// After the account proved `email` with a Kordi email code: identities of
/// this account whose provider currently reports that verified address may
/// be matched by it again. Writes one security log event per identity.
pub(crate) async fn reverify_identity_emails(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    account_id: &str,
    email: &str,
) -> Result<(), sqlx_core::Error> {
    let email = normalize(email);
    let providers: Vec<(String,)> = sqlx_core::query_as::query_as(
        "UPDATE cloud_account_identities SET matching_email = $2 \
         WHERE account_id = $1 AND email_verified AND email IS NOT NULL \
           AND LOWER(TRIM(email)) = $2 \
           AND matching_email IS DISTINCT FROM $2 \
         RETURNING provider",
    )
    .bind(account_id)
    .bind(&email)
    .fetch_all(&mut **tx)
    .await?;
    for (provider,) in providers {
        write_security_event(tx, account_id, EMAIL_REVERIFIED_EVENT, &provider).await?;
    }
    Ok(())
}

/// Writes an identity email event to the account's security log. The
/// metadata names the provider only, never an email address.
pub(crate) async fn write_security_event(
    tx: &mut sqlx_core::transaction::Transaction<'_, Postgres>,
    account_id: &str,
    event_type: &str,
    provider: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, NULL, $3, $4, $5)",
    )
    .bind(format!("evt_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(event_type)
    .bind(serde_json::json!({ "provider": provider }).to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "identity_email_tests.rs"]
mod tests;
