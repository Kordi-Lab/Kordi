//! Sign-ins, rotating refresh tokens, and the access tokens they issue.
//!
//! An access token is an ordinary `kordi_cs_` session row, so the existing
//! session middleware, realtime tickets, and device checks apply unchanged.
//! It carries its sign-in and keeps a fixed, short expiry. A refresh token
//! is used once. Presenting a rotated refresh token again within a short
//! grace period returns the same successor, so a lost response or a
//! concurrent refresh does not sign the app out; any later reuse revokes the
//! whole sign-in, including every access token it issued.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use super::codes::hash_code as hash_token;
use crate::auth::session::{hash_session_token, random_token_plaintext};

mod refresh;

pub use refresh::{rotate_refresh_token, REFRESH_REUSE_GRACE_SECS};

pub const REFRESH_TOKEN_PREFIX: &str = "kordi_rt_";
pub const ACCESS_TOKEN_LIFETIME_SECS: i64 = 60 * 60;
pub const REFRESH_TOKEN_LIFETIME_DAYS: i64 = 30;

/// Why a sign-in was revoked, recorded for audit.
pub mod revoked_reason {
    pub const SIGN_OUT: &str = "sign_out";
    pub const USER_REVOKED: &str = "user_revoked";
    pub const REFRESH_TOKEN_REUSE: &str = "refresh_token_reuse";
    pub const AUTHORIZATION_CODE_REUSE: &str = "authorization_code_reuse";
    pub const DEVICE_REVOKED: &str = "device_revoked";
    pub const ACCOUNT_NOT_ADMITTED: &str = "account_not_admitted";
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IssuedTokens {
    pub sign_in_id: String,
    pub account_id: String,
    pub device_id: String,
    pub access_token: String,
    pub access_token_id: String,
    pub access_expires_at: DateTime<Utc>,
    pub refresh_token: String,
    pub refresh_expires_at: DateTime<Utc>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefreshOutcome {
    Issued(IssuedTokens),
    /// Unknown, expired, revoked, or presented by a different client.
    Invalid,
    /// A rotated token was presented again; the sign-in is now revoked.
    ReuseDetected {
        account_id: String,
    },
}

fn random_refresh_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{REFRESH_TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// Start a sign-in for `client_id` on an authorized device and issue its
/// first token pair.
pub async fn start_sign_in(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    device_id: &str,
    client_id: &str,
) -> Result<IssuedTokens, sqlx_core::Error> {
    let sign_in_id = format!("asi_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now();
    query(
        "INSERT INTO cloud_app_sign_ins \
         (sign_in_id, account_id, device_id, client_id, created_at, last_refreshed_at) \
         VALUES ($1, $2, $3, $4, $5, $5)",
    )
    .bind(&sign_in_id)
    .bind(account_id)
    .bind(device_id)
    .bind(client_id)
    .bind(now)
    .execute(&mut **transaction)
    .await?;
    issue_pair(transaction, &sign_in_id, account_id, device_id, None).await
}

/// The plaintext refresh and access tokens of a new pair. Random for a new
/// sign-in; derived from the presented refresh token on rotation, so a
/// retried refresh can return the same pair.
struct PairTokens {
    refresh_token: String,
    access_token: String,
}

async fn issue_pair(
    transaction: &mut Transaction<'_, Postgres>,
    sign_in_id: &str,
    account_id: &str,
    device_id: &str,
    tokens: Option<PairTokens>,
) -> Result<IssuedTokens, sqlx_core::Error> {
    let now = Utc::now();
    let tokens = tokens.unwrap_or_else(|| PairTokens {
        refresh_token: random_refresh_token(),
        access_token: random_token_plaintext(),
    });
    let access_token = tokens.access_token;
    let access_token_id = format!("cs_{}", uuid::Uuid::new_v4().simple());
    let access_expires_at = now + Duration::seconds(ACCESS_TOKEN_LIFETIME_SECS);
    insert_access_token(
        transaction,
        &access_token_id,
        sign_in_id,
        account_id,
        device_id,
        &access_token,
        now,
        access_expires_at,
    )
    .await?;

    let refresh_token = tokens.refresh_token;
    let refresh_expires_at = now + Duration::days(REFRESH_TOKEN_LIFETIME_DAYS);
    query(
        "INSERT INTO cloud_app_refresh_tokens (token_hash, sign_in_id, created_at, expires_at) \
         VALUES ($1, $2, $3, $4)",
    )
    .bind(hash_token(&refresh_token))
    .bind(sign_in_id)
    .bind(now)
    .bind(refresh_expires_at)
    .execute(&mut **transaction)
    .await?;

    Ok(IssuedTokens {
        sign_in_id: sign_in_id.to_string(),
        account_id: account_id.to_string(),
        device_id: device_id.to_string(),
        access_token,
        access_token_id,
        access_expires_at,
        refresh_token,
        refresh_expires_at,
    })
}

/// Inserts an access token of `sign_in_id`. It takes the organization the
/// sign-in last switched to, so a refresh keeps the app's organization.
#[allow(clippy::too_many_arguments)]
async fn insert_access_token(
    transaction: &mut Transaction<'_, Postgres>,
    access_token_id: &str,
    sign_in_id: &str,
    account_id: &str,
    device_id: &str,
    access_token: &str,
    now: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_refresh_tokens \
         (token_id, account_id, device_id, token_hash, created_at, expires_at, app_sign_in_id, \
          organization_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, \
                 (SELECT organization_id FROM cloud_app_sign_ins WHERE sign_in_id = $7))",
    )
    .bind(access_token_id)
    .bind(account_id)
    .bind(device_id)
    .bind(hash_session_token(access_token))
    .bind(now.to_rfc3339())
    .bind(expires_at.to_rfc3339())
    .bind(sign_in_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// An access token issued by an organization switch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwitchedAccessToken {
    pub access_token: String,
    pub access_token_id: String,
    pub access_expires_at: DateTime<Utc>,
}

/// Records `organization_id` on a live sign-in and issues it a new access
/// token there. The refresh token and the device stay as they are. Returns
/// `None` when the sign-in is revoked or belongs to another account or
/// device. The caller checks membership in the same transaction.
pub async fn switch_sign_in_organization(
    transaction: &mut Transaction<'_, Postgres>,
    sign_in_id: &str,
    account_id: &str,
    device_id: &str,
    organization_id: &str,
) -> Result<Option<SwitchedAccessToken>, sqlx_core::Error> {
    let switched = query(
        "UPDATE cloud_app_sign_ins SET organization_id = $1 \
         WHERE sign_in_id = $2 AND account_id = $3 AND device_id = $4 AND revoked_at IS NULL",
    )
    .bind(organization_id)
    .bind(sign_in_id)
    .bind(account_id)
    .bind(device_id)
    .execute(&mut **transaction)
    .await?
    .rows_affected()
        > 0;
    if !switched {
        return Ok(None);
    }
    let now = Utc::now();
    let access_token = random_token_plaintext();
    let access_token_id = format!("cs_{}", uuid::Uuid::new_v4().simple());
    let access_expires_at = now + Duration::seconds(ACCESS_TOKEN_LIFETIME_SECS);
    insert_access_token(
        transaction,
        &access_token_id,
        sign_in_id,
        account_id,
        device_id,
        &access_token,
        now,
        access_expires_at,
    )
    .await?;
    Ok(Some(SwitchedAccessToken {
        access_token,
        access_token_id,
        access_expires_at,
    }))
}

/// Revoke a sign-in and every access token it issued. Idempotent.
pub async fn revoke_sign_in_in_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    sign_in_id: &str,
    reason: &str,
) -> Result<bool, sqlx_core::Error> {
    let now = Utc::now();
    let revoked = query(
        "UPDATE cloud_app_sign_ins SET revoked_at = $1, revoked_reason = $2 \
         WHERE sign_in_id = $3 AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(reason)
    .bind(sign_in_id)
    .execute(&mut **transaction)
    .await?
    .rows_affected()
        > 0;
    query(
        "UPDATE cloud_refresh_tokens SET revoked_at = $1 \
         WHERE app_sign_in_id = $2 AND revoked_at IS NULL",
    )
    .bind(now.to_rfc3339())
    .bind(sign_in_id)
    .execute(&mut **transaction)
    .await?;
    Ok(revoked)
}

pub async fn revoke_sign_in(
    pool: &PgPool,
    sign_in_id: &str,
    reason: &str,
) -> Result<bool, sqlx_core::Error> {
    let mut transaction = pool.begin().await?;
    let revoked = revoke_sign_in_in_transaction(&mut transaction, sign_in_id, reason).await?;
    transaction.commit().await?;
    Ok(revoked)
}

/// Revoke every sign-in on the given devices of an account, in the same
/// transaction that revokes the devices. Re-authorizing a device clears its
/// `revoked_at` but cannot bring these sign-ins back; refresh also refuses
/// any sign-in created before the device's `last_revoked_at`, which a
/// trigger records on every revocation.
pub async fn revoke_device_sign_ins(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    device_ids: &[String],
) -> Result<(), sqlx_core::Error> {
    if device_ids.is_empty() {
        return Ok(());
    }
    let sign_ins: Vec<(String,)> = query_as(
        "SELECT sign_in_id FROM cloud_app_sign_ins \
         WHERE account_id = $1 AND device_id = ANY($2) AND revoked_at IS NULL",
    )
    .bind(account_id)
    .bind(device_ids)
    .fetch_all(&mut **transaction)
    .await?;
    for (sign_in_id,) in sign_ins {
        revoke_sign_in_in_transaction(transaction, &sign_in_id, revoked_reason::DEVICE_REVOKED)
            .await?;
    }
    Ok(())
}

/// The sign-in and client that issued a refresh token or access token, if
/// the token belongs to one.
pub async fn sign_in_for_token(
    pool: &PgPool,
    token: &str,
) -> Result<Option<(String, String)>, sqlx_core::Error> {
    if token.starts_with(REFRESH_TOKEN_PREFIX) {
        return query_as(
            "SELECT sign_in.sign_in_id, sign_in.client_id \
             FROM cloud_app_refresh_tokens token \
             JOIN cloud_app_sign_ins sign_in ON sign_in.sign_in_id = token.sign_in_id \
             WHERE token.token_hash = $1",
        )
        .bind(hash_token(token))
        .fetch_optional(pool)
        .await;
    }
    query_as(
        "SELECT sign_in.sign_in_id, sign_in.client_id \
         FROM cloud_refresh_tokens session \
         JOIN cloud_app_sign_ins sign_in ON sign_in.sign_in_id = session.app_sign_in_id \
         WHERE session.token_hash = $1",
    )
    .bind(hash_session_token(token))
    .fetch_optional(pool)
    .await
}

/// The sign-in that issued the session `token_id`, if any.
pub async fn sign_in_for_session(
    pool: &PgPool,
    token_id: &str,
) -> Result<Option<String>, sqlx_core::Error> {
    let row: Option<(Option<String>,)> =
        query_as("SELECT app_sign_in_id FROM cloud_refresh_tokens WHERE token_id = $1")
            .bind(token_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(sign_in_id,)| sign_in_id))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveSignIn {
    pub sign_in_id: String,
    pub client_id: String,
    pub device_id: String,
    pub device_name: Option<String>,
    pub device_platform: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_refreshed_at: DateTime<Utc>,
}

/// Active sign-ins of an account on devices that are still authorized,
/// most recently refreshed first.
pub async fn list_active_sign_ins(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<ActiveSignIn>, sqlx_core::Error> {
    type Row = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        DateTime<Utc>,
        DateTime<Utc>,
    );
    let rows: Vec<Row> = query_as(
        "SELECT sign_in.sign_in_id, sign_in.client_id, sign_in.device_id, device.device_name, \
                device.device_platform, sign_in.created_at, sign_in.last_refreshed_at \
         FROM cloud_app_sign_ins sign_in \
         JOIN cloud_devices device ON device.device_id = sign_in.device_id \
         WHERE sign_in.account_id = $1 AND sign_in.revoked_at IS NULL \
           AND device.revoked_at IS NULL \
           AND EXISTS (SELECT 1 FROM cloud_app_refresh_tokens token \
                       WHERE token.sign_in_id = sign_in.sign_in_id \
                         AND token.rotated_at IS NULL AND token.expires_at > $2) \
         ORDER BY sign_in.last_refreshed_at DESC, sign_in.sign_in_id",
    )
    .bind(account_id)
    .bind(Utc::now())
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(sign_in_id, client_id, device_id, device_name, device_platform, created_at, last)| {
                ActiveSignIn {
                    sign_in_id,
                    client_id,
                    device_id,
                    device_name,
                    device_platform,
                    created_at,
                    last_refreshed_at: last,
                }
            },
        )
        .collect())
}

/// Revoke one of an account's sign-ins. Returns false when the sign-in does
/// not belong to the account or was already revoked.
pub async fn revoke_account_sign_in(
    pool: &PgPool,
    account_id: &str,
    sign_in_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let mut transaction = pool.begin().await?;
    let owned: Option<(String,)> = query_as(
        "SELECT sign_in_id FROM cloud_app_sign_ins \
         WHERE sign_in_id = $1 AND account_id = $2 AND revoked_at IS NULL FOR UPDATE",
    )
    .bind(sign_in_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?;
    if owned.is_none() {
        return Ok(false);
    }
    let revoked =
        revoke_sign_in_in_transaction(&mut transaction, sign_in_id, revoked_reason::USER_REVOKED)
            .await?;
    transaction.commit().await?;
    Ok(revoked)
}
