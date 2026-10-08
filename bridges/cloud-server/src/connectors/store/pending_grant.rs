//! Tokens the OAuth callback exchanged, parked until the account that
//! started the grant completes it.
//!
//! The credential columns hold provider-auth cipher output in the
//! `cloud_connector_secrets` layout. Only the authenticated completion step
//! in `connectors::oauth_complete` takes rows out, and it moves them into
//! `cloud_connector_secrets` without decrypting them.

use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::super::models::ConnectorToolGroup;
use super::{SealedSecret, StoreResult};

pub struct PendingGrant {
    pub completion_code: String,
    pub state_id: String,
    pub account_id: String,
    pub provider: String,
    pub grant: ConnectorToolGroup,
    pub read_scopes: Vec<String>,
    pub act_scopes: Vec<String>,
    pub sealed: SealedSecret,
    pub expires_at: DateTime<Utc>,
}

pub async fn insert_pending_grant(pool: &PgPool, pending: &PendingGrant) -> StoreResult<()> {
    query(
        "INSERT INTO cloud_connector_pending_grants \
         (completion_code, state_id, account_id, provider, grant_kind, read_scopes, act_scopes, \
          ciphertext, nonce, key_version, refresh_ciphertext, token_expires_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
    )
    .bind(&pending.completion_code)
    .bind(&pending.state_id)
    .bind(&pending.account_id)
    .bind(&pending.provider)
    .bind(pending.grant.as_str())
    .bind(&pending.read_scopes)
    .bind(&pending.act_scopes)
    .bind(&pending.sealed.ciphertext)
    .bind(&pending.sealed.nonce)
    .bind(pending.sealed.key_version)
    .bind(pending.sealed.refresh_ciphertext.as_deref())
    .bind(pending.sealed.expires_at)
    .bind(pending.expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

type PendingRow = (
    String,
    String,
    String,
    String,
    String,
    Vec<String>,
    Vec<String>,
    Vec<u8>,
    Vec<u8>,
    i32,
    Option<Vec<u8>>,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
);

/// Deletes and returns the pending grant in one statement, so a completion
/// code works once even when two requests race.
pub async fn take_pending_grant(
    pool: &PgPool,
    completion_code: &str,
) -> StoreResult<Option<PendingGrant>> {
    let row: Option<PendingRow> = query_as(
        "DELETE FROM cloud_connector_pending_grants WHERE completion_code = $1 \
         RETURNING completion_code, state_id, account_id, provider, grant_kind, read_scopes, \
                   act_scopes, ciphertext, nonce, key_version, refresh_ciphertext, \
                   token_expires_at, expires_at",
    )
    .bind(completion_code)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(
        |(
            completion_code,
            state_id,
            account_id,
            provider,
            grant,
            read_scopes,
            act_scopes,
            ciphertext,
            nonce,
            key_version,
            refresh_ciphertext,
            token_expires_at,
            expires_at,
        )| {
            Some(PendingGrant {
                completion_code,
                state_id,
                account_id,
                provider,
                grant: ConnectorToolGroup::parse(&grant)?,
                read_scopes,
                act_scopes,
                sealed: SealedSecret {
                    ciphertext,
                    nonce,
                    key_version,
                    refresh_ciphertext,
                    expires_at: token_expires_at,
                },
                expires_at,
            })
        },
    ))
}

/// Deletes pending grants past `expires_at`. Returns rows deleted.
pub async fn sweep_expired_pending_grants(pool: &PgPool, now: DateTime<Utc>) -> StoreResult<u64> {
    Ok(
        query("DELETE FROM cloud_connector_pending_grants WHERE expires_at <= $1")
            .bind(now)
            .execute(pool)
            .await?
            .rows_affected(),
    )
}
