//! Which memories reach each Grounding profile (#1977).
//!
//! A memory of the owner is routed to a profile when it is active, not a
//! group memory, and either pinned to that profile (`profile_id`) or
//! unpinned with a category whose default kind is the profile's fixed kind
//! or `all`. Custom profiles get pinned memories only. Card builds of a
//! custom profile also read the owner's unpinned memories until per-card
//! sources land (#1971).

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::routing::{profile_kind_for, MEMORY_CATEGORIES};
use super::{memory_from_row, MemoryResponse, MemoryRow, MEMORY_SELECT};

/// The most memories the profile route returns.
pub(crate) const MAX_PROFILE_MEMORIES: i64 = 500;
/// Profile kinds that receive memories by category.
const FIXED_PROFILE_KINDS: [&str; 3] = ["work", "health", "daily"];

/// The profile memories are routed to. `profile_id` is `None` while the
/// account has no profile yet (a first build creates the work profile).
#[derive(Debug, Clone, Copy)]
pub(crate) struct ProfileTarget<'a> {
    pub profile_id: Option<&'a str>,
    pub kind: &'a str,
}

/// A memory listed under a profile.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileMemory {
    #[serde(flatten)]
    pub memory: MemoryResponse,
    /// Unpinned and cross-profile: listed under every fixed-kind profile.
    pub every_profile: bool,
}

/// The categories a profile of `kind` receives without a pin: its own and
/// the cross-profile ones. None for custom profiles.
fn routed_categories(kind: &str) -> Vec<String> {
    if !FIXED_PROFILE_KINDS.contains(&kind) {
        return Vec::new();
    }
    MEMORY_CATEGORIES
        .iter()
        .filter(|category| matches!(profile_kind_for(category), Some(k) if k == kind || k == "all"))
        .map(|category| (*category).to_owned())
        .collect()
}

fn every_profile(memory: &MemoryResponse) -> bool {
    memory.profile_id.is_none() && profile_kind_for(&memory.category) == Some("all")
}

/// Rows of `cloud_account_memories` routed to a profile: `$1` owner, `$2`
/// profile id, `$3` categories received without a pin, `$4` whether every
/// unpinned memory counts, `$5` only rows updated after this time.
const ROUTED_WHERE: &str = "archived_at IS NULL AND owner_account_id = $1 AND scope <> 'group' \
     AND (profile_id = $2 OR (profile_id IS NULL AND ($4 OR category = ANY($3)))) \
     AND ($5::timestamptz IS NULL OR updated_at > $5)";

async fn select(
    pool: &PgPool,
    account_id: &str,
    target: ProfileTarget<'_>,
    any_unpinned: bool,
    limit: i64,
) -> sqlx_core::Result<Vec<MemoryResponse>> {
    let rows: Vec<MemoryRow> = query_as(&format!(
        "WITH m AS (SELECT * FROM cloud_account_memories WHERE {ROUTED_WHERE} \
           ORDER BY updated_at DESC, memory_id LIMIT $6) \
         {MEMORY_SELECT} ORDER BY m.updated_at DESC, m.memory_id"
    ))
    .bind(account_id)
    .bind(target.profile_id)
    .bind(routed_categories(target.kind))
    .bind(any_unpinned)
    .bind(None::<DateTime<Utc>>)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(memory_from_row).collect())
}

/// The owner's memories routed to the profile, newest first.
pub(crate) async fn profile_memories(
    pool: &PgPool,
    account_id: &str,
    target: ProfileTarget<'_>,
) -> sqlx_core::Result<Vec<ProfileMemory>> {
    let memories = select(pool, account_id, target, false, MAX_PROFILE_MEMORIES).await?;
    Ok(memories
        .into_iter()
        .map(|memory| ProfileMemory {
            every_profile: every_profile(&memory),
            memory,
        })
        .collect())
}

/// The memories a card build of the profile reads, newest first: the routed
/// ones, or for a custom profile its pinned memories plus every unpinned
/// one. Group memories never feed a build.
pub(crate) async fn build_memories(
    pool: &PgPool,
    account_id: &str,
    target: ProfileTarget<'_>,
    limit: usize,
) -> sqlx_core::Result<Vec<MemoryResponse>> {
    let any_unpinned = !FIXED_PROFILE_KINDS.contains(&target.kind);
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    select(pool, account_id, target, any_unpinned, limit).await
}

/// How many memories routed to the profile changed after `since`; all of
/// them when the card was never built.
pub(crate) async fn count_since(
    pool: &PgPool,
    account_id: &str,
    target: ProfileTarget<'_>,
    since: Option<DateTime<Utc>>,
) -> sqlx_core::Result<i64> {
    let (count,): (i64,) = query_as(&format!(
        "SELECT COUNT(*) FROM cloud_account_memories WHERE {ROUTED_WHERE}"
    ))
    .bind(account_id)
    .bind(target.profile_id)
    .bind(routed_categories(target.kind))
    .bind(false)
    .bind(since)
    .fetch_one(pool)
    .await?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_kinds_receive_their_categories_and_coordination() {
        assert_eq!(
            routed_categories("work"),
            [
                "education_learner_profile",
                "work_context",
                "coordination_context"
            ]
        );
        assert_eq!(
            routed_categories("health"),
            ["health_context", "coordination_context"]
        );
        assert_eq!(
            routed_categories("daily"),
            [
                "purchase_history_preferences",
                "location_context",
                "coordination_context"
            ]
        );
        assert!(routed_categories("custom").is_empty());
    }
}
