//! Refresh token rotation with a short reuse grace period.
//!
//! Rotating a refresh token stores a random salt on the rotated row and
//! derives the successor pair from the presented token and that salt. Only
//! hashes are stored, so the successor can be recomputed only by someone who
//! presents the rotated token. Within [`REFRESH_REUSE_GRACE_SECS`] of the
//! rotation, and while the successor is unused, presenting the rotated token
//! again returns the same successor: a lost response or a concurrent refresh
//! then costs nothing. Any other reuse revokes the sign-in.

use super::*;

/// How long a rotated refresh token still returns its unused successor.
pub const REFRESH_REUSE_GRACE_SECS: i64 = 60;

fn derived_token(prefix: &str, label: &[u8], presented: &str, salt: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"kordi-app-refresh-successor\0");
    hasher.update(label);
    hasher.update(b"\0");
    hasher.update(presented.as_bytes());
    hasher.update(b"\0");
    hasher.update(salt.as_bytes());
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(hasher.finalize()))
}

fn successor_tokens(presented: &str, salt: &str) -> PairTokens {
    PairTokens {
        refresh_token: derived_token(REFRESH_TOKEN_PREFIX, b"refresh", presented, salt),
        access_token: derived_token(
            crate::auth::session::SESSION_TOKEN_PREFIX,
            b"access",
            presented,
            salt,
        ),
    }
}

fn random_salt() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

struct PresentedRefreshToken {
    sign_in_id: String,
    expires_at: DateTime<Utc>,
    rotated_at: Option<DateTime<Utc>>,
    successor_salt: Option<String>,
    successor_token_hash: Option<String>,
    client_id: String,
    account_id: String,
    device_id: String,
    sign_in_revoked: bool,
    /// The device is revoked now, or was revoked after this sign-in began.
    device_revoked: bool,
}

async fn load_presented(
    transaction: &mut Transaction<'_, Postgres>,
    token_hash: &str,
) -> Result<Option<PresentedRefreshToken>, sqlx_core::Error> {
    type Row = (
        String,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
        Option<String>,
        Option<String>,
        String,
        String,
        String,
        bool,
        bool,
    );
    let row: Option<Row> = query_as(
        "SELECT token.sign_in_id, token.expires_at, token.rotated_at, token.successor_salt, \
                token.successor_token_hash, sign_in.client_id, sign_in.account_id, \
                sign_in.device_id, sign_in.revoked_at IS NOT NULL, \
                device.revoked_at IS NOT NULL \
                  OR COALESCE(device.last_revoked_at >= sign_in.created_at, FALSE) \
         FROM cloud_app_refresh_tokens token \
         JOIN cloud_app_sign_ins sign_in ON sign_in.sign_in_id = token.sign_in_id \
         JOIN cloud_devices device ON device.device_id = sign_in.device_id \
         WHERE token.token_hash = $1 \
         FOR UPDATE OF token, sign_in",
    )
    .bind(token_hash)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.map(
        |(
            sign_in_id,
            expires_at,
            rotated_at,
            successor_salt,
            successor_token_hash,
            client_id,
            account_id,
            device_id,
            sign_in_revoked,
            device_revoked,
        )| PresentedRefreshToken {
            sign_in_id,
            expires_at,
            rotated_at,
            successor_salt,
            successor_token_hash,
            client_id,
            account_id,
            device_id,
            sign_in_revoked,
            device_revoked,
        },
    ))
}

