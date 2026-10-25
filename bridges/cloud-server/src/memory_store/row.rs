//! The memory row every memory route returns, and the SQL that selects it.
//!
//! A memory's cards (#2035) are the owner's profiles its category routes to,
//! minus the cards the person removed it from, plus the cards the person
//! added it to (`cloud_account_memory_card_overrides`). Group memories have
//! no cards.

use std::fmt;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use sqlx_core::{from_row::FromRow, row::Row};
use sqlx_postgres::PgRow;

use super::routing::{self, routed_card_sql};
use super::MemoryResponse;

/// One memory with its owner's name, legacy pin and cards.
pub(super) struct MemoryRow {
    memory_id: String,
    scope: String,
    scope_id: String,
    scope_label: Option<String>,
    source: String,
    text: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    owner_account_id: String,
    owner_name: Option<String>,
    category: String,
    declaration_type: String,
    confidence: Option<String>,
    pin_id: Option<String>,
    pin_kind: Option<String>,
    profile_ids: Vec<String>,
    excluded_profile_ids: Vec<String>,
}

impl<'row> FromRow<'row, PgRow> for MemoryRow {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx_core::Error> {
        Ok(Self {
            memory_id: row.try_get("memory_id")?,
            scope: row.try_get("scope")?,
            scope_id: row.try_get("scope_id")?,
            scope_label: row.try_get("scope_label")?,
            source: row.try_get("source")?,
            text: row.try_get("text")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            owner_account_id: row.try_get("owner_account_id")?,
            owner_name: row.try_get("owner_name")?,
            category: row.try_get("category")?,
            declaration_type: row.try_get("declaration_type")?,
            confidence: row.try_get("confidence")?,
            pin_id: row.try_get("pin_id")?,
            pin_kind: row.try_get("pin_kind")?,
            profile_ids: row.try_get("profile_ids")?,
            excluded_profile_ids: row.try_get("excluded_profile_ids")?,
        })
    }
}

/// Selects memory rows from a CTE named `m` (a query or a `RETURNING *`
/// write) with the owner's display name, the legacy pin (the one included
/// card when there is exactly one) and its kind, and the memory's effective
/// and excluded cards in profile order. Formats as SQL.
pub(super) struct MemorySelect;

pub(super) static MEMORY_SELECT: MemorySelect = MemorySelect;

static MEMORY_SELECT_SQL: LazyLock<String> = LazyLock::new(|| {
    let routed = routed_card_sql("m.category", "p.kind");
    format!(
        "SELECT m.memory_id, m.scope, m.scope_id, m.scope_label, m.source, \
         m.text, m.created_at, m.updated_at, m.owner_account_id, \
         NULLIF(btrim(owner.display_name), '') AS owner_name, \
         m.category, m.declaration_type, m.confidence, \
         pin.profile_id AS pin_id, profile.kind AS pin_kind, \
         cards.profile_ids, cards.excluded_profile_ids \
         FROM m LEFT JOIN cloud_accounts owner ON owner.account_id = m.owner_account_id \
         LEFT JOIN LATERAL (SELECT MIN(o.profile_id) AS profile_id \
           FROM cloud_account_memory_card_overrides o \
           WHERE o.memory_id = m.memory_id AND o.included HAVING COUNT(*) = 1) pin ON TRUE \
         LEFT JOIN cloud_common_ground_profiles profile ON profile.profile_id = pin.profile_id \
         CROSS JOIN LATERAL (SELECT \
           COALESCE(array_agg(p.profile_id ORDER BY p.position, p.profile_id) \
             FILTER (WHERE o.included OR (o.included IS NULL AND {routed})), \
             ARRAY[]::text[]) AS profile_ids, \
           COALESCE(array_agg(p.profile_id ORDER BY p.position, p.profile_id) \
             FILTER (WHERE NOT o.included), ARRAY[]::text[]) AS excluded_profile_ids \
           FROM cloud_common_ground_profiles p \
           LEFT JOIN cloud_account_memory_card_overrides o \
             ON o.memory_id = m.memory_id AND o.profile_id = p.profile_id \
           WHERE p.account_id = m.owner_account_id AND m.scope <> 'group') cards"
    )
});

impl fmt::Display for MemorySelect {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&MEMORY_SELECT_SQL)
    }
}

pub(super) fn memory_from_row(row: MemoryRow) -> MemoryResponse {
    let profile_kind = routing::effective_profile_kind(&row.scope, &row.category, row.pin_kind);
    MemoryResponse {
        memory_id: row.memory_id,
        scope: row.scope,
        scope_id: row.scope_id,
        scope_label: row.scope_label,
        source: row.source,
        text: row.text,
        created_at: row.created_at.to_rfc3339(),
        updated_at: row.updated_at.to_rfc3339(),
        owner_account_id: row.owner_account_id,
        owner_name: row.owner_name,
        category: row.category,
        declaration_type: row.declaration_type,
        confidence: row.confidence,
        profile_id: row.pin_id,
        profile_kind,
        profile_ids: row.profile_ids,
        excluded_profile_ids: row.excluded_profile_ids,
    }
}
