//! Queueing match and room-theme runs, and reading what they stored. Match
//! results are kept per pair of profiles.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::prompt::{self, MATCH_SYSTEM, ROOM_SYSTEM};
use super::{MatchResult, SharedCard};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::common_ground::runs::{self, NewRun, MATCH_PREFIX, ROOM_PREFIX};
use crate::common_ground::MATCH_LIMIT;

/// People matched by one run; larger rooms fill in over several runs.
pub(super) const MATCH_BATCH: usize = 8;
/// Members whose topics a room-theme run reads, in join order.
pub(super) const MAX_THEME_MEMBERS: usize = 60;

/// A run blocks another of its kind while it is open, and for two minutes
/// after it failed, so a failing provider is not called on every refresh.
const BLOCKING_RUN_SQL: &str = "created_at > now() - interval '15 minutes'
    AND (finished_at IS NULL OR (error_code IS NOT NULL AND finished_at > now() - interval '2 minutes'))";

/// Stored results for `viewer`, keyed by the other profile, that are still
/// valid for both current cards.
pub(in crate::common_ground) async fn fresh_results(
    pool: &PgPool,
    viewer: &SharedCard,
    others: &[SharedCard],
) -> sqlx_core::Result<HashMap<String, MatchResult>> {
    load_results(pool, viewer, others, true).await
}

/// The last stored result for `viewer` with each of `others`, whatever card
/// revisions it was computed from. A closed room shows these as they were.
pub(in crate::common_ground) async fn stored_results(
    pool: &PgPool,
    viewer: &SharedCard,
    others: &[SharedCard],
) -> sqlx_core::Result<HashMap<String, MatchResult>> {
    load_results(pool, viewer, others, false).await
}

async fn load_results(
    pool: &PgPool,
    viewer: &SharedCard,
    others: &[SharedCard],
    current_only: bool,
) -> sqlx_core::Result<HashMap<String, MatchResult>> {
    let ids: Vec<&str> = others.iter().map(|o| o.profile_id.as_str()).collect();
    let rows: Vec<(String, i64, i64, Value)> = query_as(
        "SELECT other_profile_id, viewer_revision, other_revision, result_json
         FROM cloud_common_ground_matches
         WHERE viewer_profile_id = $1 AND other_profile_id = ANY($2)",
    )
    .bind(&viewer.profile_id)
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let revisions: HashMap<&str, i64> = others
        .iter()
        .map(|o| (o.profile_id.as_str(), o.revision))
        .collect();
    Ok(rows
        .into_iter()
        .filter(|(other, viewer_revision, other_revision, _)| {
            !current_only
                || (*viewer_revision == viewer.revision
                    && revisions.get(other.as_str()) == Some(other_revision))
        })
        .filter_map(|(other, _, _, value)| Some((other, serde_json::from_value(value).ok()?)))
        .collect())
}

/// How queued work for a viewer or room stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::common_ground) enum Pending {
    /// A run is working (or was just queued).
    Running,
    /// The last run failed moments ago; the next request retries.
    Failed,
}

/// What asking for a run did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::common_ground) enum Queued {
    /// A run is working or paused after a failure; nothing was charged.
    Pending(Pending),
    /// A new run would exceed the matching budget; nothing was queued.
    Limited(Duration),
}

/// Charges the matching budget for one run about to be queued. Only called
/// once no open or paused run blocks a new one, so polling is free.
async fn charge(rate_limiter: &CloudRateLimiter, account: &str) -> Option<Duration> {
    match rate_limiter
        .observe_account_limit(MATCH_LIMIT, account)
        .await
    {
        RateLimitDecision::Allowed => None,
        RateLimitDecision::Limited { retry_after } => Some(retry_after),
    }
}

async fn blocking_run(
    pool: &PgPool,
    column: &str,
    key: &str,
) -> sqlx_core::Result<Option<Pending>> {
    let sql = format!(
        "SELECT error_code IS NOT NULL FROM cloud_common_ground_match_runs
         WHERE kind = $2 AND {column} = $1 AND {BLOCKING_RUN_SQL} ORDER BY created_at DESC LIMIT 1"
    );
    let row: Option<(bool,)> = if column == "room_id" {
        let room: Uuid = key.parse().map_err(|_| sqlx_core::Error::RowNotFound)?;
        query_as(&sql)
            .bind(room)
            .bind("room")
            .fetch_optional(pool)
            .await?
    } else {
        query_as(&sql)
            .bind(key)
            .bind("match")
            .fetch_optional(pool)
            .await?
    };
    Ok(row.map(|(failed,)| {
        if failed {
            Pending::Failed
        } else {
            Pending::Running
        }
    }))
}

