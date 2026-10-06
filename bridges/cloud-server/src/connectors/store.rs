//! Postgres access for connectors.
//!
//! This file writes `cloud_connector_secrets` but never reads it. The one
//! reader is `broker::read_sealed_secret`.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx_core::executor::Executor;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::models::{
    AuditOutcome, ConnectorAuditEntry, ConnectorRecord, ConnectorStatus, ConnectorSummary,
    ConnectorToolGroup, CONNECTOR_COLUMNS,
};

pub type StoreResult<T> = Result<T, sqlx_core::Error>;

pub(crate) fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

type ConnectorRow = (
    String,
    String,
    String,
    String,
    Vec<String>,
    Vec<String>,
    bool,
    DateTime<Utc>,
    DateTime<Utc>,
    Option<DateTime<Utc>>,
);

fn record_from_row(row: ConnectorRow) -> StoreResult<ConnectorRecord> {
    let (
        connector_id,
        account_id,
        provider,
        status,
        read_scopes,
        act_scopes,
        act_enabled,
        created_at,
        updated_at,
        revoked_at,
    ) = row;
    let status = ConnectorStatus::parse(&status).ok_or_else(|| {
        sqlx_core::Error::Protocol(format!("unknown connector status {status:?}"))
    })?;
    Ok(ConnectorRecord {
        connector_id,
        account_id,
        provider,
        status,
        read_scopes,
        act_scopes,
        act_enabled,
        created_at,
        updated_at,
        revoked_at,
    })
}

/// Loads a connector only when it belongs to `account_id`.
pub async fn load_account_connector<'e, E>(
    executor: E,
    account_id: &str,
    connector_id: &str,
) -> StoreResult<Option<ConnectorRecord>>
where
    E: Executor<'e, Database = Postgres>,
{
    let row: Option<ConnectorRow> = query_as(&format!(
        "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors \
         WHERE connector_id = $1 AND account_id = $2"
    ))
    .bind(connector_id)
    .bind(account_id)
    .fetch_optional(executor)
    .await?;
    row.map(record_from_row).transpose()
}

pub async fn list_live_connectors(
    pool: &PgPool,
    account_id: &str,
) -> StoreResult<Vec<ConnectorRecord>> {
    let rows: Vec<ConnectorRow> = query_as(&format!(
        "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors \
         WHERE account_id = $1 AND status <> 'revoked' \
         ORDER BY created_at ASC, connector_id ASC"
    ))
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(record_from_row).collect()
}

pub async fn agent_grants(
    pool: &PgPool,
    connector_ids: &[String],
) -> StoreResult<HashMap<String, Vec<String>>> {
    let rows: Vec<(String, String)> = query_as(
        "SELECT connector_id, agent_id FROM cloud_connector_agent_grants \
         WHERE connector_id = ANY($1) ORDER BY connector_id, agent_id",
    )
    .bind(connector_ids)
    .fetch_all(pool)
    .await?;
    let mut grants: HashMap<String, Vec<String>> = HashMap::new();
    for (connector_id, agent_id) in rows {
        grants.entry(connector_id).or_default().push(agent_id);
    }
    Ok(grants)
}

pub async fn connector_summaries(
    pool: &PgPool,
    account_id: &str,
) -> StoreResult<Vec<ConnectorSummary>> {
    let records = list_live_connectors(pool, account_id).await?;
    let ids = records
        .iter()
        .map(|record| record.connector_id.clone())
        .collect::<Vec<_>>();
    let mut grants = agent_grants(pool, &ids).await?;
    Ok(records
        .into_iter()
        .map(|record| {
            let agents = grants.remove(&record.connector_id).unwrap_or_default();
            ConnectorSummary::from_record(record, agents)
        })
        .collect())
}

pub async fn summary_for(pool: &PgPool, record: ConnectorRecord) -> StoreResult<ConnectorSummary> {
    let mut grants = agent_grants(pool, std::slice::from_ref(&record.connector_id)).await?;
    let agents = grants.remove(&record.connector_id).unwrap_or_default();
    Ok(ConnectorSummary::from_record(record, agents))
}

pub async fn agent_has_grant(
    pool: &PgPool,
    connector_id: &str,
    agent_id: &str,
) -> StoreResult<bool> {
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_connector_agent_grants WHERE connector_id = $1 AND agent_id = $2",
    )
    .bind(connector_id)
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// The account's built-in agent id, as used by `cloud_agent_fallback_runs`.
pub fn default_agent_id(account_id: &str) -> String {
    format!("cloud-agent:{}", account_id.trim())
}

