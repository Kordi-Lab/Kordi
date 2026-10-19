//! Queueing match and room-theme runs, and storing what they find.

use std::collections::HashMap;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::prompt::{self, MATCH_SYSTEM, ROOM_SYSTEM};
use super::{result, MatchResult, SharedCard};
use crate::common_ground::runs::{self, NewRun, MATCH_PREFIX, ROOM_PREFIX};

/// People matched by one run; larger rooms fill in over several runs.
pub(super) const MATCH_BATCH: usize = 20;
/// Members whose topics a room-theme run reads, in join order.
pub(super) const MAX_THEME_MEMBERS: usize = 60;

/// A run blocks another of its kind while it is open, and for two minutes
/// after it failed, so a failing provider is not called on every refresh.
const BLOCKING_RUN_SQL: &str = "created_at > now() - interval '15 minutes'
    AND (finished_at IS NULL OR (error_code IS NOT NULL AND finished_at > now() - interval '2 minutes'))";

/// Stored results for `viewer` that are still valid for both current cards.
pub(super) async fn fresh_results(
    pool: &PgPool,
    viewer: &SharedCard,
    others: &[SharedCard],
) -> sqlx_core::Result<HashMap<String, MatchResult>> {
    let ids: Vec<&str> = others.iter().map(|o| o.account_id.as_str()).collect();
    let rows: Vec<(String, i64, i64, Value)> = query_as(
        "SELECT other_account_id, viewer_revision, other_revision, result_json
         FROM cloud_common_ground_matches
         WHERE viewer_account_id = $1 AND other_account_id = ANY($2)",
    )
    .bind(&viewer.account_id)
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    let revisions: HashMap<&str, i64> = others
        .iter()
        .map(|o| (o.account_id.as_str(), o.revision))
        .collect();
    Ok(rows
        .into_iter()
        .filter(|(other, viewer_revision, other_revision, _)| {
            *viewer_revision == viewer.revision
                && revisions.get(other.as_str()) == Some(other_revision)
        })
        .filter_map(|(other, _, _, value)| Some((other, serde_json::from_value(value).ok()?)))
        .collect())
}

/// How queued work for a viewer or room stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Pending {
    /// A run is working (or was just queued).
    Running,
    /// The last run failed moments ago; the next request retries.
    Failed,
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
/// unless one is already working for this viewer.
pub(super) async fn queue_matches(
    pool: &PgPool,
    service: &crate::pip::PipConfig,
    viewer: &SharedCard,
    stale: &[SharedCard],
    room_id: Option<Uuid>,
) -> sqlx_core::Result<Pending> {
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-match:' || $1))")
        .bind(&viewer.account_id)
        .execute(&mut *tx)
        .await?;
    if let Some(pending) = blocking_run(pool, "viewer_account_id", &viewer.account_id).await? {
        return Ok(pending);
    }
    let batch = &stale[..stale.len().min(MATCH_BATCH)];
    let run_id = runs::new_run_id(MATCH_PREFIX);
    let cards: Vec<&SharedCard> = std::iter::once(viewer).chain(batch).collect();
    query(
        "INSERT INTO cloud_common_ground_match_runs (run_id, kind, viewer_account_id, room_id, cards_json)
         VALUES ($1, 'match', $2, $3, $4)",
    )
    .bind(&run_id)
    .bind(&viewer.account_id)
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
    Ok(Pending::Running)
}

