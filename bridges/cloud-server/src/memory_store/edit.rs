//! Editing and deleting one memory (#1710).

use axum::http::StatusCode;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::groups::{authorize_change, Change};
use super::{
    guard_settings, guard_text, memory_from_row, protected_texts_for_scope, scope_lock_key,
    settings, MemoryError, MemoryResponse, MemoryResult, MemoryRow, MEMORY_SELECT,
};

fn memory_exists() -> MemoryError {
    MemoryError::new(
        StatusCode::CONFLICT,
        "memory_exists",
        "This scope already has a memory with this text.",
    )
}

/// Replaces a memory's text. The new text passes the same guard as a save,
/// and may not repeat another live memory in the same scope (any member's,
/// for a group).
pub(crate) async fn update_text(
    pool: &PgPool,
    account_id: &str,
    memory_id: &str,
    text: &str,
) -> MemoryResult<MemoryResponse> {
    let (owner, scope, scope_id) =
        authorize_change(pool, account_id, memory_id, Change::Edit).await?;
    let settings = guard_settings(settings(pool, account_id).await?, &scope);
    let protected = protected_texts_for_scope(pool, account_id, &scope, &scope_id).await?;
    let text = guard_text(text, settings, &protected)?;

    let mut transaction = pool.begin().await?;
    // The same lock as saves, so an edit and a save of one text cannot race.
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(scope_lock_key(&owner, &scope, &scope_id))
        .execute(&mut *transaction)
        .await?;
    let (duplicate,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_account_memories \
         WHERE memory_id <> $1 AND (owner_account_id = $2 OR scope = 'group') \
           AND scope = $3 AND scope_id = $4 AND text = $5 AND archived_at IS NULL)",
    )
    .bind(memory_id)
    .bind(&owner)
    .bind(&scope)
    .bind(&scope_id)
    .bind(&text)
    .fetch_one(&mut *transaction)
    .await?;
    if duplicate {
        return Err(memory_exists());
    }
    let row: Option<MemoryRow> = query_as(&format!(
        "WITH m AS (UPDATE cloud_account_memories SET text = $2, updated_at = now() \
         WHERE memory_id = $1 AND archived_at IS NULL \
         RETURNING *) {MEMORY_SELECT}"
    ))
    .bind(memory_id)
    .bind(&text)
    .fetch_optional(&mut *transaction)
    .await?;
    transaction.commit().await?;
    row.map(memory_from_row).ok_or_else(MemoryError::not_found)
}

/// Archives one memory.
pub(crate) async fn archive(pool: &PgPool, account_id: &str, memory_id: &str) -> MemoryResult<()> {
    authorize_change(pool, account_id, memory_id, Change::Delete).await?;
    let result = query(
        "UPDATE cloud_account_memories SET archived_at = now(), updated_at = now() \
         WHERE memory_id = $1 AND archived_at IS NULL",
    )
    .bind(memory_id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(MemoryError::not_found());
    }
    Ok(())
}
