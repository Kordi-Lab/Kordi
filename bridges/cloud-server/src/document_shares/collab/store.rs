//! Persistence for collaboration rooms: the compacted state, the appended
//! updates, the init grant, and the stale-revision flag.

use chrono::{Duration, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::tickets::{grants_init, InitState, INIT_GRANT_SECONDS};

/// A room as stored: the compacted state up to `seq`, then later updates.
pub(crate) struct StoredRoom {
    pub state: Vec<u8>,
    pub seq: i64,
    pub initialized: bool,
    pub updates: Vec<(i64, Vec<u8>)>,
}

pub(crate) async fn ensure_room_row(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_document_collab (attachment_id) VALUES ($1) \
         ON CONFLICT (attachment_id) DO NOTHING",
    )
    .bind(attachment_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn load_room(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<StoredRoom, sqlx_core::Error> {
    ensure_room_row(pool, attachment_id).await?;
    let (state, seq, initialized): (Vec<u8>, i64, bool) = query_as(
        "SELECT state, seq, initialized_at IS NOT NULL FROM cloud_document_collab \
         WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .fetch_one(pool)
    .await?;
    let updates: Vec<(i64, Vec<u8>)> = query_as(
        "SELECT seq, update FROM cloud_document_collab_updates \
         WHERE attachment_id = $1 AND seq > $2 ORDER BY seq ASC",
    )
    .bind(attachment_id)
    .bind(seq)
    .fetch_all(pool)
    .await?;
    Ok(StoredRoom {
        state,
        seq,
        initialized,
        updates,
    })
}

pub(crate) async fn append_update(
    pool: &PgPool,
    attachment_id: &str,
    seq: i64,
    update: &[u8],
) -> Result<(), sqlx_core::Error> {
    query("INSERT INTO cloud_document_collab_updates (attachment_id, seq, update) VALUES ($1, $2, $3)")
        .bind(attachment_id)
        .bind(seq)
        .bind(update)
        .execute(pool)
        .await?;
    Ok(())
}

/// The first applied update initializes the room and ends the grant.
pub(crate) async fn mark_initialized(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_document_collab \
         SET initialized_at = now(), init_granted_to = NULL, init_grant_expires_at = NULL, \
             updated_at = now() \
         WHERE attachment_id = $1 AND initialized_at IS NULL",
    )
    .bind(attachment_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Replaces the stored state with `state` (covering every update up to
/// `seq`) and deletes those updates.
pub(crate) async fn compact(
    pool: &PgPool,
    attachment_id: &str,
    state: &[u8],
    state_vector: &[u8],
    seq: i64,
) -> Result<(), sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    query(
        "UPDATE cloud_document_collab \
         SET state = $2, state_vector = $3, seq = GREATEST(seq, $4), updated_at = now() \
         WHERE attachment_id = $1",
    )
    .bind(attachment_id)
    .bind(state)
    .bind(state_vector)
    .bind(seq)
    .execute(&mut *tx)
    .await?;
    query("DELETE FROM cloud_document_collab_updates WHERE attachment_id = $1 AND seq <= $2")
        .bind(attachment_id)
        .bind(seq)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// Compare-and-set for the init grant (see [`grants_init`]). A new grant
/// lasts [`INIT_GRANT_SECONDS`]; the holder asking again keeps its expiry.
pub(crate) async fn take_init_grant(
    pool: &PgPool,
    attachment_id: &str,
    caller: &str,
) -> Result<bool, sqlx_core::Error> {
    ensure_room_row(pool, attachment_id).await?;
    let mut tx = pool.begin().await?;
    let (initialized, granted_to, grant_expires_at): (
        bool,
        Option<String>,
        Option<chrono::DateTime<Utc>>,
    ) = query_as(
        "SELECT initialized_at IS NOT NULL, init_granted_to, init_grant_expires_at \
             FROM cloud_document_collab WHERE attachment_id = $1 FOR UPDATE",
    )
    .bind(attachment_id)
    .fetch_one(&mut *tx)
    .await?;
    let state = InitState {
        initialized,
        granted_to,
        grant_expires_at,
    };
    let now = Utc::now();
    if !grants_init(&state, caller, now) {
        tx.rollback().await?;
        return Ok(false);
    }
    if state.granted_to.as_deref() != Some(caller)
        || state.grant_expires_at.is_none_or(|expires| expires <= now)
    {
        query(
            "UPDATE cloud_document_collab SET init_granted_to = $2, init_grant_expires_at = $3 \
             WHERE attachment_id = $1",
        )
        .bind(attachment_id)
        .bind(caller)
        .bind(now + Duration::seconds(INIT_GRANT_SECONDS))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// Marks an initialized room stale after a revisioned save.
pub(crate) async fn mark_stale(pool: &PgPool, attachment_id: &str) -> Result<(), sqlx_core::Error> {
    query(
        "UPDATE cloud_document_collab SET stale_revision = TRUE \
         WHERE attachment_id = $1 AND initialized_at IS NOT NULL",
    )
    .bind(attachment_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Reads and clears the stale flag, so exactly one editor reconciles.
pub(crate) async fn take_stale_flag(
    pool: &PgPool,
    attachment_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let row: Option<(bool,)> = query_as(
        "UPDATE cloud_document_collab SET stale_revision = FALSE \
         WHERE attachment_id = $1 AND stale_revision RETURNING TRUE",
    )
    .bind(attachment_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}
