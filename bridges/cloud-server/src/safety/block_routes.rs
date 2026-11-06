//! `GET /v1/cloud/blocks`, `PUT /v1/cloud/blocks/:account_id`, and
//! `DELETE /v1/cloud/blocks/:account_id`.
//!
//! A block is private to the blocker and never notifies the blocked account.
//! Blocking removes the contact on both sides, rejects the blocked account's
//! pending request, deletes the blocker's own pending request, and ends
//! direct calls between the two. Unblocking does not restore the contact.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::blocks::lock_pair;
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision, BLOCK_CHANGE_LIMIT};
use crate::auth::routes::{delete_contact_pair, err, write_audit, CloudSession};
use crate::chat_sync::store::{append_user_sync_events_in_transaction, StoreError};
use crate::server::ServerState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedAccountSummary {
    pub account_id: String,
    pub kordi_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub blocked_at: String,
}

#[derive(Serialize)]
struct BlockListResponse {
    blocks: Vec<BlockedAccountSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockResponse {
    block: BlockedAccountSummary,
    removed_contact: bool,
}

type BlockedAccountRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    DateTime<Utc>,
);

const BLOCKED_ACCOUNT_COLUMNS: &str = "account.account_id, \
     COALESCE(account.public_handle, account.public_account_number::TEXT, ''), \
     account.display_name, account.avatar_url, block.created_at";

fn blocked_summary(row: BlockedAccountRow) -> BlockedAccountSummary {
    BlockedAccountSummary {
        account_id: row.0,
        kordi_id: row.1,
        display_name: row.2,
        avatar_url: row.3,
        blocked_at: row.4.to_rfc3339(),
    }
}

/// Why a block could not be recorded.
#[derive(Debug)]
pub(crate) enum BlockError {
    SelfBlock,
    ServiceAccount,
    AccountMissing,
    Database,
}

impl BlockError {
    pub(crate) fn into_response(self) -> Response {
        match self {
            Self::SelfBlock => err(
                "self_block",
                "You can't block yourself.",
                StatusCode::BAD_REQUEST,
            ),
            Self::ServiceAccount => err(
                "cannot_block_service",
                "Kordi service accounts can't be blocked.",
                StatusCode::BAD_REQUEST,
            ),
            Self::AccountMissing => err(
                "account_missing",
                "No account found with that id.",
                StatusCode::NOT_FOUND,
            ),
            Self::Database => err(
                "server_error",
                "Could not block the account.",
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        }
    }
}

impl From<sqlx_core::Error> for BlockError {
    fn from(error: sqlx_core::Error) -> Self {
        let code = error
            .as_database_error()
            .and_then(|error| error.code().map(|code| code.into_owned()));
        eprintln!("[blocks] database error (code {code:?})");
        Self::Database
    }
}

impl From<StoreError> for BlockError {
    fn from(error: StoreError) -> Self {
        eprintln!("[blocks] sync event: {error}");
        Self::Database
    }
}

/// What a block changed.
pub(crate) struct BlockOutcome {
    pub block: BlockedAccountSummary,
    pub removed_contact: bool,
}

/// Kordi service accounts: System, the System agent, Kordi Support, and any
/// account that owns a system-managed agent.
async fn is_service_account(state: &ServerState, account_id: &str) -> Result<bool, BlockError> {
    if crate::system_account::is_service_account(account_id)
        || state
            .support()
            .is_some_and(|support| support.config().owner_account_id == account_id)
    {
        return Ok(true);
    }
    let (owns,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_agent_definitions \
         WHERE owner_account_id = $1 AND is_system_managed)",
    )
    .bind(account_id)
    .fetch_one(state.db_pool())
    .await?;
    Ok(owns)
}

