//! Storing what a finished match or room-theme run found, and failing runs.

use std::collections::HashMap;

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::store::members_key;
use super::{prompt, result, SharedCard};
use crate::common_ground::runs;

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
    let is_current = |card: &SharedCard| current.get(&card.profile_id) == Some(&card.revision);
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
                         (viewer_account_id, other_account_id, viewer_profile_id, other_profile_id,
                          viewer_revision, other_revision, result_json)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (viewer_profile_id, other_profile_id) DO UPDATE SET
                         viewer_revision = EXCLUDED.viewer_revision, other_revision = EXCLUDED.other_revision,
                         result_json = EXCLUDED.result_json, computed_at = now()",
                )
                .bind(&viewer_card.account_id)
                .bind(&other.account_id)
                .bind(&viewer_card.profile_id)
                .bind(&other.profile_id)
                .bind(viewer_card.revision)
                .bind(other.revision)
                .bind(json!(result(viewer_card, other, found)))
                .execute(&mut *tx)
                .await?;
            }
        }
        if let Some(viewer) = &viewer {
            let payload = json!({ "profileId": viewer_card.profile_id });
            crate::common_ground::hint(&mut tx, viewer, "common_ground.matches.updated", payload)
                .await?;
            crate::common_ground::nearby::run_finished(&mut tx, viewer).await?;
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
    if !finish(&mut tx, run_id, None).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    tx.commit().await
}

pub(in crate::common_ground) async fn fail(
    pool: &PgPool,
    run_id: &str,
    runner_id: Option<&str>,
    code: &str,
) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    // A runner that lost its lease, or a repeated report, changes nothing.
    if !runs::mark_failed(&mut tx, run_id, runner_id, code, "Matching failed.").await? {
        return Ok(());
    }
    let row: Option<(Option<String>, Option<Uuid>)> = query_as(
        "SELECT viewer_account_id, room_id FROM cloud_common_ground_match_runs WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    if !finish(&mut tx, run_id, Some(code)).await? {
        return Ok(());
    }
    match row {
        Some((Some(viewer), _)) => {
            crate::common_ground::hint(
                &mut tx,
                &viewer,
                "common_ground.matches.updated",
                json!({}),
            )
            .await?;
            crate::common_ground::nearby::run_finished(&mut tx, &viewer).await?;
        }
        Some((None, Some(room_id))) => notify_room(&mut tx, room_id).await?,
        _ => {}
    }
    tx.commit().await
}

/// Marks an open run finished and drops the cards it read: other people's
/// topics are not kept with a finished run. Returns false when the run was
/// already finished.
async fn finish(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    run_id: &str,
    error_code: Option<&str>,
) -> sqlx_core::Result<bool> {
    let changed = query(
        "UPDATE cloud_common_ground_match_runs SET finished_at = now(), error_code = $2, cards_json = '[]'::jsonb
         WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .bind(error_code)
    .execute(&mut **tx)
    .await?;
    Ok(changed.rows_affected() > 0)
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

/// Current revisions of the cards that are still shared, by profile.
async fn current_revisions(
    pool: &PgPool,
    cards: &[SharedCard],
) -> sqlx_core::Result<HashMap<String, i64>> {
    let ids: Vec<&str> = cards.iter().map(|c| c.profile_id.as_str()).collect();
    let rows: Vec<(String, i64)> = query_as(
        "SELECT profile_id, revision FROM cloud_common_ground_cards
         WHERE profile_id = ANY($1) AND built_at IS NOT NULL AND sharing_enabled",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}
