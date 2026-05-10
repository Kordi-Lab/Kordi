//! Cloud session token issuance, lookup, and revocation (Postgres-backed).
//!
//! Tokens are opaque random 32-byte values, base64url-encoded with the
//! `kordi_cs_` prefix. We only store the SHA-256 hash; the plaintext is
//! returned to the caller exactly once.

use std::fmt;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

pub const SESSION_TOKEN_PREFIX: &str = "kordi_cs_";
pub const DEFAULT_SESSION_LIFETIME_DAYS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedSession {
    pub plaintext_token: String,
    pub token_id: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudSessionRow {
    pub token_id: String,
    pub account_id: String,
    pub device_id: String,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug)]
pub enum SessionError {
    Db(sqlx_core::Error),
    InvalidToken,
}

impl fmt::Display for SessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Db(err) => write!(f, "session db error: {err}"),
            Self::InvalidToken => write!(f, "session token is malformed"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<sqlx_core::Error> for SessionError {
    fn from(value: sqlx_core::Error) -> Self {
        Self::Db(value)
    }
}

fn random_token_plaintext() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{}{}", SESSION_TOKEN_PREFIX, URL_SAFE_NO_PAD.encode(bytes))
}

pub fn hash_session_token(plaintext: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(plaintext.as_bytes());
    hex::encode(hasher.finalize())
}

/// Issue a fresh session for `account_id` + `device_id`, expiring after
/// `lifetime_days`. Accepts any sqlx executor (Pool or Transaction) so
/// callers can inline session issuance into a larger transaction.
pub async fn issue_session<'e, E>(
    executor: E,
    account_id: &str,
    device_id: &str,
    lifetime_days: i64,
) -> Result<IssuedSession, SessionError>
where
    E: Executor<'e, Database = Postgres>,
{
    let plaintext = random_token_plaintext();
    let token_hash = hash_session_token(&plaintext);
    let now = Utc::now();
    let expires = now + Duration::days(lifetime_days.max(1));
    let token_id = format!("cs_{}", uuid::Uuid::new_v4().simple());

    query(
        "INSERT INTO cloud_refresh_tokens \
         (token_id, account_id, device_id, token_hash, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&token_id)
    .bind(account_id)
    .bind(device_id)
    .bind(&token_hash)
    .bind(now.to_rfc3339())
    .bind(expires.to_rfc3339())
    .execute(executor)
    .await?;

    Ok(IssuedSession {
        plaintext_token: plaintext,
        token_id,
        expires_at: expires,
    })
}

/// Look up an active session by its plaintext token. Returns `Ok(None)` for
/// "token does not match a live session" (expired, revoked, or absent).
pub async fn lookup_session(
    pool: &PgPool,
    plaintext_token: &str,
) -> Result<Option<CloudSessionRow>, SessionError> {
    if !plaintext_token.starts_with(SESSION_TOKEN_PREFIX) {
        return Ok(None);
    }
    let token_hash = hash_session_token(plaintext_token);
    let now = Utc::now();

    let row: Option<(String, String, String, String)> = query_as(
        "SELECT token_id, account_id, device_id, expires_at \
         FROM cloud_refresh_tokens \
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2",
    )
    .bind(&token_hash)
    .bind(now.to_rfc3339())
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(token_id, account_id, device_id, expires_at)| CloudSessionRow {
        token_id,
        account_id,
        device_id,
        expires_at: parse_rfc3339(expires_at),
    }))
}

/// Mark a session as revoked. Idempotent.
pub async fn revoke_session(pool: &PgPool, token_id: &str) -> Result<(), SessionError> {
    let now = Utc::now().to_rfc3339();
    query(
        "UPDATE cloud_refresh_tokens SET revoked_at = $1 \
         WHERE token_id = $2 AND revoked_at IS NULL",
    )
    .bind(&now)
    .bind(token_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Slide a session's `expires_at` forward by `lifetime_days`.
pub async fn bump_expiry(
    pool: &PgPool,
    token_id: &str,
    lifetime_days: i64,
) -> Result<(), SessionError> {
    let new_expiry = (Utc::now() + Duration::days(lifetime_days.max(1))).to_rfc3339();
    query(
        "UPDATE cloud_refresh_tokens SET expires_at = $1 \
         WHERE token_id = $2 AND revoked_at IS NULL",
    )
    .bind(&new_expiry)
    .bind(token_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn parse_rfc3339(value: String) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}
