//! Card choices of one memory (#2035): a memory may feed several Grounding
//! cards. Its cards are the ones its category routes to, minus the cards the
//! person removed it from, plus the cards the person added it to. Both
//! choices are rows of `cloud_account_memory_card_overrides`.

use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::routing::{self, routed_card_sql, routed_to_kind};
use super::{MemoryError, MemoryResult};

type Transaction<'a> = sqlx_core::transaction::Transaction<'a, Postgres>;

/// One of the owner's profiles named in an edit.
#[derive(Debug, Clone)]
pub(super) struct Card {
    pub profile_id: String,
    pub kind: String,
}

/// The card changes of one edit, checked against the owner's profiles.
#[derive(Debug, Default)]
pub(super) struct CardEdit {
    /// `Some(Some(card))` makes `card` the only card; `Some(None)` clears
    /// every choice.
    pub legacy: Option<Option<Card>>,
    pub add: Option<Card>,
    pub remove: Option<Card>,
}

impl CardEdit {
    pub(super) fn is_empty(&self) -> bool {
        self.legacy.is_none() && self.add.is_none() && self.remove.is_none()
    }
}

/// The owner's profile `profile_id`; another account's profile is not found.
pub(super) async fn owned_card(pool: &PgPool, owner: &str, profile_id: &str) -> MemoryResult<Card> {
    let row: Option<(String, String)> = query_as(
        "SELECT profile_id, kind FROM cloud_common_ground_profiles \
         WHERE profile_id = $1 AND account_id = $2",
    )
    .bind(profile_id.trim())
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    row.map(|(profile_id, kind)| Card { profile_id, kind })
        .ok_or_else(routing::profile_not_found)
}

/// The stored choice for one card: `Some(true)` added, `Some(false)` removed.
async fn choice(
    tx: &mut Transaction<'_>,
    memory_id: &str,
    card: &Card,
) -> MemoryResult<Option<bool>> {
    let row: Option<(bool,)> = query_as(
        "SELECT included FROM cloud_account_memory_card_overrides \
         WHERE memory_id = $1 AND profile_id = $2",
    )
    .bind(memory_id)
    .bind(&card.profile_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|(included,)| included))
}

async fn set_choice(
    tx: &mut Transaction<'_>,
    memory_id: &str,
    card: &Card,
    included: Option<bool>,
) -> MemoryResult<()> {
    match included {
        Some(included) => query(
            "INSERT INTO cloud_account_memory_card_overrides (memory_id, profile_id, included) \
             VALUES ($1, $2, $3) ON CONFLICT (memory_id, profile_id) \
             DO UPDATE SET included = EXCLUDED.included",
        )
        .bind(memory_id)
        .bind(&card.profile_id)
        .bind(included),
        None => query(
            "DELETE FROM cloud_account_memory_card_overrides \
             WHERE memory_id = $1 AND profile_id = $2",
        )
        .bind(memory_id)
        .bind(&card.profile_id),
    }
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Makes `card` the memory's only card, as the legacy `profileId` did: one
/// added row plus a removed row for every other card the category routes
/// to. `None` clears every choice, so the category decides again.
async fn replace(
    tx: &mut Transaction<'_>,
    owner: &str,
    memory_id: &str,
    category: &str,
    card: Option<&Card>,
) -> MemoryResult<()> {
    query("DELETE FROM cloud_account_memory_card_overrides WHERE memory_id = $1")
        .bind(memory_id)
        .execute(&mut **tx)
        .await?;
    let Some(card) = card else { return Ok(()) };
    set_choice(tx, memory_id, card, Some(true)).await?;
    query(&format!(
        "INSERT INTO cloud_account_memory_card_overrides (memory_id, profile_id, included) \
         SELECT $1, p.profile_id, FALSE FROM cloud_common_ground_profiles p \
         WHERE p.account_id = $2 AND p.profile_id <> $3 AND {}",
        routed_card_sql("$4", "p.kind")
    ))
    .bind(memory_id)
    .bind(owner)
    .bind(&card.profile_id)
    .bind(category)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Adds the memory to `card`: undoes a removal, else adds it unless the
/// category already routes it there.
async fn add(
    tx: &mut Transaction<'_>,
    memory_id: &str,
    category: &str,
    card: &Card,
) -> MemoryResult<()> {
    match choice(tx, memory_id, card).await? {
        Some(false) => set_choice(tx, memory_id, card, None).await,
        Some(true) => Ok(()),
        None if routed_to_kind(category, &card.kind) => Ok(()),
        None => set_choice(tx, memory_id, card, Some(true)).await,
    }
}

/// Removes the memory from `card`: a card the category routes to gets a
/// removed row, an added card loses its row. A card the memory is not on is
/// not found.
async fn remove(
    tx: &mut Transaction<'_>,
    memory_id: &str,
    category: &str,
    card: &Card,
) -> MemoryResult<()> {
    let routed = routed_to_kind(category, &card.kind);
    match choice(tx, memory_id, card).await? {
        Some(true) if routed => set_choice(tx, memory_id, card, Some(false)).await,
        Some(true) => set_choice(tx, memory_id, card, None).await,
        None if routed => set_choice(tx, memory_id, card, Some(false)).await,
        _ => Err(routing::memory_profile_not_found()),
    }
}

/// Applies the card changes of an edit inside its transaction, in order:
/// the legacy replacement, then the addition, then the removal. `category`
/// is the memory's category after the edit.
pub(super) async fn apply(
    tx: &mut Transaction<'_>,
    owner: &str,
    memory_id: &str,
    category: &str,
    edit: &CardEdit,
) -> MemoryResult<()> {
    if let Some(card) = &edit.legacy {
        replace(tx, owner, memory_id, category, card.as_ref()).await?;
    }
    if let Some(card) = &edit.add {
        add(tx, memory_id, category, card).await?;
    }
    if let Some(card) = &edit.remove {
        remove(tx, memory_id, category, card).await?;
    }
    Ok(())
}

/// Locks the live memory row for the edit and returns its category.
pub(super) async fn lock_category(
    tx: &mut Transaction<'_>,
    memory_id: &str,
) -> MemoryResult<String> {
    let row: Option<(String,)> = query_as(
        "SELECT category FROM cloud_account_memories \
         WHERE memory_id = $1 AND archived_at IS NULL FOR UPDATE",
    )
    .bind(memory_id)
    .fetch_optional(&mut **tx)
    .await?;
    row.map(|(category,)| category)
        .ok_or_else(MemoryError::not_found)
}

/// SQL for the legacy `profile_id` column of memory `$1`: the one added
/// card when there is exactly one, else null.
pub(super) const LEGACY_PIN_SQL: &str =
    "(SELECT CASE WHEN COUNT(*) = 1 THEN MIN(o.profile_id) END \
     FROM cloud_account_memory_card_overrides o WHERE o.memory_id = $1 AND o.included)";
