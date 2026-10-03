//! Blocking another account.
//!
//! A block is private to the blocker and never notifies the blocked
//! account. While it exists in either direction the two cannot be contacts,
//! send each other contact requests, see each other's presence, or use each
//! other's agents. Unblocking does not restore a removed contact.

use super::*;
use crate::chat_sync::store::{append_user_sync_events_in_transaction, StoreError};
use crate::relationships::{delete_contact_pair, is_service_account, lock_pair};

type BlockedAccountRow = (String, i64, Option<String>, Option<String>, DateTime<Utc>);

fn blocked_summary(row: BlockedAccountRow) -> BlockedAccountSummary {
    BlockedAccountSummary {
        account_id: row.0,
        kordi_id: row.1.to_string(),
        display_name: row.2,
        avatar_url: row.3,
        blocked_at: row.4.to_rfc3339(),
    }
}

fn database_error(message: &'static str) -> Response {
    err("server_error", message, StatusCode::INTERNAL_SERVER_ERROR)
}

/// `GET /v1/cloud/blocks` — the caller's blocks, newest first.
pub(super) async fn list_blocks(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let rows: Result<Vec<BlockedAccountRow>, _> = query_as(
        "SELECT account.account_id, account.public_account_number, account.display_name, \
                account.avatar_url, block.created_at \
         FROM cloud_account_blocks block \
         JOIN cloud_accounts account ON account.account_id = block.blocked_account_id \
         WHERE block.blocker_account_id = $1 \
         ORDER BY block.created_at DESC, account.account_id ASC",
    )
    .bind(&session.account_id)
    .fetch_all(state.db_pool())
    .await;
    match rows {
        Ok(rows) => Json(BlockListResponse {
            blocks: rows.into_iter().map(blocked_summary).collect(),
        })
        .into_response(),
        Err(_) => database_error("Could not load blocked accounts."),
    }
}

/// `PUT /v1/cloud/blocks/:account_id` — block an account. Idempotent.
pub(super) async fn block_account(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(account_id): axum::extract::Path<String>,
) -> Response {
    let target = account_id.trim().to_string();
    if target.is_empty() {
        return err(
            "invalid_account_id",
            "A valid account id is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    if target == session.account_id {
        return err(
            "self_block",
            "You can't block yourself.",
            StatusCode::BAD_REQUEST,
        );
    }
    match is_service_account(&state, &target).await {
        Ok(false) => {}
        Ok(true) => {
            return err(
                "cannot_block_service",
                "Kordi service accounts can't be blocked.",
                StatusCode::BAD_REQUEST,
            );
        }
        Err(_) => return database_error("Could not block the account."),
    }
    let pool = state.db_pool();
    let exists: Option<(i32,)> =
        match query_as("SELECT 1 FROM cloud_accounts WHERE account_id = $1")
            .bind(&target)
            .fetch_optional(pool)
            .await
        {
            Ok(value) => value,
            Err(_) => return database_error("Could not block the account."),
        };
    if exists.is_none() {
        return err(
            "account_missing",
            "No account found with that id.",
            StatusCode::NOT_FOUND,
        );
    }

    let (block, removed_contact, newly_blocked) =
        match record_block(pool, &session.account_id, &target).await {
            Ok(value) => value,
            Err(_) => return database_error("Could not block the account."),
        };
    if newly_blocked {
        let _ = write_audit(
            pool,
            Some(&session.account_id),
            Some(&session.device_id),
            "account.blocked",
            serde_json::json!({ "peer": target, "removed_contact": removed_contact }),
        )
        .await;
        if let Err(error) =
            crate::calls::end_direct_calls_between(pool, &session.account_id, &target).await
        {
            eprintln!("[blocks] end direct calls after block: {error:?}");
        }
    }
    Json(BlockResponse {
        block,
        removed_contact,
    })
    .into_response()
}

/// Writes the block and its consequences in one transaction under the pair
/// lock: both contact rows go, a pending request from the blocked account is
/// rejected, and the blocker's own pending request is withdrawn. Nothing is
/// sent to the blocked account. Returns the block, whether a contact
/// relationship ended, and whether the block is new.
async fn record_block(
    pool: &PgPool,
    blocker: &str,
    blocked: &str,
) -> Result<(BlockedAccountSummary, bool, bool), StoreError> {
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
    let removed_contact = delete_contact_pair(&mut tx, blocker, blocked).await?;
    query(
        "UPDATE cloud_contact_requests \
         SET status = CASE WHEN from_account_id = $2 THEN 'rejected' ELSE 'withdrawn' END, \
             decided_at = $3 \
         WHERE status = 'pending' \
           AND ((from_account_id = $1 AND to_account_id = $2) \
             OR (from_account_id = $2 AND to_account_id = $1))",
    )
    .bind(blocker)
    .bind(blocked)
    .bind(Utc::now().to_rfc3339())
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
    let row: BlockedAccountRow = query_as(
        "SELECT account.account_id, account.public_account_number, account.display_name, \
                account.avatar_url, block.created_at \
         FROM cloud_account_blocks block \
         JOIN cloud_accounts account ON account.account_id = block.blocked_account_id \
         WHERE block.blocker_account_id = $1 AND block.blocked_account_id = $2",
    )
    .bind(blocker)
    .bind(blocked)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((blocked_summary(row), removed_contact, newly_blocked))
}

/// `DELETE /v1/cloud/blocks/:account_id` — unblock. Idempotent; contacts are
/// not restored.
pub(super) async fn unblock_account(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(account_id): axum::extract::Path<String>,
) -> Response {
    let target = account_id.trim().to_string();
    if target.is_empty() {
        return err(
            "invalid_account_id",
            "A valid account id is required.",
            StatusCode::BAD_REQUEST,
        );
    }
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
        Err(_) => database_error("Could not unblock the account."),
    }
}

async fn remove_block(pool: &PgPool, blocker: &str, blocked: &str) -> Result<bool, StoreError> {
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