/// Blocks `target` for `session`'s account. Idempotent. Shared by the block
/// route and by reports sent with `alsoBlock`.
pub(crate) async fn block_account_for(
    state: &Arc<ServerState>,
    session: &CloudSession,
    target: &str,
) -> Result<BlockOutcome, BlockError> {
    let target = target.trim();
    if target == session.account_id {
        return Err(BlockError::SelfBlock);
    }
    if target.is_empty() {
        return Err(BlockError::AccountMissing);
    }
    if is_service_account(state, target).await? {
        return Err(BlockError::ServiceAccount);
    }
    let pool = state.db_pool();
    let exists: Option<(i32,)> = query_as("SELECT 1 FROM cloud_accounts WHERE account_id = $1")
        .bind(target)
        .fetch_optional(pool)
        .await?;
    if exists.is_none() {
        return Err(BlockError::AccountMissing);
    }
    let (block, removed_contact, newly_blocked) =
        record_block(pool, &session.account_id, target).await?;
    if newly_blocked {
        let _ = write_audit(
            pool,
            Some(&session.account_id),
            Some(&session.device_id),
            "account.blocked",
            serde_json::json!({ "peer": target, "removed_contact": removed_contact }),
        )
        .await;
        end_direct_calls_between(pool, &session.account_id, target).await;
    }
    if removed_contact {
        // The same live refresh a contact removal sends; nothing says why.
        let events = state.events().clone();
        let actor = session.account_id.clone();
        let peer = target.to_string();
        tokio::spawn(async move {
            events.publish_contact_removed(&actor, &peer).await;
            events.publish_contact_removed(&peer, &actor).await;
        });
    }
    Ok(BlockOutcome {
        block,
        removed_contact,
    })
}

/// Writes the block and its consequences in one transaction under the pair
/// lock. Returns the block, whether a contact row went, and whether the block
/// is new.
async fn record_block(
    pool: &PgPool,
    blocker: &str,
    blocked: &str,
) -> Result<(BlockedAccountSummary, bool, bool), BlockError> {
    let mut tx = pool.begin().await?;
    lock_pair(&mut tx, blocker, blocked).await?;
    let newly_blocked = query(
        "INSERT INTO cloud_account_blocks (blocker_account_id, blocked_account_id) \
         VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(blocker)
    .bind(blocked)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    let (mine, theirs) = delete_contact_pair(&mut tx, blocker, blocked).await?;
    let removed_contact = mine || theirs;
    query(
        "UPDATE cloud_contact_requests SET status = 'rejected', decided_at = $3 \
         WHERE status = 'pending' AND from_account_id = $2 AND to_account_id = $1",
    )
    .bind(blocker)
    .bind(blocked)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *tx)
    .await?;
    query(
        "DELETE FROM cloud_contact_requests \
         WHERE status = 'pending' AND from_account_id = $1 AND to_account_id = $2",
    )
    .bind(blocker)
    .bind(blocked)
    .execute(&mut *tx)
    .await?;
    if newly_blocked || removed_contact {
        append_user_sync_events_in_transaction(
            &mut tx,
            &[blocker.to_string()],
            "account.directory.changed",
            None,
            &serde_json::json!({ "accountId": blocked, "reason": "blocked" }),
        )
        .await?;
    }
    let row: BlockedAccountRow = query_as(&format!(
        "SELECT {BLOCKED_ACCOUNT_COLUMNS} \
         FROM cloud_account_blocks block \
         JOIN cloud_accounts account ON account.account_id = block.blocked_account_id \
         WHERE block.blocker_account_id = $1 AND block.blocked_account_id = $2"
    ))
    .bind(blocker)
    .bind(blocked)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((blocked_summary(row), removed_contact, newly_blocked))
}

