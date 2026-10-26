//! Request check runs (`cg_need_`): one request revision against up to 8
//! nearby people, owned by the System agent service like matching. Verdicts
//! are stored per request and candidate profile, current only while both
//! revisions are unchanged.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::evidence::{check_prompt, parse_checks, Checked, Material, CHECK_SYSTEM};
use super::needs::Need;
use super::participation::Present;
use super::{run_finished, updated, CHECK_LIMIT, NEED_PREFIX};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::common_ground::runs::{self, NewRun};

/// People one run checks.
pub(super) const CHECK_BATCH: usize = 8;

/// A run blocks another for the same request revision while it is open,
/// and for two minutes after it failed.
const BLOCKING_SQL: &str = "need_id = $1 AND need_revision = $2
    AND created_at > now() - interval '15 minutes'
    AND (finished_at IS NULL OR failed_at > now() - interval '2 minutes')";

/// A candidate as the run saw them. Kept with the open run only.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    #[serde(rename = "ref")]
    reference: String,
    account_id: String,
    profile_id: String,
    revision: i64,
    material: Material,
}

/// Current verdicts of these requests for these people, checked again
/// against what each person shares now, keyed by (request, profile).
pub(super) async fn current(
    pool: &PgPool,
    needs: &[Need],
    people: &[&Present],
) -> sqlx_core::Result<HashMap<(String, String), Checked>> {
    if needs.is_empty() || people.is_empty() {
        return Ok(HashMap::new());
    }
    let need_ids: Vec<&str> = needs.iter().map(|n| n.need_id.as_str()).collect();
    let profile_ids: Vec<&str> = people.iter().map(|p| p.profile_id.as_str()).collect();
    let rows: Vec<(String, String, i64, i64, Value)> = query_as(
        "SELECT need_id, other_profile_id, need_revision, other_revision, checks_json
         FROM cloud_common_ground_nearby_verdicts
         WHERE need_id = ANY($1) AND other_profile_id = ANY($2)",
    )
    .bind(&need_ids)
    .bind(&profile_ids)
    .fetch_all(pool)
    .await?;
    let mut out = HashMap::new();
    for (need_id, profile_id, need_revision, other_revision, checks) in rows {
        let need = needs.iter().find(|n| n.need_id == need_id);
        let person = people.iter().find(|p| p.profile_id == profile_id);
        let (Some(need), Some(person)) = (need, person) else {
            continue;
        };
        if need.revision != need_revision || person.revision != other_revision {
            continue;
        }
        let Ok(checked) = serde_json::from_value::<Checked>(checks) else {
            continue;
        };
        out.insert(
            (need_id, profile_id),
            checked.revalidated(&person.material()),
        );
    }
    Ok(out)
}

/// Queues a check of `need` against up to [`CHECK_BATCH`] of `people`,
/// unless one is open or just failed for this revision, or the owner's
/// budget is spent. Only a queued run is charged.
pub(super) async fn queue(
    pool: &PgPool,
    service: &crate::pip::PipConfig,
    rate_limiter: &CloudRateLimiter,
    need: &Need,
    people: &[&Present],
) -> sqlx_core::Result<()> {
    if people.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-nearby-check:' || $1))")
        .bind(&need.need_id)
        .execute(&mut *tx)
        .await?;
    let blocked: Option<(i32,)> = query_as(&format!(
        "SELECT 1 FROM cloud_common_ground_nearby_need_runs WHERE {BLOCKING_SQL} LIMIT 1"
    ))
    .bind(&need.need_id)
    .bind(need.revision)
    .fetch_optional(&mut *tx)
    .await?;
    if blocked.is_some() {
        return Ok(());
    }
    if let RateLimitDecision::Limited { .. } = rate_limiter
        .observe_account_limit(CHECK_LIMIT, &need.account_id)
        .await
    {
        return Ok(());
    }
    let snapshots: Vec<Snapshot> = people
        .iter()
        .take(CHECK_BATCH)
        .enumerate()
        .map(|(index, person)| Snapshot {
            reference: format!("p{}", index + 1),
            account_id: person.account_id.clone(),
            profile_id: person.profile_id.clone(),
            revision: person.revision,
            material: person.material(),
        })
        .collect();
    let refs: Vec<(String, Material)> = snapshots
        .iter()
        .map(|s| (s.reference.clone(), s.material.clone()))
        .collect();
    let run_id = runs::new_run_id(NEED_PREFIX);
    query(
        "INSERT INTO cloud_common_ground_nearby_need_runs
             (run_id, need_id, need_revision, account_id, candidates_json)
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&run_id)
    .bind(&need.need_id)
    .bind(need.revision)
    .bind(&need.account_id)
    .bind(json!(snapshots))
    .execute(&mut *tx)
    .await?;
    let new_run = NewRun {
        run_id: &run_id,
        requester: &need.account_id,
        prompt: check_prompt(&need.text, &refs),
        system_prompt: CHECK_SYSTEM,
    };
    runs::insert(&mut tx, service, new_run).await?;
    tx.commit().await
}