/// Identifies a room's member set and card revisions.
pub(super) fn members_key(members: &[SharedCard]) -> String {
    let mut parts: Vec<String> = members
        .iter()
        .map(|m| format!("{}:{}", m.account_id, m.revision))
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

pub(super) async fn queue_themes(
    pool: &PgPool,
    service: &crate::pip::PipConfig,
    room_id: Uuid,
    requester: &str,
    members: &[SharedCard],
) -> sqlx_core::Result<Pending> {
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-room:' || $1))")
        .bind(room_id.to_string())
        .execute(&mut *tx)
        .await?;
    if let Some(pending) = blocking_run(pool, "room_id", &room_id.to_string()).await? {
        return Ok(pending);
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
    Ok(Pending::Running)
}

type RunRow = (String, Option<String>, Option<Uuid>, Value);

/// Stores what a finished match or room run found. A reply that is not the
/// expected JSON fails the run instead.
pub(in crate::common_ground) async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    let row: Option<RunRow> = query_as(
        "SELECT kind, viewer_account_id, room_id, cards_json FROM cloud_common_ground_match_runs
         WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((kind, viewer, room_id, cards)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let cards: Vec<SharedCard> = serde_json::from_value(cards).unwrap_or_default();
    let current = current_revisions(pool, &cards).await?;
    let is_current = |card: &SharedCard| current.get(&card.account_id) == Some(&card.revision);
    let mut tx = pool.begin().await?;
    if !runs::mark_completed(&mut tx, run_id, runner_id).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    if kind == "match" {
        let (Some(viewer_card), others) = (cards.first(), cards.get(1..).unwrap_or_default())
        else {
            return Err(sqlx_core::Error::RowNotFound);
        };
        let Some(found) = prompt::parse_matches(text, viewer_card, others) else {
            drop(tx);
            eprintln!("[common-ground] Rejected run {run_id}: the reply is not a match list");
            return fail(pool, run_id, Some(runner_id), "invalid_output").await;
        };
        // Cards that changed while the run worked are matched again later.
        if is_current(viewer_card) {
            for (other, found) in others.iter().zip(found) {
                if !is_current(other) {
                    continue;
                }
                query(
                    "INSERT INTO cloud_common_ground_matches
                         (viewer_account_id, other_account_id, viewer_revision, other_revision, result_json)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (viewer_account_id, other_account_id) DO UPDATE SET
                         viewer_revision = EXCLUDED.viewer_revision, other_revision = EXCLUDED.other_revision,
                         result_json = EXCLUDED.result_json, computed_at = now()",
                )
                .bind(&viewer_card.account_id)
                .bind(&other.account_id)
                .bind(viewer_card.revision)
                .bind(other.revision)
                .bind(json!(result(viewer_card, other, found)))
                .execute(&mut *tx)
                .await?;
            }
        }
        if let Some(viewer) = &viewer {
            crate::common_ground::hint(&mut tx, viewer, "common_ground.matches.updated", json!({}))
                .await?;
        }
    } else if let Some(room_id) = room_id {
        let Some(themes) = prompt::parse_themes(text, cards.len()) else {
            drop(tx);
            eprintln!("[common-ground] Rejected run {run_id}: the reply is not a theme list");
            return fail(pool, run_id, Some(runner_id), "invalid_output").await;
        };
        let themes: Vec<(String, Vec<String>)> = themes
            .into_iter()
            .map(|(label, people)| {
                (
                    label,
                    people
                        .into_iter()
                        .map(|i| cards[i].account_id.clone())
                        .collect(),
                )
            })
            .collect();
        if cards.iter().all(is_current) {
            query(
                "INSERT INTO cloud_common_ground_room_themes (room_id, members_key, themes_json)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (room_id) DO UPDATE SET members_key = EXCLUDED.members_key,
                     themes_json = EXCLUDED.themes_json, computed_at = now()",
            )
            .bind(room_id)
            .bind(members_key(&cards))
            .bind(json!(themes))
            .execute(&mut *tx)
            .await?;
        }
        notify_room(&mut tx, room_id).await?;
    }
    finish(&mut tx, run_id, None).await?;
    tx.commit().await
}

pub(in crate::common_ground) async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    runs::mark_failed(&mut tx, run_id, runner_id, code, "Matching failed.").await?;
    let row: Option<(Option<String>, Option<Uuid>)> = query_as(
        "SELECT viewer_account_id, room_id FROM cloud_common_ground_match_runs WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    finish(&mut tx, run_id, Some(code)).await?;
    match row {
        Some((Some(viewer), _)) => {
            crate::common_ground::hint(
                &mut tx,
                &viewer,
                "common_ground.matches.updated",
                json!({}),
            )
            .await?;
        }
        Some((None, Some(room_id))) => notify_room(&mut tx, room_id).await?,
        _ => {}
    }
    tx.commit().await
}

/// Marks the run finished and drops the cards it read: other people's
/// topics are not kept with a finished run.
async fn finish(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    run_id: &str,
    error_code: Option<&str>,
) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_match_runs SET finished_at = now(), error_code = $2, cards_json = '[]'::jsonb
         WHERE run_id = $1",
    )
    .bind(run_id)
    .bind(error_code)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn notify_room(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    room_id: Uuid,
) -> sqlx_core::Result<()> {
    let members: Vec<(String, String)> = query_as(
        "SELECT member.account_id, room.code FROM cloud_common_ground_room_members member
         JOIN cloud_common_ground_rooms room ON room.room_id = member.room_id
         WHERE member.room_id = $1 AND member.left_at IS NULL",
    )
    .bind(room_id)
    .fetch_all(&mut **tx)
    .await?;
    for (account, code) in members {
        crate::common_ground::hint(
            tx,
            &account,
            "common_ground.room.updated",
            json!({ "code": code }),
        )
        .await?;
    }
    Ok(())
}

/// Current revisions of the cards that are still shared.
async fn current_revisions(
    pool: &PgPool,
    cards: &[SharedCard],
) -> sqlx_core::Result<HashMap<String, i64>> {
    let ids: Vec<&str> = cards.iter().map(|c| c.account_id.as_str()).collect();
    let rows: Vec<(String, i64)> = query_as(
        "SELECT account_id, revision FROM cloud_common_ground_cards
         WHERE account_id = ANY($1) AND built_at IS NOT NULL AND sharing_enabled",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}