/// Queues a run matching `viewer` with up to [`MATCH_BATCH`] of `stale`,
/// unless one is already working for this viewer profile. Only a queued run is
/// charged to the viewer's matching budget.
pub(in crate::common_ground) async fn queue_matches(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    viewer: &SharedCard,
    stale: &[SharedCard],
    room_id: Option<Uuid>,
) -> sqlx_core::Result<Queued> {
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-match:' || $1))")
        .bind(&viewer.profile_id)
        .execute(&mut *tx)
        .await?;
    if let Some(pending) = blocking_run(pool, "viewer_profile_id", &viewer.profile_id).await? {
        return Ok(Queued::Pending(pending));
    }
    if let Some(retry_after) = charge(rate_limiter, &viewer.account_id).await {
        return Ok(Queued::Limited(retry_after));
    }
    let batch = &stale[..stale.len().min(MATCH_BATCH)];
    let run_id = runs::new_run_id(MATCH_PREFIX);
    let cards: Vec<&SharedCard> = std::iter::once(viewer).chain(batch).collect();
    query(
        "INSERT INTO cloud_common_ground_match_runs
             (run_id, kind, viewer_account_id, viewer_profile_id, room_id, cards_json)
         VALUES ($1, 'match', $2, $3, $4, $5)",
    )
    .bind(&run_id)
    .bind(&viewer.account_id)
    .bind(&viewer.profile_id)
    .bind(room_id)
    .bind(json!(cards))
    .execute(&mut *tx)
    .await?;
    let new_run = NewRun {
        run_id: &run_id,
        requester: &viewer.account_id,
        prompt: prompt::match_prompt(viewer, batch),
        system_prompt: MATCH_SYSTEM,
    };
    runs::insert(&mut tx, service, new_run).await?;
    tx.commit().await?;
    Ok(Queued::Pending(Pending::Running))
}

/// Identifies a room's member set, shared profiles and card revisions.
pub(super) fn members_key(members: &[SharedCard]) -> String {
    let mut parts: Vec<String> = members
        .iter()
        .map(|m| format!("{}:{}:{}", m.account_id, m.profile_id, m.revision))
        .collect();
    parts.sort();
    hex::encode(Sha256::digest(parts.join(",").as_bytes()))
}

/// Themes as (label, account ids) when they match the current members.
pub(super) async fn stored_themes(
    pool: &PgPool,
    room_id: Uuid,
    key: &str,
) -> sqlx_core::Result<Option<Vec<(String, Vec<String>)>>> {
    let row: Option<(Value,)> = query_as(
        "SELECT themes_json FROM cloud_common_ground_room_themes WHERE room_id = $1 AND members_key = $2",
    )
    .bind(room_id)
    .bind(key)
    .fetch_optional(pool)
    .await?;
    Ok(row.and_then(|(value,)| serde_json::from_value(value).ok()))
}

/// The room's last stored themes, whatever member set they were computed
/// for. A closed room shows these as they were.
pub(super) async fn latest_themes(
    pool: &PgPool,
    room_id: Uuid,
) -> sqlx_core::Result<Option<Vec<(String, Vec<String>)>>> {
    let row: Option<(Value,)> =
        query_as("SELECT themes_json FROM cloud_common_ground_room_themes WHERE room_id = $1")
            .bind(room_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(value,)| serde_json::from_value(value).ok()))
}

/// Queues a room-theme run unless one is already working for this room.
/// The run is charged to `requester`'s matching budget.
pub(super) async fn queue_themes(
    pool: &PgPool,
    service: &crate::system_agent::SystemAgentConfig,
    rate_limiter: &CloudRateLimiter,
    room_id: Uuid,
    requester: &str,
    members: &[SharedCard],
) -> sqlx_core::Result<Queued> {
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-room:' || $1))")
        .bind(room_id.to_string())
        .execute(&mut *tx)
        .await?;
    if let Some(pending) = blocking_run(pool, "room_id", &room_id.to_string()).await? {
        return Ok(Queued::Pending(pending));
    }
    if let Some(retry_after) = charge(rate_limiter, requester).await {
        return Ok(Queued::Limited(retry_after));
    }
    let run_id = runs::new_run_id(ROOM_PREFIX);
    query(
        "INSERT INTO cloud_common_ground_match_runs (run_id, kind, room_id, cards_json)
         VALUES ($1, 'room', $2, $3)",
    )
    .bind(&run_id)
    .bind(room_id)
    .bind(json!(members))
    .execute(&mut *tx)
    .await?;
    let new_run = NewRun {
        run_id: &run_id,
        requester,
        prompt: prompt::room_prompt(members),
        system_prompt: ROOM_SYSTEM,
    };
    runs::insert(&mut tx, service, new_run).await?;
    tx.commit().await?;
    Ok(Queued::Pending(Pending::Running))
}