/// True for the account's built-in agent and for its active, user-defined
/// agents in `cloud_agent_definitions`.
pub async fn agent_owned_by_account(
    pool: &PgPool,
    account_id: &str,
    agent_id: &str,
) -> StoreResult<bool> {
    if agent_id == default_agent_id(account_id) {
        return Ok(true);
    }
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_agent_definitions \
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'",
    )
    .bind(agent_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn replace_agent_grants(
    pool: &PgPool,
    connector_id: &str,
    agent_ids: &[String],
) -> StoreResult<()> {
    let mut tx = pool.begin().await?;
    query("DELETE FROM cloud_connector_agent_grants WHERE connector_id = $1")
        .bind(connector_id)
        .execute(&mut *tx)
        .await?;
    query(
        "INSERT INTO cloud_connector_agent_grants (connector_id, agent_id) \
         SELECT $1, agent_id FROM unnest($2::text[]) AS agent_id",
    )
    .bind(connector_id)
    .bind(agent_ids)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

pub async fn set_act_enabled(
    pool: &PgPool,
    connector_id: &str,
    enabled: bool,
) -> StoreResult<Option<ConnectorRecord>> {
    let row: Option<ConnectorRow> = query_as(&format!(
        "UPDATE cloud_connectors SET act_enabled = $2, updated_at = now() \
         WHERE connector_id = $1 AND status <> 'revoked' RETURNING {CONNECTOR_COLUMNS}"
    ))
    .bind(connector_id)
    .bind(enabled)
    .fetch_optional(pool)
    .await?;
    row.map(record_from_row).transpose()
}

pub async fn mark_needs_reauth(pool: &PgPool, connector_id: &str) -> StoreResult<()> {
    query(
        "UPDATE cloud_connectors SET status = 'needs_reauth', updated_at = now() \
         WHERE connector_id = $1 AND status = 'connected'",
    )
    .bind(connector_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub struct NewAuditEntry<'a> {
    pub connector_id: &'a str,
    pub account_id: &'a str,
    pub run_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub tool: &'a str,
    pub tool_group: ConnectorToolGroup,
    pub outcome: AuditOutcome,
    pub summary: &'a str,
}

pub async fn insert_audit<'e, E>(executor: E, entry: NewAuditEntry<'_>) -> StoreResult<String>
where
    E: Executor<'e, Database = Postgres>,
{
    let audit_id = new_id("cnaud");
    query(
        "INSERT INTO cloud_connector_audit \
         (audit_id, connector_id, account_id, run_id, agent_id, tool, tool_group, outcome, summary) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&audit_id)
    .bind(entry.connector_id)
    .bind(entry.account_id)
    .bind(entry.run_id)
    .bind(entry.agent_id)
    .bind(entry.tool)
    .bind(entry.tool_group.as_str())
    .bind(entry.outcome.as_str())
    .bind(entry.summary)
    .execute(executor)
    .await?;
    Ok(audit_id)
}

type AuditRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
    String,
    DateTime<Utc>,
);

/// Newest first. `before` is exclusive.
pub async fn list_audit(
    pool: &PgPool,
    connector_id: &str,
    limit: i64,
    before: Option<DateTime<Utc>>,
) -> StoreResult<Vec<ConnectorAuditEntry>> {
    let rows: Vec<AuditRow> = query_as(
        "SELECT audit_id, connector_id, run_id, agent_id, tool, tool_group, outcome, summary, \
                created_at \
         FROM cloud_connector_audit \
         WHERE connector_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2) \
         ORDER BY created_at DESC, audit_id DESC LIMIT $3",
    )
    .bind(connector_id)
    .bind(before)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(audit_id, connector_id, run_id, agent_id, tool, group, outcome, summary, created)| {
                ConnectorAuditEntry {
                    audit_id,
                    connector_id,
                    run_id,
                    agent_id,
                    tool,
                    tool_group: ConnectorToolGroup::parse(&group)
                        .unwrap_or(ConnectorToolGroup::Act),
                    outcome,
                    summary,
                    created_at: created.to_rfc3339(),
                }
            },
        )
        .collect())
}

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
    pub act_scopes: &'a [String],
    pub enable_act: bool,
    pub audit_tool_group: ConnectorToolGroup,
    pub audit_summary: &'a str,
}

