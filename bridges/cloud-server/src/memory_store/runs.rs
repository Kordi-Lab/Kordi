//! Replay state, run lease, and audit helpers used by the memory routes.

use chrono::Utc;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{MemoryError, MemoryResult};

/// Number of private runtime replay rows kept for the account's cloud runs.
pub(crate) async fn omp_state_count(pool: &PgPool, account_id: &str) -> MemoryResult<i64> {
    let (count,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_agent_omp_state WHERE owner_account_id = $1")
            .bind(account_id)
            .fetch_one(pool)
            .await?;
    Ok(count)
}

/// Deletes every private runtime replay row kept for the account's cloud runs.
pub(crate) async fn clear_omp_state(pool: &PgPool, account_id: &str) -> MemoryResult<u64> {
    let result = query("DELETE FROM cloud_agent_omp_state WHERE owner_account_id = $1")
        .bind(account_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// A cloud run currently leased by a runner, with the scopes its agent may
/// save memories into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LeasedRun {
    pub owner_account_id: String,
    pub requester_account_id: String,
    /// The run's session id plus its subsession id, when it has one.
    pub conversation_ids: Vec<String>,
    /// The group id of a `session:group:<id>` session.
    pub group_id: Option<String>,
}

impl LeasedRun {
    fn new(
        owner_account_id: String,
        requester_account_id: String,
        session_id: String,
        subsession_id: Option<String>,
    ) -> Self {
        let group_id = session_id
            .strip_prefix("session:group:")
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        let mut conversation_ids = vec![session_id];
        if let Some(subsession_id) = subsession_id.filter(|id| !id.trim().is_empty()) {
            if subsession_id != conversation_ids[0] {
                conversation_ids.push(subsession_id);
            }
        }
        Self {
            owner_account_id,
            requester_account_id,
            conversation_ids,
            group_id,
        }
    }

    /// Checks that the run's agent may save a memory into this scope: the
    /// run's own conversations and group, and `global` only when the owner
    /// made the request. Cloud runs carry no project. Unknown scopes are left
    /// to the save's own validation.
    pub(crate) fn check_save_scope(&self, scope: &str, scope_id: &str) -> MemoryResult<()> {
        let scope_id = scope_id.trim();
        let allowed = match scope.trim() {
            "conversation" => self.conversation_ids.iter().any(|id| id == scope_id),
            "group" => self
                .group_id
                .as_deref()
                .is_some_and(|group_id| same_group_id(group_id, scope_id)),
            "project" => false,
            "global" => self.owner_account_id == self.requester_account_id,
            _ => true,
        };
        if allowed {
            Ok(())
        } else {
            Err(MemoryError::scope_not_allowed())
        }
    }
}

fn same_group_id(left: &str, right: &str) -> bool {
    match (uuid::Uuid::parse_str(left), uuid::Uuid::parse_str(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// A cloud run currently leased by `runner_id`, matching the lease check used
/// by the runner context routes.
pub(crate) async fn leased_run(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
) -> MemoryResult<Option<LeasedRun>> {
    let row: Option<(String, String, String, Option<String>)> = query_as(
        "SELECT owner_account_id, requester_account_id, session_id, subsession_id::text \
         FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND execution_backend = 'cloud' \
           AND status IN ('leased', 'running') AND lease_expires_at::timestamptz > now()",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(owner, requester, session_id, subsession_id)| {
        LeasedRun::new(owner, requester, session_id, subsession_id)
    }))
}

/// Writes one audit row. Mirrors the account routes' `write_audit` so runner
/// writes land in the same table with the same shape.
pub(crate) async fn write_memory_audit(
    pool: &PgPool,
    account_id: &str,
    device_id: Option<&str>,
    event_type: &str,
    metadata: serde_json::Value,
) {
    let event_id = format!("evt_{}", uuid::Uuid::new_v4().simple());
    let result = query(
        "INSERT INTO cloud_audit_events \
         (event_id, account_id, device_id, event_type, metadata_json, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&event_id)
    .bind(account_id)
    .bind(device_id)
    .bind(event_type)
    .bind(metadata.to_string())
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await;
    if let Err(error) = result {
        eprintln!("[memory_store] audit {event_type}: {error}");
    }
}
