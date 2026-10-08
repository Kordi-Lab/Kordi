//! Credential writes and the grant and disconnect transactions.

use chrono::{DateTime, Utc};
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::super::models::{AuditOutcome, ConnectorRecord, ConnectorToolGroup, CONNECTOR_COLUMNS};
use super::{
    default_agent_id, insert_audit, new_id, record_from_row, ConnectorRow, NewAuditEntry,
    StoreResult,
};

/// Encrypted credential as stored. `ciphertext` and `nonce` together are the
/// provider-auth cipher output for the access token; `refresh_ciphertext`
/// is a complete cipher output (nonce included) for the refresh token.
pub struct SealedSecret {
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub key_version: i32,
    pub refresh_ciphertext: Option<Vec<u8>>,
    pub expires_at: Option<DateTime<Utc>>,
}

/// Inserts or replaces the secret. A missing refresh token keeps the stored
/// one, because some providers only return it on the first grant.
pub async fn write_secret<'e, E>(
    executor: E,
    connector_id: &str,
    sealed: &SealedSecret,
) -> StoreResult<()>
where
    E: Executor<'e, Database = Postgres>,
{
    query(
        "INSERT INTO cloud_connector_secrets \
         (connector_id, ciphertext, nonce, key_version, refresh_ciphertext, expires_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now()) \
         ON CONFLICT (connector_id) DO UPDATE SET \
           ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, \
           key_version = EXCLUDED.key_version, \
           refresh_ciphertext = COALESCE(EXCLUDED.refresh_ciphertext, \
                                         cloud_connector_secrets.refresh_ciphertext), \
           expires_at = EXCLUDED.expires_at, updated_at = now()",
    )
    .bind(connector_id)
    .bind(&sealed.ciphertext)
    .bind(&sealed.nonce)
    .bind(sealed.key_version)
    .bind(sealed.refresh_ciphertext.as_deref())
    .bind(sealed.expires_at)
    .execute(executor)
    .await?;
    Ok(())
}

/// Stores a refreshed credential for a live connector. Update-only: a
/// connector disconnected while the refresh was in flight has no secret row
/// and is revoked, so nothing is written. Returns whether a row changed.
pub async fn update_refreshed_secret<'e, E>(
    executor: E,
    connector_id: &str,
    sealed: &SealedSecret,
) -> StoreResult<bool>
where
    E: Executor<'e, Database = Postgres>,
{
    let updated = query(
        "UPDATE cloud_connector_secrets SET \
           ciphertext = $2, nonce = $3, key_version = $4, \
           refresh_ciphertext = COALESCE($5, refresh_ciphertext), \
           expires_at = $6, updated_at = now() \
         WHERE connector_id = $1 AND EXISTS ( \
           SELECT 1 FROM cloud_connectors WHERE connector_id = $1 AND status <> 'revoked')",
    )
    .bind(connector_id)
    .bind(&sealed.ciphertext)
    .bind(&sealed.nonce)
    .bind(sealed.key_version)
    .bind(sealed.refresh_ciphertext.as_deref())
    .bind(sealed.expires_at)
    .execute(executor)
    .await?
    .rows_affected();
    Ok(updated > 0)
}

/// Appends `added` to `existing`, keeping order and dropping duplicates.
pub fn merge_scopes(existing: &[String], added: &[String]) -> Vec<String> {
    let mut merged = existing.to_vec();
    for scope in added {
        if !merged.contains(scope) {
            merged.push(scope.clone());
        }
    }
    merged
}

pub struct GrantUpdate<'a> {
    pub account_id: &'a str,
    pub provider: &'a str,
    pub read_scopes: &'a [String],
    /// Act scopes granted now. When any are present, acting is turned on.
    pub act_scopes: &'a [String],
    /// The provider account behind the credential, when known.
    pub provider_account_id: Option<&'a str>,
    pub audit_tool_group: ConnectorToolGroup,
    pub audit_summary: &'a str,
}