/// Records a completed OAuth grant: creates or updates the live connector,
/// stores the sealed secret, and writes the `oauth.grant` audit row, all in
/// one transaction.
pub async fn apply_grant(
    pool: &PgPool,
    grant: GrantUpdate<'_>,
    sealed: &SealedSecret,
) -> StoreResult<ConnectorRecord> {
    let mut tx = pool.begin().await?;
    let existing: Option<ConnectorRow> = query_as(&format!(
        "SELECT {CONNECTOR_COLUMNS} FROM cloud_connectors \
         WHERE account_id = $1 AND provider = $2 AND status <> 'revoked' FOR UPDATE"
    ))
    .bind(grant.account_id)
    .bind(grant.provider)
    .fetch_optional(&mut *tx)
    .await?;
    let row: ConnectorRow = match existing.map(record_from_row).transpose()? {
        Some(current) => {
            let read = merge_scopes(&current.read_scopes, grant.read_scopes);
            let act = merge_scopes(&current.act_scopes, grant.act_scopes);
            let act_enabled = current.act_enabled || (grant.enable_act && !act.is_empty());
            query_as(&format!(
                "UPDATE cloud_connectors SET status = 'connected', read_scopes = $2, \
                 act_scopes = $3, act_enabled = $4, updated_at = now() \
                 WHERE connector_id = $1 RETURNING {CONNECTOR_COLUMNS}"
            ))
            .bind(&current.connector_id)
            .bind(&read)
            .bind(&act)
            .bind(act_enabled)
            .fetch_one(&mut *tx)
            .await?
        }
        None => {
            query_as(&format!(
                "INSERT INTO cloud_connectors \
                 (connector_id, account_id, provider, status, read_scopes, act_scopes, act_enabled) \
                 VALUES ($1, $2, $3, 'connected', $4, $5, $6) RETURNING {CONNECTOR_COLUMNS}"
            ))
            .bind(new_id("conn"))
            .bind(grant.account_id)
            .bind(grant.provider)
            .bind(grant.read_scopes)
            .bind(grant.act_scopes)
            .bind(grant.enable_act && !grant.act_scopes.is_empty())
            .fetch_one(&mut *tx)
            .await?
        }
    };
    let record = record_from_row(row)?;
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

/// Removes the credential, the agent grants, and the stored events, queues
/// derived-copy removal, marks the connector revoked, and writes the audit
/// row, in one transaction. Returns how many events were deleted.
pub async fn disconnect(pool: &PgPool, record: &ConnectorRecord) -> StoreResult<u64> {
    let mut tx = pool.begin().await?;
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

/// OAuth state for a connector grant, as handed back by
/// [`consume_oauth_state`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorOAuthState {
    pub state_id: String,
    pub account_id: String,
    pub provider: String,
    pub grant: ConnectorToolGroup,
    pub redirect_after: Option<String>,
    pub code_verifier: String,
    pub expires_at: DateTime<Utc>,
}

pub async fn insert_oauth_state(pool: &PgPool, state: &ConnectorOAuthState) -> StoreResult<()> {
    // Opportunistic cleanup keeps the table small without another worker.
    query("DELETE FROM cloud_connector_oauth_states WHERE expires_at < now()")
        .execute(pool)
        .await?;
    query(
        "INSERT INTO cloud_connector_oauth_states \
         (state_id, account_id, provider, grant_kind, redirect_after, code_verifier, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(&state.state_id)
    .bind(&state.account_id)
    .bind(&state.provider)
    .bind(state.grant.as_str())
    .bind(state.redirect_after.as_deref())
    .bind(&state.code_verifier)
    .bind(state.expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

type OAuthStateRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    DateTime<Utc>,
);

/// Deletes and returns the state in one statement, so a state can be used
/// once even when two callbacks race.
pub async fn consume_oauth_state(
    pool: &PgPool,
    state_id: &str,
) -> StoreResult<Option<ConnectorOAuthState>> {
    let row: Option<OAuthStateRow> = query_as(
        "DELETE FROM cloud_connector_oauth_states WHERE state_id = $1 \
         RETURNING state_id, account_id, provider, grant_kind, redirect_after, code_verifier, \
                   expires_at",
    )
    .bind(state_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(
        |(state_id, account_id, provider, grant, redirect_after, code_verifier, expires_at)| {
            Some(ConnectorOAuthState {
                state_id,
                account_id,
                provider,
                grant: ConnectorToolGroup::parse(&grant)?,
                redirect_after,
                code_verifier,
                expires_at,
            })
        },
    ))
}
