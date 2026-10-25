//! Account memory storage shared by the signed-in account routes and the
//! cloud runner routes (#1710).
//!
//! Memories belong to the account that saved them, except that `group`
//! memories are shared by the group's active members (see `groups`). Every save and edit runs the shared guard
//! from `kordi_tools::memory_guard`, so the Mac and the server reject the same
//! text. Deleting archives a row; archived rows are never returned or read by
//! agents, and every row is removed with the account through `ON DELETE
//! CASCADE`.

use axum::http::StatusCode;
use kordi_tools::memory_guard::{check_memory_text, MemoryGuardOptions};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

mod card_relations;
mod cards;
mod edit;
mod groups;
mod profile_routing;
mod routing;
mod row;
mod runs;
mod types;

pub(crate) use card_relations::{card_candidates, relate_to_card, CandidateMemory};
pub(crate) use edit::{archive, update_memory};
use row::{memory_from_row, MemoryRow, MEMORY_SELECT};

pub(crate) use groups::is_active_group_member;
pub(crate) use profile_routing::{build_memories, count_since, profile_memories, ProfileTarget};
pub(crate) use routing::{category_allowed_in_group, check_category, MEMORY_CONFIDENCES};
pub(crate) use runs::{
    clear_omp_state, leased_run, omp_state_count, write_memory_audit, LeasedRun,
};
pub(crate) use types::{
    MemoryEnvelope, MemoryError, MemoryListResponse, MemoryResponse, MemoryResult,
    MemorySettingsResponse, SaveMemoryRequest, SaveOutcome, UpdateMemoryRequest,
    UpdateMemorySettingsRequest,
};

pub(crate) const MEMORY_SCOPES: [&str; 4] = ["global", "conversation", "group", "project"];
/// The only scope id a `global` memory may use: global memories belong to the
/// whole account.
pub(crate) const GLOBAL_SCOPE_ID: &str = "account";
/// `digest` marks memories a digest run saved from recent conversations
/// (#2053); `import` marks memories the Mac imported from the person's
/// instruction files (#2054).
pub(crate) const MEMORY_SOURCES: [&str; 6] = [
    "user_correction",
    "repeated_failure",
    "outcome",
    "manual",
    "digest",
    "import",
];
const MAX_SCOPE_ID_CHARS: usize = 256;
const MAX_SCOPE_LABEL_CHARS: usize = 256;
const MAX_CLIENT_MEMORY_ID_CHARS: usize = 128;

/// Texts the opt-out quote guard protects for this account and scope.
///
/// Hook for #1687: once members can turn off AI use, this returns their
/// message texts in the scope so a memory cannot quote them. Until then no
/// text is protected.
pub(crate) async fn protected_texts_for_scope(
    _pool: &PgPool,
    _account_id: &str,
    _scope: &str,
    _scope_id: &str,
) -> MemoryResult<Vec<String>> {
    Ok(Vec::new())
}

/// Guard settings for a write into `scope`. Group memories are shared, so
/// they are always checked with the sensitive filter on, whatever the
/// writer's own setting.
fn guard_settings(mut settings: MemorySettingsResponse, scope: &str) -> MemorySettingsResponse {
    if scope == "group" {
        settings.exclude_sensitive = true;
    }
    settings
}

/// Advisory lock key that serializes writes of one scope's texts. A group's
/// memories are shared, so its writes share one lock.
fn scope_lock_key(owner_account_id: &str, scope: &str, scope_id: &str) -> String {
    if scope == "group" {
        format!("memory:group:{scope_id}")
    } else {
        format!("memory:{owner_account_id}:{scope}:{scope_id}")
    }
}

fn guard_text(
    text: &str,
    settings: MemorySettingsResponse,
    protected_texts: &[String],
) -> MemoryResult<String> {
    check_memory_text(
        text,
        &MemoryGuardOptions {
            exclude_sensitive: settings.exclude_sensitive,
            protected_texts,
        },
    )
    .map_err(|error| {
        MemoryError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "memory_rejected",
            error.to_string(),
        )
    })
}

pub(crate) async fn settings(
    pool: &PgPool,
    account_id: &str,
) -> MemoryResult<MemorySettingsResponse> {
    let row: Option<(bool, bool)> = query_as(
        "SELECT memory_enabled, exclude_sensitive FROM cloud_account_memory_settings WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .map(
            |(memory_enabled, exclude_sensitive)| MemorySettingsResponse {
                memory_enabled,
                exclude_sensitive,
            },
        )
        .unwrap_or_default())
}

