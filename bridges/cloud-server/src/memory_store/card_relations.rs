//! Memories a card build relates to its card (#2069). A build is offered the
//! owner's other memories as candidates; the ids the run picks are added to
//! the card with the same write as `addProfileId`. A card the person removed
//! a memory from never gets it back this way.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::cards::{self, Card, CardEdit, LEGACY_PIN_SQL};
use super::profile_routing::{routed_categories, ProfileTarget};
use super::routing::routed_to_kind;
use super::MemoryResult;

type Transaction<'a> = sqlx_core::transaction::Transaction<'a, Postgres>;

/// A memory a card build may relate to its card.
#[derive(Debug, Clone)]
pub(crate) struct CandidateMemory {
    pub memory_id: String,
    pub text: String,
    pub category: String,
}

/// The owner's live memories outside groups that are not on the card and
/// were never removed from it, newest first. Health memories are never
/// offered.
pub(crate) async fn card_candidates(
    pool: &PgPool,
    account_id: &str,
    target: ProfileTarget<'_>,
    limit: i64,
) -> sqlx_core::Result<Vec<CandidateMemory>> {
    let rows: Vec<(String, String, String)> = query_as(
        "SELECT mem.memory_id, mem.text, mem.category FROM cloud_account_memories mem \
         WHERE mem.archived_at IS NULL AND mem.owner_account_id = $1 \
           AND mem.scope IN ('global', 'conversation', 'project') \
           AND mem.category <> 'health_context' AND NOT (mem.category = ANY($3)) \
           AND NOT EXISTS (SELECT 1 FROM cloud_account_memory_card_overrides o \
             WHERE o.memory_id = mem.memory_id AND o.profile_id = $2) \
         ORDER BY mem.updated_at DESC, mem.memory_id LIMIT $4",
    )
    .bind(account_id)
    .bind(target.profile_id)
    .bind(routed_categories(target.kind))
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(memory_id, text, category)| CandidateMemory {
            memory_id,
            text,
            category,
        })
        .collect())
}

/// Adds each memory in `memory_ids` to the owner's card `profile_id` when it
/// is still a live memory of the owner outside groups with no choice for
/// this card and not already on it through its category. Each addition
/// touches the memory's `updated_at` and keeps the legacy `profile_id`
/// column, as an edit does. Returns how many memories were added.
pub(crate) async fn relate_to_card(
    tx: &mut Transaction<'_>,
    owner: &str,
    profile_id: &str,
    memory_ids: &[String],
) -> MemoryResult<usize> {
    let kind: Option<(String,)> = query_as(
        "SELECT kind FROM cloud_common_ground_profiles WHERE profile_id = $1 AND account_id = $2",
    )
    .bind(profile_id)
    .bind(owner)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((kind,)) = kind else { return Ok(0) };
    let card = Card {
        profile_id: profile_id.to_owned(),
        kind,
    };
    let mut added = 0;
    for memory_id in memory_ids {
        let row: Option<(String, bool)> = query_as(
            "SELECT mem.category, EXISTS (SELECT 1 FROM cloud_account_memory_card_overrides o \
               WHERE o.memory_id = mem.memory_id AND o.profile_id = $3) \
             FROM cloud_account_memories mem \
             WHERE mem.memory_id = $1 AND mem.owner_account_id = $2 \
               AND mem.archived_at IS NULL AND mem.scope <> 'group' FOR UPDATE",
        )
        .bind(memory_id)
        .bind(owner)
        .bind(&card.profile_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some((category, has_choice)) = row else {
            continue;
        };
        if has_choice || routed_to_kind(&category, &card.kind) {
            continue;
        }
        let edit = CardEdit {
            add: Some(card.clone()),
            ..CardEdit::default()
        };
        cards::apply(tx, owner, memory_id, &category, &edit).await?;
        query(&format!(
            "UPDATE cloud_account_memories SET profile_id = {LEGACY_PIN_SQL}, updated_at = now() \
             WHERE memory_id = $1"
        ))
        .bind(memory_id)
        .execute(&mut **tx)
        .await?;
        added += 1;
    }
    Ok(added)
}
