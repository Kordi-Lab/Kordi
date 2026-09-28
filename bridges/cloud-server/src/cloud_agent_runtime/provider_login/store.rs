//! Durable ownership and lifecycle state for provider login sessions. This
//! table never holds credentials; a completed session only references the
//! encrypted snapshot it produced.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

pub(super) struct LoginTarget {
    pub provider: String,
    pub worker_provider: String,
    pub label: String,
    /// `default` or `api-key`.
    pub method: String,
}

pub(super) struct SavedSnapshot {
    pub snapshot_id: String,
    pub provider: String,
    pub auth_choice: String,
    pub label: Option<String>,
}

pub(super) struct LoginSession {
    pub session_id: String,
    pub account_id: String,
    pub device_id: String,
    pub target: LoginTarget,
    pub status: String,
    pub failure_reason: Option<String>,
    /// The session is older than the 20-minute login window.
    pub expired: bool,
    /// A claim started more than two minutes ago and never finished, so the
    /// request that began it has gone.
    pub claim_stale: bool,
    pub snapshot: Option<SavedSnapshot>,
}

type LoginSessionRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    bool,
);

/// A claim asks the worker once (30-second timeout) and saves one row, so a
/// claim still unfinished after this long was abandoned.
const CLAIM_STALE_AFTER: &str = "2 minutes";

pub(super) async fn insert(
    pool: &PgPool,
    session_id: &str,
    account_id: &str,
    device_id: &str,
    target: LoginTarget,
) -> Result<LoginSession, sqlx_core::Error> {
    query(
        "INSERT INTO cloud_agent_provider_login_sessions \
         (session_id, account_id, device_id, provider, worker_provider, label, method) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(session_id)
    .bind(account_id)
    .bind(device_id)
    .bind(&target.provider)
    .bind(&target.worker_provider)
    .bind(&target.label)
    .bind(&target.method)
    .execute(pool)
    .await?;
    Ok(LoginSession {
        session_id: session_id.to_string(),
        account_id: account_id.to_string(),
        device_id: device_id.to_string(),
        target,
        status: "running".to_string(),
        failure_reason: None,
        expired: false,
        claim_stale: false,
        snapshot: None,
    })
}

/// Loads a session only when it belongs to `account_id`.
pub(super) async fn owned(
    pool: &PgPool,
    session_id: &str,
    account_id: &str,
) -> Result<Option<LoginSession>, sqlx_core::Error> {
    let row: Option<LoginSessionRow> = query_as(
        "SELECT login.session_id, login.device_id, login.provider, login.worker_provider, \
                login.label, login.status, login.failure_reason, \
                login.created_at < now() - interval '20 minutes', \
                snapshot.snapshot_id, snapshot.provider, snapshot.auth_choice, snapshot.label, \
                login.method, \
                login.status = 'claiming' AND login.updated_at < now() - $3::INTERVAL \
         FROM cloud_agent_provider_login_sessions login \
         LEFT JOIN cloud_agent_provider_auth_snapshots snapshot \
           ON snapshot.snapshot_id = login.snapshot_id \
         WHERE login.session_id = $1 AND login.account_id = $2",
    )
    .bind(session_id)
    .bind(account_id)
    .bind(CLAIM_STALE_AFTER)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| LoginSession {
        session_id: row.0,
        account_id: account_id.to_string(),
        device_id: row.1,
        target: LoginTarget {
            provider: row.2,
            worker_provider: row.3,
            label: row.4,
            method: row.12,
        },
        status: row.5,
        failure_reason: row.6,
        expired: row.7,
        claim_stale: row.13,
        snapshot: match (row.8, row.9, row.10) {
            (Some(snapshot_id), Some(provider), Some(auth_choice)) => Some(SavedSnapshot {
                snapshot_id,
                provider,
                auth_choice,
                label: row.11,
            }),
            _ => None,
        },
    }))
}

/// Moves a session from one of `from` to `to`. Returns whether this caller
/// made the transition, so concurrent requests cannot both claim a login.
pub(super) async fn transition(
    pool: &PgPool,
    session_id: &str,
    from: &[&str],
    to: &str,
    failure_reason: Option<&str>,
    snapshot_id: Option<&str>,
) -> Result<bool, sqlx_core::Error> {
    let from: Vec<String> = from.iter().map(ToString::to_string).collect();
    let result = query(
        "UPDATE cloud_agent_provider_login_sessions \
         SET status = $3, failure_reason = COALESCE($4, failure_reason), \
             snapshot_id = COALESCE($5, snapshot_id), updated_at = now() \
         WHERE session_id = $1 AND status = ANY($2)",
    )
    .bind(session_id)
    .bind(&from)
    .bind(to)
    .bind(failure_reason)
    .bind(snapshot_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Ends one account's abandoned sessions: a running login past the 20-minute
/// window expires (the worker drops its own copy after 15 idle minutes), and
/// an unfinished claim fails with `timeout`. Runs when the account starts a
/// login, so abandoned rows never stay open past that account's next start.
pub(super) async fn sweep_stale(pool: &PgPool, account_id: &str) -> Result<u64, sqlx_core::Error> {
    let result = query(
        "UPDATE cloud_agent_provider_login_sessions \
         SET status = CASE status WHEN 'running' THEN 'expired' ELSE 'failed' END, \
             failure_reason = CASE status WHEN 'claiming' THEN 'timeout' ELSE failure_reason END, \
             updated_at = now() \
         WHERE account_id = $1 \
           AND ((status = 'running' AND created_at < now() - interval '20 minutes') \
             OR (status = 'claiming' AND updated_at < now() - $2::INTERVAL))",
    )
    .bind(account_id)
    .bind(CLAIM_STALE_AFTER)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}
