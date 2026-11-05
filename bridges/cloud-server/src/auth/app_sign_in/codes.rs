//! Single-use authorization codes bound to a client, redirect URI, PKCE
//! challenge and account. Only a SHA-256 hash of each code is stored.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

pub const AUTHORIZATION_CODE_PREFIX: &str = "kordi_ac_";
/// Lifetime of a code returned to the app through its redirect URI.
pub const REDIRECT_CODE_LIFETIME_SECS: i64 = 60;
/// Lifetime of a code the browser shows for the user to paste into the app.
/// The paste path is a last resort, so it is no longer lived than a redirect.
pub const DISPLAY_CODE_LIFETIME_SECS: i64 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeDelivery {
    Redirect,
    Display,
}

impl CodeDelivery {
    fn as_str(self) -> &'static str {
        match self {
            Self::Redirect => "redirect",
            Self::Display => "display",
        }
    }

    pub fn lifetime(self) -> Duration {
        match self {
            Self::Redirect => Duration::seconds(REDIRECT_CODE_LIFETIME_SECS),
            Self::Display => Duration::seconds(DISPLAY_CODE_LIFETIME_SECS),
        }
    }
}

/// A validated authorization request: the client is registered, the
/// redirect URI is one of its URIs, and the challenge is an S256 value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizationGrant {
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedCode {
    pub code: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

/// The stored binding of a code that an exchange just presented.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresentedCode {
    pub account_id: String,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub expires_at: DateTime<Utc>,
    /// The code had already been presented before this exchange.
    pub already_used: bool,
    /// The sign-in an earlier successful exchange started.
    pub sign_in_id: Option<String>,
}

pub fn hash_code(code: &str) -> String {
    hex::encode(Sha256::digest(code.as_bytes()))
}

/// Whether `challenge` has the shape of a base64url SHA-256 digest.
pub fn is_s256_challenge(challenge: &str) -> bool {
    challenge.len() == 43
        && challenge
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Whether `verifier` satisfies RFC 7636 and hashes to `challenge`.
pub fn verifier_matches_challenge(verifier: &str, challenge: &str) -> bool {
    let well_formed = (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte));
    well_formed && URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) == challenge
}

fn random_code() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!(
        "{AUTHORIZATION_CODE_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(bytes)
    )
}

pub async fn issue_code(
    pool: &PgPool,
    account_id: &str,
    grant: &AuthorizationGrant,
    delivery: CodeDelivery,
) -> Result<IssuedCode, sqlx_core::Error> {
    let now = Utc::now();
    // Codes are kept a day after expiry so a late replay still revokes the
    // sign-in it started, then pruned here.
    query("DELETE FROM cloud_app_authorization_codes WHERE expires_at < $1")
        .bind(now - Duration::days(1))
        .execute(pool)
        .await?;
    let code = random_code();
    let expires_at = now + delivery.lifetime();
    query(
        "INSERT INTO cloud_app_authorization_codes \
         (code_hash, account_id, client_id, redirect_uri, code_challenge, delivery, \
          created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(hash_code(&code))
    .bind(account_id)
    .bind(&grant.client_id)
    .bind(&grant.redirect_uri)
    .bind(&grant.code_challenge)
    .bind(delivery.as_str())
    .bind(now)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(IssuedCode {
        code,
        issued_at: now,
        expires_at,
    })
}

/// Mark a code used and return its binding. The first presentation consumes
/// the code whether or not the rest of the exchange succeeds, so a wrong
/// verifier cannot be retried against the same code.
pub async fn present_code(
    transaction: &mut Transaction<'_, Postgres>,
    code: &str,
) -> Result<Option<PresentedCode>, sqlx_core::Error> {
    if !code.starts_with(AUTHORIZATION_CODE_PREFIX) {
        return Ok(None);
    }
    let code_hash = hash_code(code);
    type Row = (
        String,
        String,
        String,
        String,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
        Option<String>,
    );
    let row: Option<Row> = query_as(
        "SELECT account_id, client_id, redirect_uri, code_challenge, expires_at, consumed_at, \
                sign_in_id \
         FROM cloud_app_authorization_codes WHERE code_hash = $1 FOR UPDATE",
    )
    .bind(&code_hash)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((
        account_id,
        client_id,
        redirect_uri,
        code_challenge,
        expires_at,
        consumed_at,
        sign_in_id,
    )) = row
    else {
        return Ok(None);
    };
    if consumed_at.is_none() {
        query("UPDATE cloud_app_authorization_codes SET consumed_at = $1 WHERE code_hash = $2")
            .bind(Utc::now())
            .bind(&code_hash)
            .execute(&mut **transaction)
            .await?;
    }
    Ok(Some(PresentedCode {
        account_id,
        client_id,
        redirect_uri,
        code_challenge,
        expires_at,
        already_used: consumed_at.is_some(),
        sign_in_id,
    }))
}

/// Record the sign-in a code started, so a replay of the code can revoke it.
pub async fn link_code_to_sign_in(
    transaction: &mut Transaction<'_, Postgres>,
    code: &str,
    sign_in_id: &str,
) -> Result<(), sqlx_core::Error> {
    query("UPDATE cloud_app_authorization_codes SET sign_in_id = $1 WHERE code_hash = $2")
        .bind(sign_in_id)
        .bind(hash_code(code))
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VERIFIER: &str = "synthetic-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";

    #[test]
    fn s256_verifier_matches_its_challenge_only() {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(VERIFIER.as_bytes()));
        assert!(is_s256_challenge(&challenge));
        assert!(verifier_matches_challenge(VERIFIER, &challenge));
        assert!(!verifier_matches_challenge(&VERIFIER[1..], &challenge));
        assert!(!verifier_matches_challenge(&challenge, &challenge));
        assert!(!is_s256_challenge("plain-challenge"));
        assert!(!is_s256_challenge(&format!("{}=", &challenge[..42])));
    }

    #[test]
    fn malformed_verifiers_are_rejected() {
        let short = "a".repeat(42);
        let long = "a".repeat(129);
        let spaced = format!("{} ", "a".repeat(43));
        for verifier in [short, long, spaced] {
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            assert!(!verifier_matches_challenge(&verifier, &challenge));
        }
    }

    #[test]
    fn delivery_lifetimes_stay_short() {
        assert_eq!(CodeDelivery::Redirect.lifetime(), Duration::seconds(60));
        assert_eq!(CodeDelivery::Display.lifetime(), Duration::seconds(60));
        assert!(random_code().starts_with(AUTHORIZATION_CODE_PREFIX));
        assert_ne!(random_code(), random_code());
    }
}
