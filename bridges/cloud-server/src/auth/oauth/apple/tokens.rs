//! Apple refresh tokens: kept encrypted so they can be revoked.
//!
//! App Store Review requires apps with Sign in with Apple to revoke the
//! user's tokens when the account is deleted. Each code exchange stores its
//! refresh token in `cloud_apple_tokens`, sealed with the provider-auth
//! cipher (`KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY`). Without that key no
//! token is stored, and revocation has nothing to send.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::api::{AppleApi, AppleHttp};
use super::client_secret::client_secret;
use super::config::AppleConfig;
use crate::cloud_agent_runtime::provider_auth::ProviderAuthCipher;
use crate::server::ServerState;

/// Stores `refresh_token` for the Apple user `subject` of `client_id`,
/// replacing the one from an earlier sign-in. Returns whether it was
/// stored; without a cipher it is not.
pub(crate) async fn store_refresh_token(
    pool: &PgPool,
    cipher: Option<&dyn ProviderAuthCipher>,
    account_id: &str,
    subject: &str,
    client_id: &str,
    refresh_token: &str,
) -> Result<bool, sqlx_core::Error> {
    let Some(cipher) = cipher else {
        eprintln!(
            "[apple] No provider-auth encryption key: the Apple refresh token is not kept \
             and cannot be revoked later."
        );
        return Ok(false);
    };
    let Ok(ciphertext) = cipher.encrypt(refresh_token.as_bytes()) else {
        eprintln!("[apple] Could not encrypt the Apple refresh token.");
        return Ok(false);
    };
    let now = chrono::Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_apple_tokens \
         (token_id, account_id, provider_subject, client_id, refresh_token_ciphertext, \
          cipher_key_id, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) \
         ON CONFLICT (provider_subject, client_id) DO UPDATE SET \
           account_id = excluded.account_id, \
           refresh_token_ciphertext = excluded.refresh_token_ciphertext, \
           cipher_key_id = excluded.cipher_key_id, \
           updated_at = excluded.updated_at",
    )
    .bind(format!("apple_token_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(subject)
    .bind(client_id)
    .bind(ciphertext)
    .bind(cipher.key_id())
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(true)
}

/// The outcome of [`revoke_apple_tokens_for_account`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AppleRevocation {
    /// Tokens Apple revoked; their rows are deleted.
    pub revoked: usize,
    /// Tokens that could not be revoked; their rows are kept.
    pub failed: usize,
}

/// Revokes every stored Apple token of `account_id` with Apple and deletes
/// the revoked rows. Best effort: it never fails, and reports what it could
/// not revoke. Call it before deleting the account, whose deletion removes
/// the rows, and after unlinking Apple.
pub async fn revoke_apple_tokens_for_account(
    state: &ServerState,
    account_id: &str,
) -> AppleRevocation {
    let config = AppleConfig::from_env().ok();
    revoke_tokens(
        state.db_pool(),
        state.connectors().cipher.as_deref(),
        config.as_ref(),
        &AppleHttp::new(),
        account_id,
        chrono::Utc::now().timestamp(),
    )
    .await
}

type StoredToken = (String, String, Vec<u8>);

pub(crate) async fn revoke_tokens(
    pool: &PgPool,
    cipher: Option<&dyn ProviderAuthCipher>,
    config: Option<&AppleConfig>,
    api: &dyn AppleApi,
    account_id: &str,
    now: i64,
) -> AppleRevocation {
    let rows: Vec<StoredToken> = match query_as(
        "SELECT token_id, client_id, refresh_token_ciphertext \
         FROM cloud_apple_tokens WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            eprintln!("[apple] Could not load Apple tokens for revocation: {error}");
            return AppleRevocation::default();
        }
    };
    let mut outcome = AppleRevocation::default();
    for (token_id, client_id, ciphertext) in rows {
        if revoke_one(cipher, config, api, &client_id, &ciphertext, now).await {
            let deleted = query("DELETE FROM cloud_apple_tokens WHERE token_id = $1")
                .bind(&token_id)
                .execute(pool)
                .await;
            if let Err(error) = deleted {
                eprintln!("[apple] Revoked an Apple token but could not delete it: {error}");
            }
            outcome.revoked += 1;
        } else {
            outcome.failed += 1;
        }
    }
    if outcome.failed > 0 {
        eprintln!(
            "[apple] Could not revoke {} Apple token(s) for an account.",
            outcome.failed
        );
    }
    outcome
}

async fn revoke_one(
    cipher: Option<&dyn ProviderAuthCipher>,
    config: Option<&AppleConfig>,
    api: &dyn AppleApi,
    client_id: &str,
    ciphertext: &[u8],
    now: i64,
) -> bool {
    let (Some(cipher), Some(config)) = (cipher, config) else {
        return false;
    };
    let Some(token) = cipher
        .decrypt(ciphertext)
        .ok()
        .and_then(|plain| String::from_utf8(plain).ok())
    else {
        return false;
    };
    let Ok(secret) = client_secret(config, client_id, now) else {
        return false;
    };
    let form = [
        ("client_id", client_id),
        ("client_secret", secret.as_str()),
        ("token", token.as_str()),
        ("token_type_hint", "refresh_token"),
    ];
    api.revoke(&form).await.is_ok()
}