/// Stores what a finished check found. A reply that is not a check fails
/// the run instead. Verdicts are kept only while the request revision and
/// each candidate's card revision are the ones the run read.
pub(in crate::common_ground) async fn complete(
    pool: &PgPool,
    run_id: &str,
    runner_id: &str,
    text: &str,
) -> sqlx_core::Result<()> {
    let row: Option<(String, i64, String, Value)> = query_as(
        "SELECT need_id, need_revision, account_id, candidates_json
         FROM cloud_common_ground_nearby_need_runs WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some((need_id, need_revision, account, snapshots)) = row else {
        return Err(sqlx_core::Error::RowNotFound);
    };
    let snapshots: Vec<Snapshot> = serde_json::from_value(snapshots).unwrap_or_default();
    let mut tx = pool.begin().await?;
    if !runs::mark_completed(&mut tx, run_id, runner_id).await? {
        return Err(sqlx_core::Error::RowNotFound);
    }
    let refs: Vec<(String, Material)> = snapshots
        .iter()
        .map(|s| (s.reference.clone(), s.material.clone()))
        .collect();
    let Some(found) = parse_checks(text, &refs) else {
        drop(tx);
        eprintln!(
            "[common-ground] Rejected run {run_id}: the reply is not a request check ({} characters)",
            text.chars().count()
        );
        return fail(pool, run_id, Some(runner_id), "invalid_output").await;
    };
    let revision: Option<(i64,)> =
        query_as("SELECT revision FROM cloud_common_ground_nearby_needs WHERE need_id = $1")
            .bind(&need_id)
            .fetch_optional(&mut *tx)
            .await?;
    if revision == Some((need_revision,)) {
        let ids: Vec<&str> = snapshots.iter().map(|s| s.profile_id.as_str()).collect();
        let cards: Vec<(String, i64)> = query_as(
            "SELECT profile_id, revision FROM cloud_common_ground_cards
             WHERE profile_id = ANY($1) AND built_at IS NOT NULL AND sharing_enabled",
        )
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
        let cards: HashMap<String, i64> = cards.into_iter().collect();
        for (snapshot, checked) in snapshots.iter().zip(found) {
            if cards.get(&snapshot.profile_id) != Some(&snapshot.revision) {
                continue;
            }
            query(
                "INSERT INTO cloud_common_ground_nearby_verdicts
                     (need_id, other_profile_id, need_revision, other_revision, met, checks_json)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (need_id, other_profile_id) DO UPDATE SET
                     need_revision = EXCLUDED.need_revision, other_revision = EXCLUDED.other_revision,
                     met = EXCLUDED.met, checks_json = EXCLUDED.checks_json, computed_at = now()",
            )
            .bind(&need_id)
            .bind(&snapshot.profile_id)
            .bind(need_revision)
            .bind(snapshot.revision)
            .bind(checked.met())
            .bind(json!(checked))
            .execute(&mut *tx)
            .await?;
        }
    }
    let finished = query(
        "UPDATE cloud_common_ground_nearby_need_runs SET finished_at = now(), candidates_json = '[]'::jsonb
         WHERE run_id = $1 AND finished_at IS NULL",
    )
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    if finished.rows_affected() == 0 {
        return Err(sqlx_core::Error::RowNotFound);
    }
    run_finished(&mut tx, &account).await?;
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
    if !runs::mark_failed(&mut tx, run_id, runner_id, code, "Request check failed.").await? {
        return Ok(());
    }
    let account: Option<(String,)> = query_as(
        "UPDATE cloud_common_ground_nearby_need_runs
         SET finished_at = now(), failed_at = now(), candidates_json = '[]'::jsonb
         WHERE run_id = $1 AND finished_at IS NULL RETURNING account_id",
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((account,)) = account {
        updated(&mut tx, &account).await?;
    }
    tx.commit().await
}
