//! Cloud session token issuance, lookup, and revocation.
//!
//! Tokens are opaque random 32-byte values, base64url-encoded with the
//! `kordi_cs_` prefix so they're distinguishable from the existing
//! `bridges_sk_` API keys. We only store the SHA-256 hash; the plaintext
//! is returned to the caller exactly once.

use std::fmt;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

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
    Db(rusqlite::Error),
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

impl From<rusqlite::Error> for SessionError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Db(value)
    }
}

fn random_token_plaintext() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!(
        "{}{}",
        SESSION_TOKEN_PREFIX,
        URL_SAFE_NO_PAD.encode(bytes)
    )
}

pub fn hash_session_token(plaintext: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(plaintext.as_bytes());
    hex::encode(hasher.finalize())
}

/// Issue a fresh session for `account_id` + `device_id`, expiring after
/// `lifetime_days`. Returns the plaintext token (caller must return to the
/// client and discard) and metadata.
pub fn issue_session(
    conn: &Connection,
    account_id: &str,
    device_id: &str,
    lifetime_days: i64,
) -> Result<IssuedSession, SessionError> {
    let plaintext = random_token_plaintext();
    let token_hash = hash_session_token(&plaintext);
    let now = Utc::now();
    let expires = now + Duration::days(lifetime_days.max(1));
    let token_id = format!("cs_{}", uuid::Uuid::new_v4().simple());

    conn.execute(
        "INSERT INTO cloud_refresh_tokens \
         (token_id, account_id, device_id, token_hash, created_at, expires_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            token_id,
            account_id,
            device_id,
            token_hash,
            now.to_rfc3339(),
            expires.to_rfc3339(),
        ],
    )?;

    Ok(IssuedSession {
        plaintext_token: plaintext,
        token_id,
        expires_at: expires,
    })
}

/// Look up an active session by its plaintext token. Returns `Ok(None)` for
/// "token does not match a live session" (expired, revoked, or absent).
pub fn lookup_session(
    conn: &Connection,
    plaintext_token: &str,
) -> Result<Option<CloudSessionRow>, SessionError> {
    if !plaintext_token.starts_with(SESSION_TOKEN_PREFIX) {
        return Ok(None);
    }
    let token_hash = hash_session_token(plaintext_token);
    let now = Utc::now();

    let row = conn
        .query_row(
            "SELECT token_id, account_id, device_id, expires_at \
             FROM cloud_refresh_tokens \
             WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2",
            rusqlite::params![token_hash, now.to_rfc3339()],
            |row| {
                Ok(CloudSessionRow {
                    token_id: row.get(0)?,
                    account_id: row.get(1)?,
                    device_id: row.get(2)?,
                    expires_at: parse_rfc3339(row.get::<_, String>(3)?),
                })
            },
        )
        .optional()?;

    Ok(row)
}

/// Mark a session as revoked. Idempotent: revoking an already-revoked token is a no-op.
pub fn revoke_session(conn: &Connection, token_id: &str) -> Result<(), SessionError> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE cloud_refresh_tokens SET revoked_at = ?1 \
         WHERE token_id = ?2 AND revoked_at IS NULL",
        rusqlite::params![now, token_id],
    )?;
    Ok(())
}

/// Slide a session's `expires_at` forward by `lifetime_days`. Used by `/me`
/// to keep active sessions fresh without a separate refresh endpoint.
pub fn bump_expiry(
    conn: &Connection,
    token_id: &str,
    lifetime_days: i64,
) -> Result<(), SessionError> {
    let new_expiry = (Utc::now() + Duration::days(lifetime_days.max(1))).to_rfc3339();
    conn.execute(
        "UPDATE cloud_refresh_tokens SET expires_at = ?1 \
         WHERE token_id = ?2 AND revoked_at IS NULL",
        rusqlite::params![new_expiry, token_id],
    )?;
    Ok(())
}

fn parse_rfc3339(value: String) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::serve::cloud_auth::{
        register_cloud_device, upsert_account_identity, AccountIdentityUpsert,
        CloudDeviceRegistration, OAuthProviderId,
    };

    fn open_test_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        super::super::init_server_db(&conn).expect("init db");
        conn
    }

    fn seed_account_and_device(conn: &Connection) -> (String, String) {
        let account = upsert_account_identity(
            conn,
            AccountIdentityUpsert {
                provider: OAuthProviderId::GitHub,
                provider_subject: "session-tester".to_string(),
                provider_username: Some("session-tester".to_string()),
                display_name: Some("Session Tester".to_string()),
                email: Some("session-tester@example.com".to_string()),
                email_verified: true,
                avatar_url: None,
            },
        )
        .expect("seed account");

        let device = register_cloud_device(
            conn,
            CloudDeviceRegistration {
                account_id: account.account_id.clone(),
                device_name: Some("test-device".to_string()),
                device_public_key: "deadbeef".to_string(),
            },
        )
        .expect("register device");

        (account.account_id, device.device_id)
    }

    #[test]
    fn issue_and_lookup_round_trip() {
        let conn = open_test_db();
        let (account_id, device_id) = seed_account_and_device(&conn);

        let issued = issue_session(&conn, &account_id, &device_id, 1).expect("issue");
        let row = lookup_session(&conn, &issued.plaintext_token)
            .expect("lookup")
            .expect("session present");

        assert_eq!(row.account_id, account_id);
        assert_eq!(row.device_id, device_id);
        assert_eq!(row.token_id, issued.token_id);
    }

    #[test]
    fn lookup_misses_unknown_token() {
        let conn = open_test_db();
        seed_account_and_device(&conn);
        let row = lookup_session(&conn, "kordi_cs_unknown").expect("lookup");
        assert!(row.is_none());
    }

    #[test]
    fn lookup_misses_revoked_token() {
        let conn = open_test_db();
        let (account_id, device_id) = seed_account_and_device(&conn);
        let issued = issue_session(&conn, &account_id, &device_id, 1).expect("issue");

        revoke_session(&conn, &issued.token_id).expect("revoke");
        assert!(lookup_session(&conn, &issued.plaintext_token).expect("lookup").is_none());
    }

    #[test]
    fn lookup_misses_token_with_wrong_prefix() {
        let conn = open_test_db();
        let (account_id, device_id) = seed_account_and_device(&conn);
        let _issued = issue_session(&conn, &account_id, &device_id, 1).expect("issue");
        // Even the right hash bytes shouldn't match if the prefix is wrong.
        assert!(lookup_session(&conn, "different_prefix").expect("lookup").is_none());
    }

    #[test]
    fn bump_expiry_extends_window() {
        let conn = open_test_db();
        let (account_id, device_id) = seed_account_and_device(&conn);
        let issued = issue_session(&conn, &account_id, &device_id, 1).expect("issue");
        bump_expiry(&conn, &issued.token_id, 30).expect("bump");

        let row = lookup_session(&conn, &issued.plaintext_token)
            .expect("lookup")
            .expect("present");
        assert!(row.expires_at > issued.expires_at);
    }

}
