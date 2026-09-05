use chrono::{Duration, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

const DEFAULT_SANDBOX_TTL_DAYS: i64 = 30;
const DEFAULT_STORAGE_BYTES_QUOTA: i64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxScope {
    SharedSession,
    RequesterIsolated,
}

impl SandboxScope {
    fn as_db(self) -> &'static str {
        match self {
            Self::SharedSession => "shared_session",
            Self::RequesterIsolated => "requester_isolated",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CloudAgentSandbox {
    #[serde(rename = "sandboxId")]
    pub sandbox_id: String,
    #[serde(rename = "workspaceKey")]
    pub workspace_key: String,
    pub scope: SandboxScope,
}

pub fn sandbox_scope_for_session(session_id: &str) -> SandboxScope {
    let trimmed = session_id.trim();
    if trimmed.starts_with("session:group:")
        || trimmed.starts_with("session:project:")
        || trimmed.starts_with("project:")
    {
        SandboxScope::SharedSession
    } else {
        SandboxScope::RequesterIsolated
    }
}

pub fn raw_workspace_key(
    session_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
    scope: SandboxScope,
) -> String {
    match scope {
        SandboxScope::SharedSession => {
            format!("sandbox:{session_id}:shared:{owner_account_id}")
        }
        SandboxScope::RequesterIsolated => format!(
            "sandbox:{session_id}:requester:{requester_account_id}:owner:{owner_account_id}"
        ),
    }
}

pub fn hashed_workspace_key(raw_key: &str) -> String {
    let digest = Sha256::digest(raw_key.as_bytes());
    format!("sandbox_{}", hex::encode(digest))
}

pub fn quota_allows_write(
    storage_bytes_used: i64,
    storage_bytes_quota: i64,
    requested_bytes: i64,
) -> bool {
    if storage_bytes_used < 0 || storage_bytes_quota < 0 || requested_bytes < 0 {
        return false;
    }
    storage_bytes_used
        .checked_add(requested_bytes)
        .is_some_and(|next| next <= storage_bytes_quota)
}

pub async fn ensure_sandbox_for_run(
    pool: &PgPool,
    session_id: &str,
    owner_account_id: &str,
    requester_account_id: &str,
) -> Result<CloudAgentSandbox, sqlx_core::Error> {
    let scope = sandbox_scope_for_session(session_id);
    let raw_key = raw_workspace_key(session_id, owner_account_id, requester_account_id, scope);
    let workspace_key = hashed_workspace_key(&raw_key);
    let now = Utc::now();
    let now_text = now.to_rfc3339();

    let existing: Option<(String, String)> = query_as(
        "UPDATE cloud_agent_sandboxes \
         SET last_active_at = $2 \
         WHERE sandbox_id = ( \
             SELECT sandbox_id FROM cloud_agent_sandboxes \
             WHERE workspace_key = $1 AND status = 'active' AND expires_at > $2 \
             ORDER BY last_active_at DESC \
             LIMIT 1 \
         ) \
         RETURNING sandbox_id, workspace_key",
    )
    .bind(&workspace_key)
    .bind(&now_text)
    .fetch_optional(pool)
    .await?;

    if let Some((sandbox_id, workspace_key)) = existing {
        return Ok(CloudAgentSandbox {
            sandbox_id,
            workspace_key,
            scope,
        });
    }

    query(
        "UPDATE cloud_agent_sandboxes \
         SET status = 'expired', last_active_at = $2 \
         WHERE workspace_key = $1 AND status = 'active' AND expires_at <= $2",
    )
    .bind(&workspace_key)
    .bind(&now_text)
    .execute(pool)
    .await?;

    let sandbox_id = format!("cas_{}", Uuid::new_v4().simple());
    let expires_at = (now + Duration::days(DEFAULT_SANDBOX_TTL_DAYS)).to_rfc3339();
    let requester_for_scope = match scope {
        SandboxScope::SharedSession => None,
        SandboxScope::RequesterIsolated => Some(requester_account_id),
    };
    let row: (String, String) = query_as(
        "INSERT INTO cloud_agent_sandboxes (
            sandbox_id, owner_account_id, requester_account_id, session_id, scope, status,
            workspace_key, storage_bytes_used, storage_bytes_quota, created_at, last_active_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6, 0, $7, $8, $8, $9)
         ON CONFLICT (workspace_key) WHERE status = 'active'
         DO UPDATE SET last_active_at = EXCLUDED.last_active_at
         RETURNING sandbox_id, workspace_key",
    )
    .bind(&sandbox_id)
    .bind(owner_account_id)
    .bind(requester_for_scope)
    .bind(session_id)
    .bind(scope.as_db())
    .bind(&workspace_key)
    .bind(DEFAULT_STORAGE_BYTES_QUOTA)
    .bind(&now_text)
    .bind(&expires_at)
    .fetch_one(pool)
    .await?;

    Ok(CloudAgentSandbox {
        sandbox_id: row.0,
        workspace_key: row.1,
        scope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_sessions_are_requester_isolated_and_group_sessions_are_shared() {
        assert_eq!(
            sandbox_scope_for_session("session:direct-person:a:b"),
            SandboxScope::RequesterIsolated
        );
        assert_eq!(
            sandbox_scope_for_session("session:group:abc"),
            SandboxScope::SharedSession
        );
        assert_eq!(
            sandbox_scope_for_session("project:/tmp/demo"),
            SandboxScope::SharedSession
        );
    }

    #[test]
    fn workspace_key_hash_hides_raw_identifiers() {
        let raw = raw_workspace_key(
            "session:direct-person:a:b",
            "acct_owner",
            "acct_requester",
            SandboxScope::RequesterIsolated,
        );
        let hashed = hashed_workspace_key(&raw);

        assert!(hashed.starts_with("sandbox_"));
        assert!(!hashed.contains("acct_owner"));
        assert!(!hashed.contains("acct_requester"));
        assert_ne!(raw, hashed);
    }

    #[test]
    fn quota_decision_fails_closed_for_invalid_or_over_quota_values() {
        assert!(quota_allows_write(10, 20, 10));
        assert!(!quota_allows_write(10, 20, 11));
        assert!(!quota_allows_write(-1, 20, 1));
        assert!(!quota_allows_write(1, -20, 1));
        assert!(!quota_allows_write(1, 20, -1));
        assert!(!quota_allows_write(i64::MAX, i64::MAX, 1));
    }
}