pub(crate) async fn update_settings(
    pool: &PgPool,
    account_id: &str,
    input: &UpdateMemorySettingsRequest,
) -> MemoryResult<MemorySettingsResponse> {
    let (memory_enabled, exclude_sensitive): (bool, bool) = query_as(
        "INSERT INTO cloud_account_memory_settings (account_id, memory_enabled, exclude_sensitive, updated_at) \
         VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), now()) \
         ON CONFLICT (account_id) DO UPDATE SET \
           memory_enabled = COALESCE($2, cloud_account_memory_settings.memory_enabled), \
           exclude_sensitive = COALESCE($3, cloud_account_memory_settings.exclude_sensitive), \
           updated_at = now() \
         RETURNING memory_enabled, exclude_sensitive",
    )
    .bind(account_id)
    .bind(input.memory_enabled)
    .bind(input.exclude_sensitive)
    .fetch_one(pool)
    .await?;
    Ok(MemorySettingsResponse {
        memory_enabled,
        exclude_sensitive,
    })
}

/// The account's own memories plus the group memories of every group the
/// account is an active member of, whoever saved them.
pub(crate) async fn list(pool: &PgPool, account_id: &str) -> MemoryResult<MemoryListResponse> {
    // Two branches, each served by an index: the owner's rows, and the rows
    // of the account's groups by scope id. UNION removes the overlap.
    let rows: Vec<MemoryRow> = query_as(&format!(
        "WITH m AS ( \
           SELECT * FROM cloud_account_memories \
           WHERE archived_at IS NULL AND owner_account_id = $1 \
           UNION \
           SELECT * FROM cloud_account_memories \
           WHERE archived_at IS NULL AND scope = 'group' AND scope_id IN ({})) \
         {MEMORY_SELECT} ORDER BY m.updated_at DESC, m.memory_id",
        groups::active_group_ids("$1")
    ))
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    Ok(MemoryListResponse {
        memories: rows.into_iter().map(memory_from_row).collect(),
        settings: settings(pool, account_id).await?,
    })
}

