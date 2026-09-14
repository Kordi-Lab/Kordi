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
pub const SESSION_INACTIVITY_LIMIT_DAYS: i64 = 7;

pub fn session_inactivity_cutoff(now: DateTime<Utc>) -> DateTime<Utc> {
    now - Duration::days(SESSION_INACTIVITY_LIMIT_DAYS)
}

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
    let inactivity_cutoff = session_inactivity_cutoff(now);

    let row: Option<(String, String, String, String)> = query_as(
        "SELECT token.token_id, token.account_id, token.device_id, token.expires_at \
         FROM cloud_refresh_tokens token \
         JOIN cloud_devices device ON device.device_id = token.device_id \
         WHERE token.token_hash = $1 AND token.revoked_at IS NULL AND token.expires_at > $2 \
           AND device.account_id = token.account_id AND device.revoked_at IS NULL \
           AND device.last_seen_at > $3",
    )
    .bind(&token_hash)
    .bind(now.to_rfc3339())
    .bind(inactivity_cutoff.to_rfc3339())
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(token_id, account_id, device_id, expires_at)| CloudSessionRow {
            token_id,
            account_id,
            device_id,
            expires_at: parse_rfc3339(expires_at),
        },
    ))
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
        "UPDATE cloud_refresh_tokens token SET expires_at = $1 \
         FROM cloud_devices device \
         WHERE token.token_id = $2 AND token.revoked_at IS NULL \
           AND device.device_id = token.device_id AND device.account_id = token.account_id \
           AND device.revoked_at IS NULL",
    )
    .bind(&new_expiry)
    .bind(token_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Check the PostgreSQL authorization source of truth for a long-lived
/// connection. This is deliberately cheap and can be used at heartbeat
/// boundaries even when the low-latency broker invalidation is unavailable.
pub async fn device_is_active(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
) -> Result<bool, SessionError> {
    let inactivity_cutoff = session_inactivity_cutoff(Utc::now()).to_rfc3339();
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_devices \
         WHERE account_id = $1 AND device_id = $2 AND revoked_at IS NULL \
           AND last_seen_at > $3",
    )
    .bind(account_id)
    .bind(device_id)
    .bind(inactivity_cutoff)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Refresh non-sensitive activity metadata at most once per minute.
pub async fn touch_device_activity(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
) -> Result<(), SessionError> {
    let now = Utc::now();
    let cutoff = now - Duration::minutes(1);
    query(
        "UPDATE cloud_devices SET last_seen_at = $1 \
         WHERE account_id = $2 AND device_id = $3 AND revoked_at IS NULL \
           AND last_seen_at < $4",
    )
    .bind(now.to_rfc3339())
    .bind(account_id)
    .bind(device_id)
    .bind(cutoff.to_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

fn parse_rfc3339(value: String) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}