/// Ends ringing or active voice and video calls in direct conversations the
/// two accounts share. Meetings in groups keep going.
async fn end_direct_calls_between(pool: &PgPool, blocker: &str, blocked: &str) {
    let calls: Result<Vec<(Uuid,)>, _> = query_as(
        "SELECT call.call_id FROM cloud_calls call \
         JOIN cloud_chat_conversations conversation \
           ON conversation.conversation_id = call.conversation_id \
         WHERE call.ended_at IS NULL AND call.call_kind <> 'meeting' \
           AND conversation.kind = 'direct' \
           AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                       WHERE member.conversation_id = conversation.conversation_id \
                         AND member.account_id = $1) \
           AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                       WHERE member.conversation_id = conversation.conversation_id \
                         AND member.account_id = $2)",
    )
    .bind(blocker)
    .bind(blocked)
    .fetch_all(pool)
    .await;
    let Ok(calls) = calls else {
        eprintln!("[blocks] could not load calls to end after a block");
        return;
    };
    for (call_id,) in calls {
        if crate::calls::end_call(pool, blocker, call_id)
            .await
            .is_err()
        {
            eprintln!("[blocks] could not end call {call_id} after a block");
        }
    }
}

/// `GET /v1/cloud/blocks`: the caller's blocks, newest first.
pub(super) async fn list_blocks(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: Result<Vec<BlockedAccountRow>, _> = query_as(&format!(
        "SELECT {BLOCKED_ACCOUNT_COLUMNS} \
         FROM cloud_account_blocks block \
         JOIN cloud_accounts account ON account.account_id = block.blocked_account_id \
         WHERE block.blocker_account_id = $1 \
         ORDER BY block.created_at DESC, account.account_id ASC"
    ))
    .bind(&session.account_id)
    .fetch_all(state.db_pool())
    .await;
    match rows {
        Ok(rows) => Json(BlockListResponse {
            blocks: rows.into_iter().map(blocked_summary).collect(),
        })
        .into_response(),
        Err(_) => err(
            "server_error",
            "Could not load blocked accounts.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

/// Charges one block or unblock to [`BLOCK_CHANGE_LIMIT`].
async fn over_budget(limiter: &CloudRateLimiter, account_id: &str) -> Option<Response> {
    match limiter
        .observe_account_limit(BLOCK_CHANGE_LIMIT, account_id)
        .await
    {
        RateLimitDecision::Limited { retry_after } => Some(super::routes::limited(
            retry_after,
            "You've changed a lot of blocks recently. Try again later.",
        )),
        RateLimitDecision::Allowed => None,
    }
}

/// `PUT /v1/cloud/blocks/:account_id`: blocks an account. Idempotent.
pub(super) async fn block_account(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Path(account_id): Path<String>,
) -> Response {
    if let Some(limited) = over_budget(&rate_limiter, &session.account_id).await {
        return limited;
    }
    match block_account_for(&state, &session, &account_id).await {
        Ok(outcome) => Json(BlockResponse {
            block: outcome.block,
            removed_contact: outcome.removed_contact,
        })
        .into_response(),
        Err(error) => error.into_response(),
    }
}

/// `DELETE /v1/cloud/blocks/:account_id`: unblocks. Idempotent; the contact
/// is not restored.
pub(super) async fn unblock_account(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Path(account_id): Path<String>,
) -> Response {
    if let Some(limited) = over_budget(&rate_limiter, &session.account_id).await {
        return limited;
    }
    let target = account_id.trim().to_string();
    let pool = state.db_pool();
    match remove_block(pool, &session.account_id, &target).await {
        Ok(true) => {
            let _ = write_audit(
                pool,
                Some(&session.account_id),
                Some(&session.device_id),
                "account.unblocked",
                serde_json::json!({ "peer": target }),
            )
            .await;
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => err(
            "server_error",
            "Could not unblock the account.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

async fn remove_block(pool: &PgPool, blocker: &str, blocked: &str) -> Result<bool, BlockError> {
    let mut tx = pool.begin().await?;
    lock_pair(&mut tx, blocker, blocked).await?;
    let removed = query(
        "DELETE FROM cloud_account_blocks \
         WHERE blocker_account_id = $1 AND blocked_account_id = $2",
    )
    .bind(blocker)
    .bind(blocked)
    .execute(&mut *tx)
    .await?
    .rows_affected()
        == 1;
    if removed {
        append_user_sync_events_in_transaction(
            &mut tx,
            &[blocker.to_string()],
            "account.directory.changed",
            None,
            &serde_json::json!({ "accountId": blocked, "reason": "unblocked" }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(removed)
}