/// Records a completed OAuth grant: creates or updates the live connector,
/// stores the sealed secret, and writes the `oauth.grant` audit row, all in
/// one transaction. Acting is turned on whenever the grant carries act
/// scopes, and a newly created connector is granted to the account's
/// default agent, so a connected service is usable at once. An advisory
/// lock on (account, provider) serializes racing completions, so the second
/// one updates the connector the first created instead of hitting the
/// one-live-connector index.
pub async fn apply_grant(
    pool: &PgPool,
    grant: GrantUpdate<'_>,
    sealed: &SealedSecret,
) -> StoreResult<ConnectorRecord> {
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))")
        .bind(grant.account_id)
        .bind(grant.provider)
        .execute(&mut *tx)
        .await?;
    let existing: Option<ConnectorRow> = query_as(&format!(
        "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors \
         WHERE account_id = $1 AND provider = $2 AND status <> 'revoked' FOR UPDATE"
    ))
    .bind(grant.account_id)
    .bind(grant.provider)
    .fetch_optional(&mut *tx)
    .await?;
    let existing = existing.map(record_from_row).transpose()?;
    let created = existing.is_none();
    let row: ConnectorRow = match existing {
        Some(current) => {
            let read = merge_scopes(&current.read_scopes, grant.read_scopes);
            let act = merge_scopes(&current.act_scopes, grant.act_scopes);
            let act_enabled = current.act_enabled || !grant.act_scopes.is_empty();
            query_as(&format!(
                "UPDATE cloud_connectors SET status = 'connected', read_scopes = $2, \
                 act_scopes = $3, act_enabled = $4, updated_at = now(), \
                 provider_account_id = COALESCE($5, provider_account_id) \
                 WHERE connector_id = $1 RETURNING {CONNECTOR_COLUMNS}"
            ))
            .bind(&current.connector_id)
            .bind(&read)
            .bind(&act)
            .bind(act_enabled)
            .bind(grant.provider_account_id)
            .fetch_one(&mut *tx)
            .await?
        }
        None => {
            query_as(&format!(
                "INSERT INTO cloud_connectors \
                 (connector_id, account_id, provider, status, read_scopes, act_scopes, act_enabled, \
                  provider_account_id) \
                 VALUES ($1, $2, $3, 'connected', $4, $5, $6, $7) RETURNING {CONNECTOR_COLUMNS}"
            ))
            .bind(new_id("conn"))
            .bind(grant.account_id)
            .bind(grant.provider)
            .bind(grant.read_scopes)
            .bind(grant.act_scopes)
            .bind(!grant.act_scopes.is_empty())
            .bind(grant.provider_account_id)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    let record = record_from_row(row)?;
    if created {
        grant_default_agent_if_none(&mut *tx, &record.connector_id, grant.account_id).await?;
    }
    write_secret(&mut *tx, &record.connector_id, sealed).await?;
    insert_audit(
        &mut *tx,
        NewAuditEntry {
            connector_id: &record.connector_id,
            account_id: grant.account_id,
            run_id: None,
            agent_id: None,
            tool: "oauth.grant",
            tool_group: grant.audit_tool_group,
            outcome: AuditOutcome::Completed,
            summary: grant.audit_summary,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(record)
}

/// Grants the connector to the account's default agent when no agent has
/// it yet. Runs only for the first grant of a connector, so a person who
/// later removes every agent keeps that choice across re-grants.
async fn grant_default_agent_if_none<'e, E>(
    executor: E,
    connector_id: &str,
    account_id: &str,
) -> StoreResult<()>
where
    E: Executor<'e, Database = Postgres>,
{
    query(
        "INSERT INTO cloud_connector_agent_grants (connector_id, agent_id) \
         SELECT $1, $2 WHERE NOT EXISTS ( \
           SELECT 1 FROM cloud_connector_agent_grants WHERE connector_id = $1) \
         ON CONFLICT DO NOTHING",
    )
    .bind(connector_id)
    .bind(default_agent_id(account_id))
    .execute(executor)
    .await?;
    Ok(())
}

/// Removes the credential, the agent grants, and the stored events, queues
/// derived-copy removal, marks the connector revoked, and writes the audit
/// row, in one transaction. Returns how many events were deleted.
///
/// The connector row is locked first, so an event being recorded meanwhile
/// either commits before the deletion (and is deleted) or waits and then
/// sees the connector revoked (and is not stored).
pub async fn disconnect(pool: &PgPool, record: &ConnectorRecord) -> StoreResult<u64> {
    let mut tx = pool.begin().await?;
    query("SELECT connector_id FROM cloud_connectors WHERE connector_id = $1 FOR UPDATE")
        .bind(&record.connector_id)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM cloud_connector_secrets WHERE connector_id = $1")
        .bind(&record.connector_id)
        .execute(&mut *tx)
        .await?;
    query("DELETE FROM cloud_connector_agent_grants WHERE connector_id = $1")
        .bind(&record.connector_id)
        .execute(&mut *tx)
        .await?;
    let deleted_events = query("DELETE FROM cloud_connector_events WHERE connector_id = $1")
        .bind(&record.connector_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    query(
        "INSERT INTO cloud_connector_removal_requests (request_id, account_id, connector_id) \
         VALUES ($1, $2, $3)",
    )
    .bind(new_id("cnrm"))
    .bind(&record.account_id)
    .bind(&record.connector_id)
    .execute(&mut *tx)
    .await?;
    query(
        "UPDATE cloud_connectors SET status = 'revoked', revoked_at = now(), updated_at = now(), \
         act_enabled = FALSE, read_scopes = '{}', act_scopes = '{}' WHERE connector_id = $1",
    )
    .bind(&record.connector_id)
    .execute(&mut *tx)
    .await?;
    let summary = format!(
        "Disconnected; deleted {deleted_events} stored events and queued removal of derived copies."
    );
    insert_audit(
        &mut *tx,
        NewAuditEntry {
            connector_id: &record.connector_id,
            account_id: &record.account_id,
            run_id: None,
            agent_id: None,
            tool: "connector.disconnect",
            tool_group: ConnectorToolGroup::Act,
            outcome: AuditOutcome::Completed,
            summary: &summary,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(deleted_events)
}
