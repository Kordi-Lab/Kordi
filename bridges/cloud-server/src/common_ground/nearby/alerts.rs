//! Queueing alerts for a dirty account X: for every Y that X sees through
//! nearby, in both directions (X about Y, Y about X), a request alert when a
//! current verdict meets one of the recipient's active requests, and a match
//! alert when the stored match reaches the recipient's alert score. Missing
//! verdicts and matches are queued as runs; their completion marks the
//! recipient dirty again.

use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::distance::{band, within, MAX_RANGE_M};
use super::participation::{self, Present};
use super::{checks, needs, settings};
use crate::auth::rate_limit::CloudRateLimiter;
use crate::common_ground::matching::{self, SharedCard};

/// Dirty accounts one claim takes.
const CLAIM_BATCH: i64 = 20;
/// People around a claimed account that one sweep looks at.
const MAX_AROUND: i64 = 200;

/// What the sweep needs to queue runs.
pub(super) struct Queueing<'a> {
    pub pool: &'a PgPool,
    pub service: &'a crate::system_agent::SystemAgentConfig,
    pub rate_limiter: &'a CloudRateLimiter,
}

/// Claims up to [`CLAIM_BATCH`] dirty accounts and clears their mark.
pub(super) async fn claim(pool: &PgPool) -> sqlx_core::Result<Vec<String>> {
    let rows: Vec<(String,)> = query_as(
        "UPDATE cloud_common_ground_nearby SET dirty_at = NULL
         WHERE account_id IN (
             SELECT account_id FROM cloud_common_ground_nearby
             WHERE dirty_at IS NOT NULL ORDER BY dirty_at
             LIMIT $1 FOR UPDATE SKIP LOCKED)
         RETURNING account_id",
    )
    .bind(CLAIM_BATCH)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(account,)| account).collect())
}

/// Queues what account X's presence calls for, both ways.
pub(super) async fn queue_for(ctx: &Queueing<'_>, account: &str) -> sqlx_core::Result<()> {
    let Some(me) = participation::present(ctx.pool, account).await? else {
        return Ok(());
    };
    let others = participation::around(ctx.pool, &me, MAX_RANGE_M, MAX_AROUND).await?;
    if others.is_empty() {
        return Ok(());
    }
    recipient(ctx, &me, &others).await?;
    for other in &others {
        let mut back = me.clone();
        back.distance_m = other.distance_m;
        recipient(ctx, other, std::slice::from_ref(&back)).await?;
    }
    Ok(())
}

/// Alerts for `recipient` about each of `others` (distances set).
async fn recipient(
    ctx: &Queueing<'_>,
    recipient: &Present,
    others: &[Present],
) -> sqlx_core::Result<()> {
    let pool = ctx.pool;
    let settings = settings::load(pool, &recipient.account_id, false).await?;
    if settings.alert_requests {
        let needs = needs::active(pool, &recipient.account_id).await?;
        let refs: Vec<&Present> = others.iter().collect();
        let verdicts = checks::current(pool, &needs, &refs).await?;
        for need in &needs {
            let mut missing = Vec::new();
            for other in others.iter().filter(|o| within(o.distance_m, need.range_m)) {
                match verdicts.get(&(need.need_id.clone(), other.profile_id.clone())) {
                    Some(checked) if checked.met() => {
                        let alert = Alert::need(recipient, other, &need.need_id, need.revision);
                        insert(pool, &alert).await?;
                    }
                    Some(_) => {}
                    None => missing.push(other),
                }
            }
            checks::queue(pool, ctx.service, ctx.rate_limiter, need, &missing).await?;
        }
    }
    if settings.alert_matches {
        let in_range: Vec<&Present> = others
            .iter()
            .filter(|o| within(o.distance_m, settings.range_m))
            .collect();
        let mine = recipient.shared_card();
        let cards: Vec<SharedCard> = in_range.iter().map(|o| o.shared_card()).collect();
        let fresh = matching::fresh_results(pool, &mine, &cards).await?;
        let mut missing = Vec::new();
        for (other, card) in in_range.into_iter().zip(cards) {
            match fresh.get(&other.profile_id) {
                Some(result) if result.score >= i64::from(settings.alert_match_min_score) => {
                    insert(pool, &Alert::matched(recipient, other, result.score)).await?;
                }
                Some(_) => {}
                None => missing.push(card),
            }
        }
        if !missing.is_empty() {
            let pip = ctx.service;
            matching::queue_matches(pool, pip, ctx.rate_limiter, &mine, &missing, None).await?;
        }
    }
    Ok(())
}

