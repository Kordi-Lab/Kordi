//! Editing and deleting one memory (#1710).

use axum::http::StatusCode;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::groups::{authorize_change, Change};
use super::routing::{self, USER_DECLARED};
use super::{
    guard_settings, guard_text, memory_from_row, protected_texts_for_scope, scope_lock_key,
    settings, MemoryError, MemoryResponse, MemoryResult, MemoryRow, UpdateMemoryRequest,
    MEMORY_SELECT,
};

fn memory_exists() -> MemoryError {
    MemoryError::new(
        StatusCode::CONFLICT,
        "memory_exists",
        "This scope already has a memory with this text.",
    )
}

/// Changes a memory's text, category, or chosen profile. New text passes the
/// same guard as a save and may not repeat another live memory in the same
/// scope (any member's, for a group); a person's edit makes the memory
/// user-declared. Group memories keep to the shared categories and cannot be
/// filed to a profile; a chosen profile must be one of the owner's.
pub(crate) async fn update_memory(
    pool: &PgPool,
    account_id: &str,
    memory_id: &str,
    input: &UpdateMemoryRequest,
) -> MemoryResult<MemoryResponse> {
    if input.text.is_none() && input.category.is_none() && input.profile_id.is_none() {
        return Err(routing::invalid_update());
    }
    let (owner, scope, scope_id) =
        authorize_change(pool, account_id, memory_id, Change::Edit).await?;
    let category = match input.category.as_deref() {
        Some(category) => Some(routing::check_category(Some(category), false)?),
        None => None,
    };
    if scope == "group" {
        if category.is_some_and(|category| !routing::category_allowed_in_group(category)) {
            return Err(routing::category_not_shared());
        }
        if input.profile_id.is_some() {
            return Err(routing::profile_not_allowed());
        }
    }
    let profile_id = match &input.profile_id {
        Some(Some(id)) => Some(Some(owned_profile(pool, &owner, id).await?)),
        Some(None) => Some(None),
        None => None,
    };
    let text = match input.text.as_deref() {
        Some(text) => {
            let settings = guard_settings(settings(pool, account_id).await?, &scope);
            let protected = protected_texts_for_scope(pool, account_id, &scope, &scope_id).await?;
            Some(guard_text(text, settings, &protected)?)
        }
        None => None,
    };

    let mut transaction = pool.begin().await?;
    if let Some(text) = &text {
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
        .bind(text)
        .fetch_one(&mut *transaction)
        .await?;
        if duplicate {
            return Err(memory_exists());
        }
    }
    // A text edit is the person's own words, so it carries no confidence.
    let row: Option<MemoryRow> = query_as(&format!(
        "WITH m AS (UPDATE cloud_account_memories SET \
           text = COALESCE($2, text), \
           declaration_type = CASE WHEN $2 IS NULL THEN declaration_type ELSE '{USER_DECLARED}' END, \
           confidence = CASE WHEN $2 IS NULL THEN confidence ELSE NULL END, \
           category = COALESCE($3, category), \
           profile_id = CASE WHEN $4 THEN $5 ELSE profile_id END, \
           updated_at = now() \
         WHERE memory_id = $1 AND archived_at IS NULL \
         RETURNING *) {MEMORY_SELECT}"
    ))
    .bind(memory_id)
    .bind(text)
    .bind(category)
    .bind(profile_id.is_some())
    .bind(profile_id.flatten())
    .fetch_optional(&mut *transaction)
    .await?;
    transaction.commit().await?;
    row.map(memory_from_row).ok_or_else(MemoryError::not_found)
}

/// The id of the owner's profile `profile_id`; another account's profile is
/// not found.
async fn owned_profile(pool: &PgPool, owner: &str, profile_id: &str) -> MemoryResult<String> {
    let row: Option<(String,)> = query_as(
        "SELECT profile_id FROM cloud_common_ground_profiles \
         WHERE profile_id = $1 AND account_id = $2",
    )
    .bind(profile_id.trim())
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    row.map(|(id,)| id).ok_or_else(routing::profile_not_found)
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