/// The successor pair of a token rotated within the grace period, if the
/// successor has not been used and is still live.
async fn unused_successor(
    transaction: &mut Transaction<'_, Postgres>,
    presented_token: &str,
    presented: &PresentedRefreshToken,
    now: DateTime<Utc>,
) -> Result<Option<IssuedTokens>, sqlx_core::Error> {
    let (Some(rotated_at), Some(salt), Some(successor_hash)) = (
        presented.rotated_at,
        presented.successor_salt.as_deref(),
        presented.successor_token_hash.as_deref(),
    ) else {
        return Ok(None);
    };
    if now - rotated_at > Duration::seconds(REFRESH_REUSE_GRACE_SECS) {
        return Ok(None);
    }
    let tokens = successor_tokens(presented_token, salt);
    if hash_token(&tokens.refresh_token) != successor_hash {
        return Ok(None);
    }
    let refresh: Option<(DateTime<Utc>, Option<DateTime<Utc>>)> = query_as(
        "SELECT expires_at, rotated_at FROM cloud_app_refresh_tokens \
         WHERE token_hash = $1 AND sign_in_id = $2",
    )
    .bind(successor_hash)
    .bind(&presented.sign_in_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((refresh_expires_at, None)) = refresh else {
        return Ok(None);
    };
    let access: Option<(String, String)> = query_as(
        "SELECT token_id, expires_at FROM cloud_refresh_tokens \
         WHERE token_hash = $1 AND app_sign_in_id = $2 AND revoked_at IS NULL",
    )
    .bind(hash_session_token(&tokens.access_token))
    .bind(&presented.sign_in_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let Some((access_token_id, access_expires_at)) = access else {
        return Ok(None);
    };
    let Ok(access_expires_at) = DateTime::parse_from_rfc3339(&access_expires_at) else {
        return Ok(None);
    };
    Ok(Some(IssuedTokens {
        sign_in_id: presented.sign_in_id.clone(),
        account_id: presented.account_id.clone(),
        device_id: presented.device_id.clone(),
        access_token: tokens.access_token,
        access_token_id,
        access_expires_at: access_expires_at.with_timezone(&Utc),
        refresh_token: tokens.refresh_token,
        refresh_expires_at,
    }))
}

/// Exchange a refresh token for a new pair. The presented token is rotated;
/// presenting it again returns the same successor only within the grace
/// period and while the successor is unused.
pub async fn rotate_refresh_token(
    pool: &PgPool,
    client_id: &str,
    refresh_token: &str,
) -> Result<RefreshOutcome, sqlx_core::Error> {
    if !refresh_token.starts_with(REFRESH_TOKEN_PREFIX) {
        return Ok(RefreshOutcome::Invalid);
    }
    let token_hash = hash_token(refresh_token);
    let mut transaction = pool.begin().await?;
    let Some(presented) = load_presented(&mut transaction, &token_hash).await? else {
        return Ok(RefreshOutcome::Invalid);
    };
    if presented.sign_in_revoked || presented.client_id != client_id {
        return Ok(RefreshOutcome::Invalid);
    }
    if presented.device_revoked {
        revoke_sign_in_in_transaction(
            &mut transaction,
            &presented.sign_in_id,
            revoked_reason::DEVICE_REVOKED,
        )
        .await?;
        transaction.commit().await?;
        return Ok(RefreshOutcome::Invalid);
    }
    let now = Utc::now();
    if presented.rotated_at.is_some() {
        if let Some(issued) =
            unused_successor(&mut transaction, refresh_token, &presented, now).await?
        {
            transaction.commit().await?;
            return Ok(RefreshOutcome::Issued(issued));
        }
        revoke_sign_in_in_transaction(
            &mut transaction,
            &presented.sign_in_id,
            revoked_reason::REFRESH_TOKEN_REUSE,
        )
        .await?;
        transaction.commit().await?;
        return Ok(RefreshOutcome::ReuseDetected {
            account_id: presented.account_id,
        });
    }
    if presented.expires_at <= now {
        return Ok(RefreshOutcome::Invalid);
    }
    let salt = random_salt();
    let tokens = successor_tokens(refresh_token, &salt);
    query(
        "UPDATE cloud_app_refresh_tokens \
         SET rotated_at = $1, successor_salt = $2, successor_token_hash = $3 \
         WHERE token_hash = $4",
    )
    .bind(now)
    .bind(&salt)
    .bind(hash_token(&tokens.refresh_token))
    .bind(&token_hash)
    .execute(&mut *transaction)
    .await?;
    query("UPDATE cloud_app_sign_ins SET last_refreshed_at = $1 WHERE sign_in_id = $2")
        .bind(now)
        .bind(&presented.sign_in_id)
        .execute(&mut *transaction)
        .await?;
    let issued = issue_pair(
        &mut transaction,
        &presented.sign_in_id,
        &presented.account_id,
        &presented.device_id,
        Some(tokens),
    )
    .await?;
    transaction.commit().await?;
    Ok(RefreshOutcome::Issued(issued))
}