/// An alert about to be queued.
struct Alert<'a> {
    recipient: &'a str,
    other: &'a str,
    other_profile: &'a str,
    need: Option<(&'a str, i64)>,
    score: Option<i64>,
    distance_max_m: i32,
}

impl<'a> Alert<'a> {
    fn base(recipient: &'a Present, other: &'a Present) -> Self {
        Alert {
            recipient: &recipient.account_id,
            other: &other.account_id,
            other_profile: &other.profile_id,
            need: None,
            score: None,
            distance_max_m: band(other.distance_m).map_or(MAX_RANGE_M, |(_, max)| max),
        }
    }

    fn need(recipient: &'a Present, other: &'a Present, need_id: &'a str, revision: i64) -> Self {
        Alert {
            need: Some((need_id, revision)),
            ..Self::base(recipient, other)
        }
    }

    fn matched(recipient: &'a Present, other: &'a Present, score: i64) -> Self {
        Alert {
            score: Some(score),
            ..Self::base(recipient, other)
        }
    }
}

/// Serializes alert writes and deliveries for one recipient.
pub(super) async fn lock_recipient(
    tx: &mut Transaction<'_, Postgres>,
    recipient: &str,
) -> sqlx_core::Result<()> {
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-nearby-alerts:' || $1))")
        .bind(recipient)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Queues the alert unless one like it exists: a request alert once per
/// request revision; a match alert at most once a week per pair, and not
/// within a day of a request alert about the same person. Invalidated
/// alerts never reached anyone and do not count.
async fn insert(pool: &PgPool, alert: &Alert<'_>) -> sqlx_core::Result<()> {
    let mut tx = pool.begin().await?;
    lock_recipient(&mut tx, alert.recipient).await?;
    let id = format!("cgna_{}", Uuid::new_v4().simple());
    match alert.need {
        Some((need_id, revision)) => {
            query(
                "INSERT INTO cloud_common_ground_nearby_alerts
                     (alert_id, recipient_account_id, other_account_id, other_profile_id, kind,
                      need_id, need_revision, distance_max_m)
                 VALUES ($1, $2, $3, $4, 'need', $5, $6, $7)
                 ON CONFLICT (recipient_account_id, other_account_id, need_id, need_revision)
                     WHERE kind = 'need' AND status <> 'invalidated'
                 DO NOTHING",
            )
            .bind(&id)
            .bind(alert.recipient)
            .bind(alert.other)
            .bind(alert.other_profile)
            .bind(need_id)
            .bind(revision)
            .bind(alert.distance_max_m)
            .execute(&mut *tx)
            .await?;
        }
        None => {
            query(
                "INSERT INTO cloud_common_ground_nearby_alerts
                     (alert_id, recipient_account_id, other_account_id, other_profile_id, kind,
                      score, distance_max_m)
                 SELECT $1, $2, $3, $4, 'match', $5, $6
                 WHERE NOT EXISTS (
                     SELECT 1 FROM cloud_common_ground_nearby_alerts
                     WHERE recipient_account_id = $2 AND other_account_id = $3
                       AND status <> 'invalidated'
                       AND ((kind = 'match' AND created_at > now() - interval '7 days')
                         OR (kind = 'need' AND created_at > now() - interval '24 hours')))",
            )
            .bind(&id)
            .bind(alert.recipient)
            .bind(alert.other)
            .bind(alert.other_profile)
            .bind(alert.score.map(|score| score as i32))
            .bind(alert.distance_max_m)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await
}
