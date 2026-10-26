//! Delivering pending alerts, oldest first. Every alert is checked again
//! just before it goes out: both people still see each other through
//! nearby, the request or match still holds, and the recipient's frequency
//! caps allow it. A failed check invalidates the alert; a cap suppresses it,
//! and a suppressed alert is never sent late.

use serde_json::json;
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::alerts::lock_recipient;
use super::distance::{band, band_label, within};
use super::needs;
use super::participation::{self, Present};
use super::{checks, settings};
use crate::common_ground::matching;
use crate::notifications::{NearbyAlertPush, PushNotificationService};

/// Pending alerts one sweep delivers at most.
const DELIVERY_BATCH: i64 = 100;
/// The quiet time between two alerts to one person.
const GAP_MINUTES: i64 = 10;

type AlertRow = (String, String, String, String, Option<String>, Option<i64>);

/// What delivery decided for one alert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::common_ground) enum Outcome {
    Delivered,
    Suppressed,
    Invalidated(&'static str),
}

/// Invalidates alerts pending for more than 15 minutes.
pub(super) async fn expire(pool: &PgPool) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_nearby_alerts SET status = 'invalidated', reason = 'expired'
         WHERE status = 'pending' AND created_at < now() - interval '15 minutes'",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Delivers pending alerts, oldest first. Returns the outcomes in order.
pub(super) async fn deliver(
    pool: &PgPool,
    push: Option<&PushNotificationService>,
) -> sqlx_core::Result<Vec<(String, Outcome)>> {
    let pending: Vec<(String,)> = query_as(
        "SELECT alert_id FROM cloud_common_ground_nearby_alerts
         WHERE status = 'pending' ORDER BY created_at, alert_id LIMIT $1",
    )
    .bind(DELIVERY_BATCH)
    .fetch_all(pool)
    .await?;
    let mut outcomes = Vec::new();
    for (alert_id,) in pending {
        if let Some(outcome) = deliver_one(pool, push, &alert_id).await? {
            outcomes.push((alert_id, outcome));
        }
    }
    Ok(outcomes)
}

/// The push text when the alert still holds, or why it does not.
async fn recheck(
    pool: &PgPool,
    row: &AlertRow,
) -> sqlx_core::Result<Result<(Present, String), &'static str>> {
    let (_, recipient, other, other_profile, need_id, need_revision) = row;
    let Some((mine, them)) = participation::pair(pool, recipient, other).await? else {
        return Ok(Err("not_visible"));
    };
    if &them.profile_id != other_profile {
        return Ok(Err("profile_changed"));
    }
    let settings = settings::load(pool, recipient, false).await?;
    let label = band_label(band(them.distance_m).map_or(0, |(_, max)| max));
    if let (Some(need_id), Some(revision)) = (need_id, need_revision) {
        if !settings.alert_requests {
            return Ok(Err("alerts_off"));
        }
        let need = needs::load(pool, need_id).await?;
        let Some(need) = need.filter(|need| {
            &need.account_id == recipient
                && need.revision == *revision
                && need.status(chrono::Utc::now()) == "active"
                && within(them.distance_m, need.range_m)
        }) else {
            return Ok(Err("need_changed"));
        };
        let verdicts = checks::current(pool, std::slice::from_ref(&need), &[&them]).await?;
        if !verdicts.values().any(|checked| checked.met()) {
            return Ok(Err("verdict"));
        }
        let body = format!("{} · {label}", need.text);
        return Ok(Ok((them, body)));
    }
    if !settings.alert_matches || !within(them.distance_m, settings.range_m) {
        return Ok(Err("alerts_off"));
    }
    let fresh = matching::fresh_results(pool, &mine.shared_card(), &[them.shared_card()]).await?;
    match fresh.get(&them.profile_id) {
        Some(result) if result.score >= i64::from(settings.alert_match_min_score) => {
            let body = format!("{}% match · {label}", result.score);
            Ok(Ok((them, body)))
        }
        _ => Ok(Err("score")),
    }
}

async fn deliver_one(
    pool: &PgPool,
    push: Option<&PushNotificationService>,
    alert_id: &str,
) -> sqlx_core::Result<Option<Outcome>> {
    let mut tx = pool.begin().await?;
    let row: Option<AlertRow> = query_as(
        "SELECT alert_id, recipient_account_id, other_account_id, other_profile_id, need_id,
                need_revision
         FROM cloud_common_ground_nearby_alerts
         WHERE alert_id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED",
    )
    .bind(alert_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let recipient = row.1.clone();
    lock_recipient(&mut tx, &recipient).await?;
    let checked = recheck(pool, &row).await?;
    let (them, body) = match checked {
        Ok(found) => found,
        Err(reason) => {
            mark(&mut tx, alert_id, "invalidated", Some(reason)).await?;
            tx.commit().await?;
            return Ok(Some(Outcome::Invalidated(reason)));
        }
    };
    let max_per_day = settings::load(&mut *tx, &recipient, false)
        .await?
        .alert_max_per_day;
    let (today, recent): (i64, bool) = query_as(
        "SELECT COUNT(*), COALESCE(bool_or(delivered_at > now() - make_interval(mins => $2::int)), false)
         FROM cloud_common_ground_nearby_alerts
         WHERE recipient_account_id = $1 AND status = 'delivered'
           AND delivered_at > now() - interval '24 hours'",
    )
    .bind(&recipient)
    .bind(GAP_MINUTES as i32)
    .fetch_one(&mut *tx)
    .await?;
    if today >= i64::from(max_per_day) || recent {
        mark(&mut tx, alert_id, "suppressed", Some("limit")).await?;
        tx.commit().await?;
        return Ok(Some(Outcome::Suppressed));
    }
    mark(&mut tx, alert_id, "delivered", None).await?;
    let kind = if row.4.is_some() { "need" } else { "match" };
    let payload = json!({
        "alertId": alert_id,
        "kind": kind,
        "otherAccountId": them.account_id,
        "needId": row.4,
    });
    crate::common_ground::hint(&mut tx, &recipient, "common_ground.nearby.alert", payload).await?;
    tx.commit().await?;
    if let Some(service) = push {
        let title = format!("{} is nearby", them.name);
        let push = NearbyAlertPush {
            account_id: &recipient,
            other_account_id: &them.account_id,
            alert_id,
            title: &title,
            body: &body,
        };
        service.send_nearby_alert(pool, &push).await;
    }
    Ok(Some(Outcome::Delivered))
}

async fn mark(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    alert_id: &str,
    status: &str,
    reason: Option<&str>,
) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_nearby_alerts
         SET status = $2, reason = $3,
             delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END
         WHERE alert_id = $1",
    )
    .bind(alert_id)
    .bind(status)
    .bind(reason)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