fn valid_client_memory_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CLIENT_MEMORY_ID_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(crate) async fn save(
    pool: &PgPool,
    account_id: &str,
    input: &SaveMemoryRequest,
) -> MemoryResult<SaveOutcome> {
    let scope = input.scope.trim();
    if !MEMORY_SCOPES.contains(&scope) {
        return Err(MemoryError::bad_request(
            "invalid_scope",
            "scope must be global, conversation, group, or project.",
        ));
    }
    let source = input.source.trim();
    if !MEMORY_SOURCES.contains(&source) {
        return Err(MemoryError::bad_request(
            "invalid_source",
            "source must be user_correction, repeated_failure, outcome, manual, digest, or import.",
        ));
    }
    let mut scope_id = input.scope_id.trim().to_owned();
    if scope_id.is_empty() || scope_id.chars().count() > MAX_SCOPE_ID_CHARS {
        return Err(MemoryError::bad_request(
            "invalid_scope_id",
            "scopeId is required and must be 256 characters or fewer.",
        ));
    }
    if scope == "global" && scope_id != GLOBAL_SCOPE_ID {
        return Err(MemoryError::bad_request(
            "invalid_scope_id",
            "scopeId must be account for global memories.",
        ));
    }
    // Global memories have no label: they apply to the whole account.
    let scope_label = input
        .scope_label
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty() && scope != "global");
    if scope_label.is_some_and(|label| label.chars().count() > MAX_SCOPE_LABEL_CHARS) {
        return Err(MemoryError::bad_request(
            "invalid_scope_label",
            "scopeLabel must be 256 characters or fewer.",
        ));
    }
    let fields = routing::save_fields(input, scope)?;
    let client_memory_id = input.client_memory_id.as_deref().map(str::trim);
    if client_memory_id.is_some_and(|id| !valid_client_memory_id(id)) {
        return Err(MemoryError::bad_request(
            "invalid_client_memory_id",
            "clientMemoryId must be 1 to 128 letters, digits, hyphens, or underscores.",
        ));
    }

    // Group memories are shared, so only a member may add one. The id is
    // stored in its canonical form so every member's list matches it.
    if scope == "group" {
        if !is_active_group_member(pool, account_id, &scope_id).await? {
            return Err(MemoryError::not_a_group_member());
        }
        scope_id = uuid::Uuid::parse_str(&scope_id)
            .map(|id| id.to_string())
            .unwrap_or(scope_id);
    }
    let scope_id = scope_id.as_str();

    let settings = settings(pool, account_id).await?;
    if !settings.memory_enabled {
        return Err(MemoryError::new(
            StatusCode::CONFLICT,
            "memory_disabled",
            "Memory is off for this account.",
        ));
    }
    let protected = protected_texts_for_scope(pool, account_id, scope, scope_id).await?;
    let text = guard_text(&input.text, guard_settings(settings, scope), &protected)?;

    // A retry of an earlier save with the same clientMemoryId returns that row
    // unchanged.
    if let Some(id) = client_memory_id {
        let existing: Option<(bool,)> = query_as(
            "SELECT archived_at IS NOT NULL FROM cloud_account_memories \
             WHERE memory_id = $1 AND owner_account_id = $2",
        )
        .bind(id)
        .bind(account_id)
        .fetch_optional(pool)
        .await?;
        if let Some((archived,)) = existing {
            if archived {
                return Err(client_id_conflict());
            }
            let row: MemoryRow = query_as(&format!(
                "WITH m AS (SELECT * FROM cloud_account_memories WHERE memory_id = $1) \
                 {MEMORY_SELECT}"
            ))
            .bind(id)
            .fetch_one(pool)
            .await?;
            return Ok(SaveOutcome::Existing(memory_from_row(row)));
        }
    }

    let mut transaction = pool.begin().await?;
    // Serialize saves for one scope so two identical saves cannot both insert.
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(scope_lock_key(account_id, scope, scope_id))
        .execute(&mut *transaction)
        .await?;
    // The same text in the same scope is the same memory: touch it, fill a
    // missing label, and return it instead of saving a second row. In a group
    // this matches the memory whichever member saved it.
    let duplicate: Option<MemoryRow> = query_as(&format!(
        "WITH m AS (UPDATE cloud_account_memories \
         SET updated_at = now(), scope_label = COALESCE(scope_label, $5) \
         WHERE memory_id = ( \
           SELECT memory_id FROM cloud_account_memories \
           WHERE (owner_account_id = $1 OR scope = 'group') \
             AND scope = $2 AND scope_id = $3 AND text = $4 \
             AND archived_at IS NULL \
           ORDER BY created_at, memory_id LIMIT 1) \
         RETURNING *) {MEMORY_SELECT}"
    ))
    .bind(account_id)
    .bind(scope)
    .bind(scope_id)
    .bind(&text)
    .bind(scope_label)
    .fetch_optional(&mut *transaction)
    .await?;
    if let Some(row) = duplicate {
        transaction.commit().await?;
        return Ok(SaveOutcome::Existing(memory_from_row(row)));
    }

    let memory_id = client_memory_id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("mem_{}", uuid::Uuid::new_v4().simple()));
    let inserted: Option<MemoryRow> = query_as(&format!(
        "WITH m AS (INSERT INTO cloud_account_memories \
         (memory_id, owner_account_id, scope, scope_id, scope_label, source, text, \
          category, declaration_type, confidence) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) \
         ON CONFLICT (memory_id) DO NOTHING \
         RETURNING *) {MEMORY_SELECT}"
    ))
    .bind(&memory_id)
    .bind(account_id)
    .bind(scope)
    .bind(scope_id)
    .bind(scope_label)
    .bind(source)
    .bind(&text)
    .bind(fields.category)
    .bind(fields.declaration_type)
    .bind(fields.confidence)
    .fetch_optional(&mut *transaction)
    .await?;
    transaction.commit().await?;
    // No row means the clientMemoryId belongs to another account.
    inserted
        .map(|row| SaveOutcome::Created(memory_from_row(row)))
        .ok_or_else(client_id_conflict)
}

fn client_id_conflict() -> MemoryError {
    MemoryError::new(
        StatusCode::CONFLICT,
        "memory_id_conflict",
        "A memory with this clientMemoryId already exists.",
    )
}

/// Archives the memories the account saved. Group memories saved by other
/// members stay, since they belong to those members.
pub(crate) async fn archive_all(pool: &PgPool, account_id: &str) -> MemoryResult<u64> {
    let result = query(
        "UPDATE cloud_account_memories SET archived_at = now(), updated_at = now() \
         WHERE owner_account_id = $1 AND archived_at IS NULL",
    )
    .bind(account_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}
